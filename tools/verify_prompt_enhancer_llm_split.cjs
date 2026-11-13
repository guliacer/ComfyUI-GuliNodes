// GG 提示词增强qwen2.1 本地LLM 双模型回归：默认值 / 显隐 / 切换不串值 / 老存档迁移。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_prompt_enhancer_llm_split.cjs
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, 'out');
const T2I = '文生图LLM模型';
const I2I = '图生图LLM模型';
const PE_T2I = '文生图PE模型';
const PE_I2I = '图生图PE模型';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1900, height: 1200 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const helpers = `
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const settle = async (ms = 320) => {
      await new Promise((r) => setTimeout(r, ms));
      await tick();
      await tick();
    };
    const node = () => app.graph._nodes.find((n) => n.comfyClass === 'GGPromptEnhancer' || n.type === 'GGPromptEnhancer');
    const byName = (n) => node().widgets.find((w) => w.name === n);
    const val = (n) => String(byName(n)?.value ?? '');
    const inputByName = (n, name) => (n?.inputs || []).find((i) => i.name === name);
    const inputConnected = (name) => inputByName(node(), name)?.link != null;
    const visible = (n) => {
      const w = byName(n);
      return !!w && !w.hidden && !String(w.type).startsWith('ggHidden');
    };
    const set = async (name, value) => {
      const w = byName(name);
      if (!w) throw new Error('缺控件 ' + name);
      if (typeof w.setValue === 'function') w.setValue(value, { e: null, node: node(), canvas: app.canvas });
      else { w.value = value; w.callback?.(value); }
      await settle(360);
    };
    const snap = (label) => {
      const n = node();
      const values = app.graph.serialize().nodes.find((x) => x.type === 'GGPromptEnhancer').widgets_values;
      return {
        label,
        task: val('任务模式'), method: val('增强方式'),
        t2i: val(T2I_NAME), i2i: val(I2I_NAME), mmproj: val('mmproj'),
        shown: {
          t2i: visible(T2I_NAME), i2i: visible(I2I_NAME), mmproj: visible('mmproj'),
          peT2I: inputConnected('文生图PE模型'), peI2I: inputConnected('图生图PE模型'),
          apiKey: visible('api_key'),
        },
        widgetCount: n.widgets.length,
        valuesCount: values.length,
        values,
        widgetNames: n.widgets.map((w) => w.name),
        mirrorNames: (n.inputs || []).filter((i) => i.widget).map((i) => i.name),
      };
    };
  `;

  const runInPage = (body) => page.evaluate(
    new Function('ARG', `const { T2I_NAME, I2I_NAME, PE_T2I, PE_I2I } = ARG;\nreturn (async () => { ${helpers}\n${body} })();`),
    { T2I_NAME: T2I, I2I_NAME: I2I, PE_T2I, PE_I2I },
  );

  const fresh = await runInPage(`
    app.graph.clear();
    app.canvas.ds.scale = 2;
    app.canvas.ds.offset = [40, 40];
    const n = window.LiteGraph.createNode('GGPromptEnhancer');
    app.graph.add(n);
    n.pos = [40, 40];
    await settle(600);
    const out = { initial: snap('initial') };
    await set('增强方式', '本地LLM');
    out.llmAuto = snap('llmAuto');
    return out;
  `);
  await shot(page, 'pe_llm_auto.png');

  const t2iState = await runInPage(`
    await set('任务模式', '文生图');
    return snap('llmT2I');
  `);
  await shot(page, 'pe_llm_t2i.png');

  const i2iState = await runInPage(`
    await set('任务模式', '图生图');
    return snap('llmI2I');
  `);
  await shot(page, 'pe_llm_i2i.png');

  const migration = await runInPage(`
    await set('任务模式', '自动');
    // 接一条真实的 IMAGE 连线到 Autogrow 的第一个槽位，验证迁移不会在 configure 阶段丢线。
    let linkInfo = { attempted: false, connected: false };
    const src = window.LiteGraph.createNode('EmptyImage');
    if (src) {
      app.graph.add(src);
      src.pos = [700, 40];
      const target = node();
      const idx = (target.inputs || []).findIndex((i) => /^图片[.．]?图片?1$|^图片1$/.test(String(i.name || '')));
      linkInfo.attempted = idx >= 0;
      if (idx >= 0) {
        try {
          src.connect(0, target, idx);
          linkInfo.connected = (target.inputs[idx].link != null);
        } catch (e) { linkInfo.error = String(e); }
      }
      await settle(240);
    }
    const withLink = app.graph.serialize();
    const clipInfo = await (await fetch('/object_info/CLIPLoader')).json();
    const clipChoices = clipInfo.CLIPLoader.input.required.clip_name[0];
    const peChoices = clipChoices.filter((value) => /\.safetensors$/i.test(String(value)));
    if (!peChoices.length) throw new Error('CLIPLoader 没有可用 safetensors，无法构造旧 PE 存档夹具');
    const peT2I = peChoices.find((value) => /qwen/i.test(String(value))) || peChoices[0];
    const peI2I = peChoices.find((value) => value !== peT2I && /qwen/i.test(String(value)))
      || peChoices.find((value) => value !== peT2I) || peT2I;

    const oldInputs = (data, target, keepTypedPorts) => {
      if (keepTypedPorts) return;
      const original = target.inputs || [];
      const slotMap = new Map();
      target.inputs = original.filter((input, index) => {
        if ([PE_T2I, PE_I2I].includes(input.name)) return false;
        slotMap.set(index, target.inputs ? [...original.slice(0, index)].filter((x) => ![PE_T2I, PE_I2I].includes(x.name)).length : index);
        return true;
      });
      for (const link of data.links || []) {
        if (link[3] === target.id && slotMap.has(link[4])) link[4] = slotMap.get(link[4]);
      }
    };
    const legacyData = (source, models = [peT2I, peI2I], keepTypedPorts = false) => {
      const data = JSON.parse(JSON.stringify(source));
      const target = data.nodes.find((item) => item.type === 'GGPromptEnhancer');
      target.widgets_values.splice(6, 0, models[0], models[1]);
      target.widgets_values_named = {
        ...(target.widgets_values_named || {}), [PE_T2I]: models[0], [PE_I2I]: models[1],
      };
      oldInputs(data, target, keepTypedPorts);
      return data;
    };
    const inspect = (label) => {
      const saved = app.graph.serialize();
      const targetData = saved.nodes.find((item) => item.type === 'GGPromptEnhancer');
      const links = new Map((saved.links || []).map((item) => [item[0], item]));
      const liveNode = node();
      const ports = [PE_T2I, PE_I2I].map((name) => {
        const input = inputByName(liveNode, name);
        const edge = input?.link == null ? null : links.get(input.link);
        const loader = edge ? app.graph._nodes.find((item) => String(item.id) === String(edge[1])) : null;
        return {
          name, connected: !!edge, sourceType: loader?.comfyClass || loader?.type || '',
          sourceId: edge?.[1] ?? null,
          model: String(loader?.widgets?.find((widget) => widget.name === 'clip_name')?.value ?? ''),
          clipType: String(loader?.widgets?.find((widget) => widget.name === 'type')?.value ?? ''),
        };
      });
      return {
        label,
        values: targetData.widgets_values,
        imageInputLinked: (liveNode.inputs || []).some((input) => /图片/.test(String(input.name || '')) && input.link != null),
        ports,
        clipLoaderCount: app.graph._nodes.filter((item) => (item.comfyClass || item.type) === 'CLIPLoader').length,
        legacyModels: targetData.properties?._ggLegacyPeModelsV1 || null,
      };
    };
    const load = async (data, label, blockLoader = false) => {
      app.graph.clear();
      await settle(180);
      const originalCreateNode = window.LiteGraph.createNode;
      if (blockLoader) {
        window.LiteGraph.createNode = function (type, ...args) {
          return type === 'CLIPLoader' ? null : originalCreateNode.call(this, type, ...args);
        };
      }
      app.graph.configure(data);
      await settle(900);
      window.LiteGraph.createNode = originalCreateNode;
      return inspect(label);
    };

    const legacy19Data = legacyData(withLink);
    const legacy19 = await load(legacy19Data, 'legacy19');
    const sameModel = await load(legacyData(withLink, [peT2I, peT2I]), 'sameModel');
    const placeholder = await load(legacyData(withLink, [peT2I, '（缺少 PE 模型）']), 'placeholder');
    const clipL = await load(legacyData(withLink, ['clip_l.safetensors', 'clip_l.safetensors']), 'clipL');

    // 已有用户 CLIP 连线必须保留；只为另一输入补建 Loader。
    app.graph.clear();
    await settle(180);
    const manualData = JSON.parse(JSON.stringify(withLink));
    app.graph.configure(manualData);
    await settle(600);
    const manualLoader = window.LiteGraph.createNode('CLIPLoader');
    const setValue = (loader, name, value) => {
      const widget = loader.widgets.find((item) => item.name === name);
      if (!widget) throw new Error('CLIPLoader 缺少控件 ' + name);
      widget.value = value;
      widget.callback?.(value);
    };
    setValue(manualLoader, 'clip_name', peT2I);
    setValue(manualLoader, 'type', 'qwen_image');
    app.graph.add(manualLoader);
    manualLoader.connect(0, node(), (node().inputs || []).findIndex((input) => input.name === PE_T2I));
    await settle(180);
    const manualBase = app.graph.serialize();
    const manual = await load(legacyData(manualBase, [peT2I, peI2I], true), 'manual');

    // 匹配已有 Loader 时复用它，不再创建重复模型加载节点。
    app.graph.clear();
    await settle(180);
    app.graph.configure(withLink);
    await settle(600);
    const reusedLoader = window.LiteGraph.createNode('CLIPLoader');
    const setReuseWidget = (name, value) => {
      const widget = reusedLoader.widgets.find((item) => item.name === name);
      if (!widget) throw new Error('CLIPLoader 缺少控件 ' + name);
      widget.value = value;
      widget.callback?.(value);
    };
    setReuseWidget('clip_name', peT2I);
    setReuseWidget('type', 'qwen_image');
    app.graph.add(reusedLoader);
    await settle(120);
    const reusableBase = app.graph.serialize();
    const reused = await load(legacyData(reusableBase, [peT2I, peI2I]), 'reused');

    // Loader 创建暂时不可用时保留原 PE 名称属性，下一次 setup 可补完。
    const retryData = legacyData(withLink);
    const failed = await load(retryData, 'failed', true);
    let retried = null;
    if (failed.legacyModels) {
      const enhancer = node();
      enhancer.onConfigure?.(app.graph.serialize().nodes.find((item) => item.type === 'GGPromptEnhancer'));
      await settle(900);
      retried = inspect('retried');
    }

    return {
      linkInfo,
      currentValues: withLink.nodes.find((item) => item.type === 'GGPromptEnhancer').widgets_values,
      peT2I, peI2I,
      legacy19, sameModel, placeholder, clipL, manual, reused, failed, retried,
    };
  `);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  const objectInfo = await page.evaluate(async () => {
    const data = await (await fetch('/object_info/GGPromptEnhancer')).json();
    const req = data.GGPromptEnhancer.input.required;
    const opt = data.GGPromptEnhancer.input.optional || {};
    const keys = Object.keys(req);
    const def = (k) => req[k]?.[1]?.default;
    return {
      keys, t2i: def('文生图LLM模型'), i2i: def('图生图LLM模型'), mmproj: def('mmproj'),
      peInputs: [opt['文生图PE模型']?.[0], opt['图生图PE模型']?.[0]],
      peWidgets: ['文生图PE模型', '图生图PE模型'].filter((name) => name in req),
    };
  });
  check('后端声明两个独立 LLM 模型且相邻', objectInfo.keys.indexOf(I2I) === objectInfo.keys.indexOf(T2I) + 1, JSON.stringify(objectInfo.keys));
  check('默认文生图模型是 T2I GGUF', /T2I/i.test(String(objectInfo.t2i)) && !/mmproj/i.test(String(objectInfo.t2i)), String(objectInfo.t2i));
  check('默认图生图模型是 I2I GGUF', /I2I/i.test(String(objectInfo.i2i)) && !/mmproj/i.test(String(objectInfo.i2i)), String(objectInfo.i2i));
  check('两个默认模型不同', objectInfo.t2i !== objectInfo.i2i, `${objectInfo.t2i} / ${objectInfo.i2i}`);
  check('默认 mmproj 与图生图模型同前缀', /mmproj/i.test(String(objectInfo.mmproj)) && String(objectInfo.mmproj).toLowerCase().startsWith(String(objectInfo.i2i).toLowerCase().slice(0, 12)), String(objectInfo.mmproj));
  check('PE 文件名控件已由两个 CLIP 端口取代', JSON.stringify(objectInfo.peInputs) === '["CLIP","CLIP"]' && objectInfo.peWidgets.length === 0, JSON.stringify(objectInfo));

  const init = fresh.initial;
  check('新建节点 17 个控件值', init.valuesCount === 17 && init.widgetCount === 17, `values=${init.valuesCount} widgets=${init.widgetCount}`);
  check('本地PE 不再内置权重选择器', init.method === '本地PE' && !init.widgetNames.includes(PE_T2I) && !init.widgetNames.includes(PE_I2I) && !init.shown.t2i && !init.shown.i2i, JSON.stringify(init));

  const auto = fresh.llmAuto;
  check('自动 + 本地LLM 两个模型都显示', auto.shown.t2i && auto.shown.i2i && auto.shown.mmproj && !auto.shown.peT2I && !auto.shown.apiKey, JSON.stringify(auto.shown));
  check('两个模型各是各自的 GGUF', auto.t2i !== auto.i2i && /T2I/i.test(auto.t2i) && /I2I/i.test(auto.i2i), `${auto.t2i} / ${auto.i2i}`);
  check('控件镜像包含两个新模型', auto.mirrorNames.indexOf(I2I) === auto.mirrorNames.indexOf(T2I) + 1, JSON.stringify(auto.mirrorNames));

  check('切到文生图只显示文生图模型', t2iState.shown.t2i && !t2iState.shown.i2i && !t2iState.shown.mmproj, JSON.stringify(t2iState.shown));
  check('切到图生图只显示图生图模型 + mmproj', i2iState.shown.i2i && i2iState.shown.mmproj && !i2iState.shown.t2i, JSON.stringify(i2iState.shown));
  check('切换任务不串值', t2iState.t2i === auto.t2i && i2iState.i2i === auto.i2i && i2iState.t2i === auto.t2i && t2iState.i2i === auto.i2i, `${t2iState.t2i}/${t2iState.i2i} vs ${i2iState.t2i}/${i2iState.i2i}`);

  const current = migration.currentValues;
  const old = migration.legacy19;
  check('当前节点控件值 17 位', current.length === 17, String(current.length));
  check('旧存档去掉 PE 控件后仍为 17 位', old.values.length === 17, JSON.stringify(old.values));
  check('旧存档 LLM 参数和提示词位置保持', [6, 7, 8, 9, 10, 13, 14, 16].every((index) => old.values[index] === current[index]), JSON.stringify(old.values));
  check('旧 PE 选项自动转换为两路 CLIPLoader', old.ports.every((port) => port.connected && port.sourceType === 'CLIPLoader' && port.clipType === 'qwen_image'), JSON.stringify(old.ports));
  check('旧 PE 文件名分别保留在 Loader', old.ports[0].model === migration.peT2I && old.ports[1].model === migration.peI2I, JSON.stringify(old.ports));
  check('模型不同则各建一个 Loader', migration.peT2I === migration.peI2I ? old.clipLoaderCount === 1 : old.clipLoaderCount === 2, String(old.clipLoaderCount));
  check('同权重两路复用一个 Loader', migration.sameModel.clipLoaderCount === 1 && migration.sameModel.ports.every((port) => port.connected && port.model === migration.peT2I), JSON.stringify(migration.sameModel));
  check('缺失的第二权重不伪造 Loader', migration.placeholder.ports[0].connected && !migration.placeholder.ports[1].connected && migration.placeholder.clipLoaderCount === 1, JSON.stringify(migration.placeholder));
  check('旧 clip_l 默认值不建 Qwen PE Loader', migration.clipL.clipLoaderCount === 0 && migration.clipL.ports.every((port) => !port.connected) && !migration.clipL.legacyModels, JSON.stringify(migration.clipL));
  check('手动 CLIP 连线优先且另一端自动补齐', migration.manual.ports.every((port) => port.connected && port.model === (port.name === PE_T2I ? migration.peT2I : migration.peI2I)), JSON.stringify(migration.manual.ports));
  check('可复用现有 CLIPLoader', migration.reused.ports.every((port) => port.connected) && migration.reused.clipLoaderCount === (migration.peT2I === migration.peI2I ? 1 : 2), JSON.stringify(migration.reused));
  check('Loader 建立失败时保留旧权重映射', !!migration.failed.legacyModels && migration.failed.ports.every((port) => !port.connected), JSON.stringify(migration.failed));
  check('后续初始化可重试并清除迁移标记', migration.retried?.ports.every((port) => port.connected) && !migration.retried.legacyModels, JSON.stringify(migration.retried));
  check('旧图像输入连线在迁移后保留', old.imageInputLinked, String(old.imageInputLinked));
  check('迁移前已接上图片连线', migration.linkInfo.connected === true, JSON.stringify(migration.linkInfo));

  check('无页面异常', errors.length === 0, JSON.stringify(errors));

  const passed = checks.filter((c) => c.ok).length;
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  << ' + c.detail}`);
  console.log(`\n${passed}/${checks.length} 通过`);
  if (passed === checks.length) {
    console.log('默认模型', objectInfo.t2i, '/', objectInfo.i2i, '/', objectInfo.mmproj);
  }
  await browser.close();
  process.exit(passed === checks.length ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function shot(page, name) {
  const box = await page.evaluate(() => {
    const app = window.app;
    const n = app.graph._nodes.find((x) => x.comfyClass === 'GGPromptEnhancer' || x.type === 'GGPromptEnhancer');
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
