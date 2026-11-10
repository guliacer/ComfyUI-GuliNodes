// GG 提示词增强qwen2.1 本地LLM 双模型回归：默认值 / 显隐 / 切换不串值 / 老存档迁移。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_prompt_enhancer_llm_split.cjs
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, 'out');
const T2I = '文生图LLM模型';
const I2I = '图生图LLM模型';

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
          peT2I: visible('文生图PE模型'), apiKey: visible('api_key'),
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
    new Function('ARG', `const { T2I_NAME, I2I_NAME } = ARG;\nreturn (async () => { ${helpers}\n${body} })();`),
    { T2I_NAME: T2I, I2I_NAME: I2I },
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
    const saved = app.graph.serialize();
    const savedNode = saved.nodes.find((x) => x.type === 'GGPromptEnhancer');

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
    const withLinkValues = withLink.nodes.find((x) => x.type === 'GGPromptEnhancer').widgets_values.slice();

    const legacy18 = withLinkValues.slice();
    legacy18.splice(9, 1);  // 去掉新控件，模拟只有一个「主模型」的老存档
    const legacy17 = legacy18.slice();
    legacy17.splice(13, 1); // 更早的存档连 control_after_generate 都没有

    // 本仓库正式示例工作流（分区编辑 / 人像精修）导出的 16 位老格式：
    // 下标 13 是 control_after_generate（旧前端存 true/false），尾部还没有
    // 「透明背景」「增强方向」。
    const legacy16 = [
      '图生图', '中文', '本地LLM', '', 'https://api.deepseek.com', 'deepseek-flash',
      'clip_l.safetensors', 'clip_l.safetensors',
      'Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf',
      'Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf',
      16384, 1536, 666, true, true, '',
    ];

    // 骨架工具生成的新版存档：控件已经拆成双模型，只是少了前端自动加的
    // control_after_generate（18 位）。带 widgets_values_named 时绝不能被当成
    // 「只有一个主模型」的老存档再插一格。
    const named18 = withLinkValues.slice();
    named18.splice(14, 1);

    const load = async (values, label, dropNamed = false, stripNamedControl = false) => {
      const data = JSON.parse(JSON.stringify(withLink));
      const target = data.nodes.find((x) => x.type === 'GGPromptEnhancer');
      target.widgets_values = values;
      // 老存档没有 widgets_values_named，留着新字段会盖掉位置数组，造成假 PASS。
      if (dropNamed) delete target.widgets_values_named;
      else if (stripNamedControl && target.widgets_values_named) {
        delete target.widgets_values_named.control_after_generate;
      }
      app.graph.clear();
      await settle(180);
      app.graph.configure(data);
      await settle(700);
      const n = node();
      const textInput = (n.inputs || []).find((i) => /图片/.test(String(i.name || '')));
      return {
        label,
        values: app.graph.serialize().nodes.find((x) => x.type === 'GGPromptEnhancer').widgets_values,
        widgetNames: n.widgets.map((w) => w.name),
        mirrorNames: (n.inputs || []).filter((i) => i.widget).map((i) => i.name),
        t2i: val(T2I_NAME), i2i: val(I2I_NAME), mmproj: val('mmproj'),
        prompt: val('输入提示词'),
        imageInputLinked: !!textInput && textInput.link != null,
        linkCount: app.graph.links ? Object.keys(app.graph.links).length : 0,
      };
    };

    return {
      saved: savedNode.widgets_values,
      linkInfo,
      // 真实老存档没有 widgets_values_named；留着新字段会让 named 保护生效，
      // 迁移分支测不到（假 PASS）。
      legacy18: await load(legacy18, 'legacy18', true),
      legacy17: await load(legacy17, 'legacy17', true),
      legacy16: await load(legacy16, 'legacy16', true),
      named18: await load(named18, 'named18', false, true),
      current: snap('afterReload'),
    };
  `);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  const objectInfo = await page.evaluate(async () => {
    const data = await (await fetch('/object_info/GGPromptEnhancer')).json();
    const req = data.GGPromptEnhancer.input.required;
    const keys = Object.keys(req);
    const def = (k) => req[k]?.[1]?.default;
    return { keys, t2i: def('文生图LLM模型'), i2i: def('图生图LLM模型'), mmproj: def('mmproj') };
  });
  check('后端声明两个独立 LLM 模型且相邻', objectInfo.keys.indexOf(I2I) === objectInfo.keys.indexOf(T2I) + 1, JSON.stringify(objectInfo.keys));
  check('默认文生图模型是 T2I GGUF', /T2I/i.test(String(objectInfo.t2i)) && !/mmproj/i.test(String(objectInfo.t2i)), String(objectInfo.t2i));
  check('默认图生图模型是 I2I GGUF', /I2I/i.test(String(objectInfo.i2i)) && !/mmproj/i.test(String(objectInfo.i2i)), String(objectInfo.i2i));
  check('两个默认模型不同', objectInfo.t2i !== objectInfo.i2i, `${objectInfo.t2i} / ${objectInfo.i2i}`);
  check('默认 mmproj 与图生图模型同前缀', /mmproj/i.test(String(objectInfo.mmproj)) && String(objectInfo.mmproj).toLowerCase().startsWith(String(objectInfo.i2i).toLowerCase().slice(0, 12)), String(objectInfo.mmproj));

  const init = fresh.initial;
  check('新建节点 19 个控件值', init.valuesCount === 19 && init.widgetCount === 19, `values=${init.valuesCount} widgets=${init.widgetCount}`);
  check('默认是本地PE 且只显示 PE 模型', init.method === '本地PE' && init.shown.peT2I && !init.shown.t2i && !init.shown.i2i, JSON.stringify(init.shown));

  const auto = fresh.llmAuto;
  check('自动 + 本地LLM 两个模型都显示', auto.shown.t2i && auto.shown.i2i && auto.shown.mmproj && !auto.shown.peT2I && !auto.shown.apiKey, JSON.stringify(auto.shown));
  check('两个模型各是各自的 GGUF', auto.t2i !== auto.i2i && /T2I/i.test(auto.t2i) && /I2I/i.test(auto.i2i), `${auto.t2i} / ${auto.i2i}`);
  check('控件镜像包含两个新模型', auto.mirrorNames.indexOf(I2I) === auto.mirrorNames.indexOf(T2I) + 1, JSON.stringify(auto.mirrorNames));

  check('切到文生图只显示文生图模型', t2iState.shown.t2i && !t2iState.shown.i2i && !t2iState.shown.mmproj, JSON.stringify(t2iState.shown));
  check('切到图生图只显示图生图模型 + mmproj', i2iState.shown.i2i && i2iState.shown.mmproj && !i2iState.shown.t2i, JSON.stringify(i2iState.shown));
  check('切换任务不串值', t2iState.t2i === auto.t2i && i2iState.i2i === auto.i2i && i2iState.t2i === auto.t2i && t2iState.i2i === auto.i2i, `${t2iState.t2i}/${t2iState.i2i} vs ${i2iState.t2i}/${i2iState.i2i}`);

  const saved = migration.saved;
  check('迁移前存档 19 位', saved.length === 19, String(saved.length));
  for (const [label, loaded, legacy] of [['18 位老存档', migration.legacy18, null], ['17 位更老存档', migration.legacy17, null]]) {
    check(`${label} 补齐到 19 位`, loaded.values.length === 19, String(loaded.values.length));
    check(`${label} 旧主模型值落在文生图模型`, loaded.values[8] === saved[8], `${loaded.values[8]} != ${saved[8]}`);
    check(`${label} 图生图模型补成旧主模型`, loaded.values[9] === saved[8], `${loaded.values[9]} != ${saved[8]}`);
    check(`${label} mmproj 没有错位`, loaded.values[10] === saved[10], `${loaded.values[10]} != ${saved[10]}`);
    check(`${label} 输入提示词没有错位`, loaded.values[15] === saved[15], `${loaded.values[15]} != ${saved[15]}`);
    check(`${label} 增强方向没有错位`, loaded.values[18] === saved[18], `${loaded.values[18]} != ${saved[18]}`);
    check(`${label} 控件镜像含新模型`, loaded.mirrorNames.indexOf(I2I) === loaded.mirrorNames.indexOf(T2I) + 1, JSON.stringify(loaded.mirrorNames));
  }
  const l16 = migration.legacy16;
  const l16Main = 'Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf';
  const l16Proj = 'Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf';
  check('16 位老存档补齐到 19 位', l16.values.length === 19, JSON.stringify(l16.values));
  check('16 位旧主模型同时落在两个 LLM 模型', l16.values[8] === l16Main && l16.values[9] === l16Main, `${l16.values[8]} / ${l16.values[9]}`);
  check('16 位 mmproj / seed / 输入提示词不错位', l16.values[10] === l16Proj && l16.values[13] === 666 && l16.values[16] === '', JSON.stringify(l16.values.slice(10, 17)));
  check('16 位旧布尔 control 规范化成 fixed', l16.values[14] === 'fixed', String(l16.values[14]));
  check('16 位补齐透明背景 / 增强方向', l16.values[17] === false && l16.values[18] === '默认', `${l16.values[17]} / ${l16.values[18]}`);
  check('16 位两个模型控件值正确', l16.t2i === l16Main && l16.i2i === l16Main && l16.mmproj === l16Proj, `${l16.t2i} / ${l16.i2i} / ${l16.mmproj}`);
  check('16 位控件镜像含新模型', l16.mirrorNames.indexOf(I2I) === l16.mirrorNames.indexOf(T2I) + 1, JSON.stringify(l16.mirrorNames));

  const n18 = migration.named18;
  check('带 named 的 18 位新版存档补齐到 19 位', n18.values.length === 19, JSON.stringify(n18.values));
  check('带 named 的 18 位存档双模型不被重复插入', n18.values[8] === saved[8] && n18.values[9] === saved[9] && n18.values[10] === saved[10], JSON.stringify(n18.values.slice(8, 11)));
  check('带 named 的 18 位存档 control 归位', n18.values[14] === 'fixed', String(n18.values[14]));
  check('带 named 的 18 位存档尾部不错位', n18.values[16] === saved[16] && n18.values[18] === saved[18], JSON.stringify(n18.values.slice(16)));
  check('带 named 的 18 位存档连线还在', n18.imageInputLinked, String(n18.imageInputLinked));

  check('迁移前已接上图片连线', migration.linkInfo.connected === true, JSON.stringify(migration.linkInfo));
  check('读档后图片连线还在', migration.legacy18.imageInputLinked && migration.legacy17.imageInputLinked && l16.imageInputLinked, `18=${migration.legacy18.imageInputLinked} 17=${migration.legacy17.imageInputLinked} 16=${l16.imageInputLinked}`);

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
