// GG 提示词优化qwen2.1 回归：外接 CLIP/VAE、旧存档迁移、Loader 复用与失败重试。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_prompt_optimizer_llm_split.cjs
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, 'out');
const NODE = 'GGPromptOptimizer';
const LEGACY_PROP = '_ggLegacyPromptOptimizerModelsV1';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1900, height: 1200 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1200);

  const models = await page.evaluate(async () => {
    const clipInfo = await (await fetch('/object_info/CLIPLoader')).json();
    const vaeInfo = await (await fetch('/object_info/VAELoader')).json();
    const clipReq = clipInfo.CLIPLoader.input.required;
    const vaeReq = vaeInfo.VAELoader.input.required;
    const clipChoices = clipReq.clip_name[0].filter((v) => /\.safetensors$/i.test(String(v)));
    const vaeChoices = vaeReq.vae_name[0].filter((v) => /\.safetensors$/i.test(String(v)));
    const typeChoices = (clipReq.type?.[0] || []).map(String);
    return {
      clip: clipChoices.find((v) => /qwen/i.test(v)) || clipChoices[0] || '',
      vae: vaeChoices.find((v) => /qwen/i.test(v) && /vae/i.test(v)) || vaeChoices[0] || '',
      clipType: typeChoices.includes('qwen_image') ? 'qwen_image' : (typeChoices[0] || 'qwen_image'),
    };
  });
  if (!models.clip || !models.vae) throw new Error('缺少 CLIPLoader / VAELoader 可用权重，无法构造夹具');

  const helpers = `
    const app = window.app;
    const CLIP = MODEL.clip;
    const VAE = MODEL.vae;
    const CLIP_TYPE = MODEL.clipType;
    const LEGACY_PROP = ${JSON.stringify(LEGACY_PROP)};
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const settle = async (ms = 320) => {
      await new Promise((r) => setTimeout(r, ms));
      await tick();
      await tick();
    };
    const cell = (n, name) => (n?.widgets || []).find((w) => w.name === name);
    const val = (n, name) => cell(n, name)?.value;
    const setCell = (n, name, value) => {
      const w = cell(n, name);
      if (!w) throw new Error('缺少控件 ' + name);
      w.value = value;
      w.callback?.(value);
    };
    const typeOf = (n) => n?.comfyClass || n?.type || '';
    const isOptimizer = (n) => typeOf(n) === ${JSON.stringify(NODE)};
    const findInput = (n, name) => (n?.inputs || []).find((i) => i.name === name || i.name === '图像.' + name);
    const imageInput = (n) => (n?.inputs || []).find((i) => String(i.name || '').startsWith('图像'));
    const connectTo = (source, output, target, predicate) => {
      const idx = (target.inputs || []).findIndex(predicate);
      if (idx < 0) throw new Error('找不到目标输入');
      source.connect(output, target, idx);
      return target.inputs[idx].link != null;
    };

    const inspectGraph = (label) => {
      const saved = app.graph.serialize();
      const live = app.graph._nodes || [];
      const linkMap = new Map((saved.links || []).map((l) => [l[0], l]));
      const nodeData = (saved.nodes || []).filter((n) => n.type === ${JSON.stringify(NODE)});
      const port = (target, name, sourceWidget) => {
        const input = findInput(target, name);
        const edge = input?.link == null ? null : linkMap.get(input.link);
        const source = edge ? live.find((n) => String(n.id) === String(edge[1])) : null;
        return {
          connected: !!edge,
          sourceType: typeOf(source),
          sourceId: edge?.[1] ?? null,
          model: sourceWidget ? String(val(source, sourceWidget) ?? '') : '',
          linkId: input?.link ?? null,
        };
      };
      return {
        label,
        nodes: nodeData.map((data) => {
          const target = live.find((n) => String(n.id) === String(data.id));
          return {
            id: data.id,
            values: data.widgets_values,
            widgetNames: (target?.widgets || []).map((w) => w.name),
            legacy: data.properties?.[LEGACY_PROP] || null,
            clip: port(target, 'clip', 'clip_name'),
            vae: port(target, 'vae', 'vae_name'),
            text: port(target, '正向提示词', null),
            imageLinked: !!imageInput(target)?.link,
            modelMirrorCount: (target?.inputs || []).filter((i) => ['CLIP名称', 'CLIP类型', 'VAE名称'].includes(i.name)).length,
          };
        }),
        counts: {
          clip: live.filter((n) => typeOf(n) === 'CLIPLoader').length,
          vae: live.filter((n) => typeOf(n) === 'VAELoader').length,
        },
        loaders: live.filter((n) => ['CLIPLoader', 'VAELoader'].includes(typeOf(n))).map((n) => ({
          id: n.id,
          type: typeOf(n),
          model: String(cell(n, typeOf(n) === 'CLIPLoader' ? 'clip_name' : 'vae_name')?.value ?? ''),
          clipType: String(cell(n, 'type')?.value ?? ''),
        })),
      };
    };

    const convertLegacy = (data, infos, models = {}) => {
      const spec = { clip: CLIP, clipType: CLIP_TYPE, vae: VAE, ...models };
      for (const info of infos) {
        const target = (data.nodes || []).find((n) => String(n.id) === String(info.id));
        if (!target) continue;
        target.widgets_values = [spec.clip, spec.clipType, spec.vae, info.resolution, info.positive, info.negative];
        target.widgets_values_named = {
          CLIP名称: spec.clip, CLIP类型: spec.clipType, VAE名称: spec.vae,
          分辨率: info.resolution, 正向提示词: info.positive, 负向提示词: info.negative,
        };
        target.inputs = [
          { localized_name: '图像1', name: '图像.图像1', shape: 7, type: 'IMAGE', link: info.imageLink ?? null },
          { localized_name: '图像2', name: '图像.图像2', shape: 7, type: 'IMAGE', link: null },
          { localized_name: 'CLIP名称', name: 'CLIP名称', type: 'COMBO', widget: { name: 'CLIP名称' }, link: null },
          { localized_name: 'CLIP类型', name: 'CLIP类型', type: 'COMBO', widget: { name: 'CLIP类型' }, link: null },
          { localized_name: 'VAE名称', name: 'VAE名称', type: 'COMBO', widget: { name: 'VAE名称' }, link: null },
          { localized_name: '分辨率', name: '分辨率', type: 'INT', widget: { name: '分辨率' }, link: null },
          { localized_name: '正向提示词', name: '正向提示词', type: 'STRING', widget: { name: '正向提示词' }, link: info.textLink ?? null },
          { localized_name: '负向提示词', name: '负向提示词', type: 'STRING', widget: { name: '负向提示词' }, link: null },
        ];
        target.properties = {
          ...(target.properties || {}),
          ue_properties: {
            ...(target.properties?.ue_properties || {}),
            widget_ue_connectable: {
              CLIP名称: true, CLIP类型: true, VAE名称: true,
              分辨率: true, 正向提示词: true, 负向提示词: true,
            },
          },
        };
        for (const link of data.links || []) {
          if (String(link[3]) !== String(info.id)) continue;
          if (info.imageLink != null && link[0] === info.imageLink) link[4] = 0;
          if (info.textLink != null && link[0] === info.textLink) link[4] = 6;
        }
      }
      return data;
    };

    const makeBase = async ({ optimizers = 1, manualClip = false, reuseLoaders = false, models = {}, convert = true } = {}) => {
      app.graph.clear();
      await settle(220);
      const image = window.LiteGraph.createNode('EmptyImage');
      const text = window.LiteGraph.createNode('GGTextConcat');
      if (!image || !text) throw new Error('缺少夹具源节点 EmptyImage / GGTextConcat');
      app.graph.add(image);
      app.graph.add(text);
      image.pos = [1000, 100];
      text.pos = [1000, 420];

      const nodes = [];
      for (let i = 0; i < optimizers; i += 1) {
        const n = window.LiteGraph.createNode(${JSON.stringify(NODE)});
        app.graph.add(n);
        n.pos = [500, 120 + i * 520];
        nodes.push(n);
      }
      await settle(260);
      for (const n of nodes) {
        connectTo(image, 0, n, (input) => String(input.name || '').startsWith('图像'));
        connectTo(text, 0, n, (input) => input.name === '正向提示词');
      }

      let manualId = null;
      if (manualClip) {
        const loader = window.LiteGraph.createNode('CLIPLoader');
        app.graph.add(loader);
        setCell(loader, 'clip_name', CLIP);
        setCell(loader, 'type', CLIP_TYPE);
        loader.pos = [80, 120];
        connectTo(loader, 0, nodes[0], (input) => input.name === 'clip');
        manualId = String(loader.id);
      }
      let reusableClipId = null;
      let reusableVaeId = null;
      if (reuseLoaders) {
        const clipLoader = window.LiteGraph.createNode('CLIPLoader');
        app.graph.add(clipLoader);
        setCell(clipLoader, 'clip_name', CLIP);
        setCell(clipLoader, 'type', CLIP_TYPE);
        clipLoader.pos = [80, 760];
        reusableClipId = String(clipLoader.id);
        const vaeLoader = window.LiteGraph.createNode('VAELoader');
        app.graph.add(vaeLoader);
        setCell(vaeLoader, 'vae_name', VAE);
        vaeLoader.pos = [80, 980];
        reusableVaeId = String(vaeLoader.id);
      }
      await settle(320);

      const infos = nodes.map((n) => ({
        id: String(n.id),
        positive: '一只猫，电影光效',
        negative: '低质量，糊',
        resolution: 1024,
        imageLink: imageInput(n)?.link ?? null,
        textLink: findInput(n, '正向提示词')?.link ?? null,
      }));
      const data = app.graph.serialize();
      if (convert) {
        convertLegacy(data, infos, models);
      } else {
        for (const info of infos) {
          const target = (data.nodes || []).find((n) => String(n.id) === String(info.id));
          if (!target) continue;
          target.properties = {
            ...(target.properties || {}),
            [LEGACY_PROP]: {
              clip: models.clip ?? CLIP,
              clipType: models.clipType ?? CLIP_TYPE,
              vae: models.vae ?? VAE,
            },
          };
        }
      }
      return { data, ids: nodes.map((n) => String(n.id)), infos, manualId, reusableClipId, reusableVaeId };
    };

    const load = async (data, label, blockClip = false) => {
      app.graph.clear();
      await settle(220);
      const originalCreate = window.LiteGraph.createNode;
      if (blockClip) {
        window.LiteGraph.createNode = function (type, ...args) {
          return type === 'CLIPLoader' ? null : originalCreate.call(this, type, ...args);
        };
      }
      app.graph.configure(data);
      await settle(1000);
      window.LiteGraph.createNode = originalCreate;
      return inspectGraph(label);
    };
  `;

  const runInPage = (body, extra = {}) => page.evaluate(
    new Function('ARG', `const { MODEL } = ARG;\nreturn (async () => { ${helpers}\n${body} })();`),
    { MODEL: models, ...extra },
  );

  const fresh = await runInPage(`
    app.graph.clear();
    await settle(220);
    const n = window.LiteGraph.createNode(${JSON.stringify(NODE)});
    app.graph.add(n);
    n.pos = [80, 80];
    await settle(600);
    const saved = app.graph.serialize().nodes.find((item) => String(item.id) === String(n.id));
    return {
      values: saved?.widgets_values || [],
      widgetNames: n.widgets.map((w) => w.name),
      inputs: (n.inputs || []).map((i) => ({ name: i.name, type: i.type })),
      valueMap: Object.fromEntries(n.widgets.map((w) => [w.name, w.value])),
    };
  `);
  await shot(page, 'po_split_fresh.png');

  const legacy = await runInPage(`
    const base = await makeBase({ optimizers: 1 });
    const state = await load(base.data, 'legacy');
    return { state };
  `);

  const shared = await runInPage(`
    const base = await makeBase({ optimizers: 2 });
    const state = await load(base.data, 'shared');
    return { state };
  `);

  const missingVae = await runInPage(`
    const base = await makeBase({ optimizers: 1, models: { vae: '（缺少 VAE 模型）' } });
    return load(base.data, 'missingVae');
  `);

  const missingClip = await runInPage(`
    const base = await makeBase({ optimizers: 1, models: { clip: '（缺少 CLIP 模型）' } });
    return load(base.data, 'missingClip');
  `);

  const manual = await runInPage(`
    const base = await makeBase({ optimizers: 1, manualClip: true, convert: false });
    const state = await load(base.data, 'manual');
    return { state, manualId: base.manualId };
  `);

  const reuse = await runInPage(`
    const base = await makeBase({ optimizers: 1, reuseLoaders: true, convert: false });
    const state = await load(base.data, 'reuse');
    return { state, reusableClipId: base.reusableClipId, reusableVaeId: base.reusableVaeId };
  `);

  const failed = await runInPage(`
    const base = await makeBase({ optimizers: 1 });
    const state = await load(base.data, 'failed', true);
    let retried = null;
    let retryInfo = null;
    if (state.nodes[0]?.legacy) {
      const live = app.graph._nodes.find((n) => String(n.id) === String(base.ids[0]));
      const data = app.graph.serialize().nodes.find((n) => String(n.id) === String(base.ids[0]));
      retryInfo = { liveInputs: (live?.inputs || []).map((i) => i.name), dataValues: data?.widgets_values };
      live.onConfigure?.(data);
      await settle(1200);
      retried = inspectGraph('retried');
    }
    return { state, retried, retryInfo };
  `);

  const objectInfo = await page.evaluate(async () => {
    const data = await (await fetch('/object_info/GGPromptOptimizer')).json();
    const req = data.GGPromptOptimizer.input.required;
    const opt = data.GGPromptOptimizer.input.optional || {};
    return {
      keys: Object.keys(req),
      clip: req.clip?.[0],
      vae: opt.vae?.[0],
      optionalKeys: Object.keys(opt),
      widgets: ['CLIP名称', 'CLIP类型', 'VAE名称', '正向提示词', '负向提示词', '分辨率'].filter((name) => name in req || name in opt),
      negativeTooltip: req['负向提示词']?.[1]?.tooltip || '',
    };
  });

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  check('后端 CLIP 是必接类型化输入', objectInfo.clip === 'CLIP', String(objectInfo.clip));
  check('后端 VAE 是可选类型化输入', objectInfo.vae === 'VAE', String(objectInfo.vae));
  check('后端不再声明 CLIP/VAE 文件名控件', !objectInfo.optionalKeys.includes('CLIP名称') && !objectInfo.keys.includes('CLIP类型') && !objectInfo.keys.includes('VAE名称') && !objectInfo.optionalKeys.includes('CLIP类型') && !objectInfo.optionalKeys.includes('VAE名称'), JSON.stringify(objectInfo.keys));
  check('负向提示词提示与分别编码一致', /单独编码/.test(objectInfo.negativeTooltip) && !/不参与编码/.test(objectInfo.negativeTooltip), objectInfo.negativeTooltip);

  check('新建节点只有 3 个控件', fresh.widgetNames.length === 3 && fresh.values.length === 3, JSON.stringify(fresh.widgetNames));
  check('新建节点控件是正向/负向/分辨率', fresh.widgetNames.join('|') === '正向提示词|负向提示词|分辨率', JSON.stringify(fresh.widgetNames));
  check('新建节点默认值正确', fresh.valueMap['正向提示词'] === '' && fresh.valueMap['负向提示词'] === '' && Number(fresh.valueMap['分辨率']) === 1024, JSON.stringify(fresh.valueMap));
  check('新建节点有 clip / vae 端口', fresh.inputs.some((i) => i.name === 'clip' && i.type === 'CLIP') && fresh.inputs.some((i) => i.name === 'vae' && i.type === 'VAE'), JSON.stringify(fresh.inputs));

  const old = legacy.state;
  check('旧 6 值存档迁移成 3 个控件值', old.nodes[0].values.length === 3, JSON.stringify(old.nodes[0].values));
  check('旧提示词与分辨率位置正确', old.nodes[0].values[0] === '一只猫，电影光效' && old.nodes[0].values[1] === '低质量，糊' && Number(old.nodes[0].values[2]) === 1024, JSON.stringify(old.nodes[0].values));
  check('旧模型镜像端口已清理', old.nodes[0].modelMirrorCount === 0, String(old.nodes[0].modelMirrorCount));
  check('旧 CLIP 迁移为外接 CLIPLoader', old.nodes[0].clip.connected && old.nodes[0].clip.sourceType === 'CLIPLoader' && old.nodes[0].clip.model === models.clip, JSON.stringify(old.nodes[0].clip));
  check('旧 VAE 迁移为外接 VAELoader', old.nodes[0].vae.connected && old.nodes[0].vae.sourceType === 'VAELoader' && old.nodes[0].vae.model === models.vae, JSON.stringify(old.nodes[0].vae));
  check('迁移后清除旧模型映射', !old.nodes[0].legacy, JSON.stringify(old.nodes[0].legacy));
  check('旧图像连线保留', old.nodes[0].imageLinked, String(old.nodes[0].imageLinked));
  check('旧文本连线保留', old.nodes[0].text.connected, JSON.stringify(old.nodes[0].text));

  check('两个同权重节点只建一个 CLIPLoader', shared.state.counts.clip === 1 && shared.state.nodes.every((n) => n.clip.connected), JSON.stringify(shared.state));
  check('两个同权重节点只建一个 VAELoader', shared.state.counts.vae === 1 && shared.state.nodes.every((n) => n.vae.connected), JSON.stringify(shared.state));
  check('两个节点都保留图像与文本连线', shared.state.nodes.every((n) => n.imageLinked && n.text.connected), JSON.stringify(shared.state.nodes));

  check('缺 VAE 时不伪造 Loader', missingVae.nodes[0].clip.connected && !missingVae.nodes[0].vae.connected && missingVae.counts.clip === 1 && missingVae.counts.vae === 0, JSON.stringify(missingVae));
  check('缺 VAE 时仍完成已存在模型的迁移', !missingVae.nodes[0].legacy, JSON.stringify(missingVae.nodes[0].legacy));
  check('缺 CLIP 时不伪造 Loader', !missingClip.nodes[0].clip.connected && missingClip.nodes[0].vae.connected && missingClip.counts.clip === 0 && missingClip.counts.vae === 1, JSON.stringify(missingClip));
  check('缺 CLIP 时仍完成已存在模型的迁移', !missingClip.nodes[0].legacy, JSON.stringify(missingClip.nodes[0].legacy));

  check('手动 CLIP 连线优先且不重复建 Loader', manual.state.counts.clip === 1 && manual.state.nodes[0].clip.connected && String(manual.state.nodes[0].clip.sourceId) === String(manual.manualId) && manual.state.nodes[0].clip.model === models.clip, JSON.stringify(manual.state));
  check('手动 CLIP 存在时仍补齐 VAE', manual.state.nodes[0].vae.connected && manual.state.counts.vae === 1, JSON.stringify(manual.state));

  check('可复用已有未接线 CLIPLoader', reuse.state.counts.clip === 1 && reuse.state.nodes[0].clip.connected && String(reuse.state.nodes[0].clip.sourceId) === String(reuse.reusableClipId), JSON.stringify(reuse.state));
  check('可复用已有未接线 VAELoader', reuse.state.counts.vae === 1 && reuse.state.nodes[0].vae.connected && String(reuse.state.nodes[0].vae.sourceId) === String(reuse.reusableVaeId), JSON.stringify(reuse.state));

  check('Loader 创建失败时保留旧模型映射', !!failed.state.nodes[0].legacy && !failed.state.nodes[0].clip.connected, JSON.stringify(failed.state.nodes[0]));
  check('失败时仍可完成 VAE 迁移', failed.state.nodes[0].vae.connected && failed.state.counts.vae === 1, JSON.stringify(failed.state));
  check('后续初始化可重试并清除迁移标记', failed.retried?.nodes[0]?.clip.connected && failed.retried?.nodes[0]?.vae.connected && !failed.retried?.nodes[0]?.legacy && failed.retried.counts.clip === 1, JSON.stringify(failed.retried));

  check('无页面异常', errors.length === 0, JSON.stringify(errors));

  const passed = checks.filter((c) => c.ok).length;
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  << ' + c.detail}`);
  console.log(`\n${passed}/${checks.length} 通过`);
  console.log('测试权重', models.clip, '/', models.vae, '/', models.clipType);
  await browser.close();
  process.exit(passed === checks.length ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function shot(page, name) {
  const box = await page.evaluate(() => {
    const app = window.app;
    const n = app.graph._nodes.find((x) => (x.comfyClass || x.type) === 'GGPromptOptimizer');
    const rect = app.canvas.canvas.getBoundingClientRect();
    const ds = app.canvas.ds;
    return {
      x: rect.left + (n.pos[0] + ds.offset[0]) * ds.scale,
      y: rect.top + (n.pos[1] + ds.offset[1]) * ds.scale,
      w: n.size[0] * ds.scale,
      h: n.size[1] * ds.scale,
    };
  });
  await page.mouse.move(1800, 1100);
  await page.waitForTimeout(180);
  await page.screenshot({
    path: path.join(OUT, name),
    clip: { x: box.x - 10, y: box.y - 12, width: Math.min(box.w + 20, 900), height: Math.min(box.h + 26, 1100) },
  });
}
