// GG 简单数学表达式：动态输入 / 表达式 / 输出 的真机验证
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_simple_math.cjs
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:8188/';
const OUT_DIR = path.join(__dirname, 'out');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  // 外部扩展启动噪音（gulips.bridge 的 io is not defined、内嵌网页的 CSP
  // report-only 报告）与本模块无关，单独放行；其它任何 console error 仍计入
  // consoleErrors，避免「无脚本异常」被放宽成空跑（问题文档第 5 条）。
  const ENV_NOISE = [
    /Error calling extension 'gulips[.]bridge' method 'setup'/,
    /report-only Content Security Policy/,
    /Framing .* violates the following report-only/,
    /upgrade-insecure-requests' is ignored when delivered in a report-only policy/,
    // 外部扩展 ComfyUI-GuliPS 的动态 chunk 预加载失败（换 ComfyUI 实例后可见）。
    /\[vite:preloadError\].*ComfyUI-GuliPS/,
  ];
  page.on('console', (m) => {
    if (m.type() !== 'error' || /Failed to load resource/.test(m.text())) return;
    const text = m.text();
    if (ENV_NOISE.some((re) => re.test(text))) return;
    consoleErrors.push('console: ' + text);
  });
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1200);

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

  // 在页面里装一套小工具：建节点、连线、读状态、读工作流。
  await page.evaluate(() => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const settle = async () => {
      for (let i = 0; i < 4; i += 1) await tick();
      await new Promise((r) => setTimeout(r, 80));
      for (let i = 0; i < 2; i += 1) await tick();
    };
    window.__mathTest = {
      async reset() {
        app.graph.clear();
        app.canvas.ds.scale = 1;
        app.canvas.ds.offset = [40, 80];
        await settle();
      },
      async create() {
        const node = window.LiteGraph.createNode('GGSimpleMath');
        app.graph.add(node);
        node.pos = [60, 80];
        await settle();
        return node.id;
      },
      state(id) {
        const node = app.graph.getNodeById(id);
        if (!node) return null;
        const exprs = (node.widgets ?? []).filter((w) => /^表达式_\d+$/.test(String(w.name)));
        return {
          inputs: (node.inputs ?? []).filter((i) => !i.widget).map((i) => ({
            name: i.name, type: i.type, linked: i.link != null,
          })),
          outputs: (node.outputs ?? []).map((o) => ({
            name: o.name, type: o.type,
            links: Array.isArray(o.links) ? o.links.length : (o.link != null ? 1 : 0),
          })),
          exprVisible: exprs.filter((w) => !w.hidden && !String(w.type).startsWith('ggHidden')).length,
          exprHidden: exprs.filter((w) => w.hidden || String(w.type).startsWith('ggHidden')).length,
          exprValues: exprs.map((w) => w.value),
          size: [Math.round(node.size[0]), Math.round(node.size[1])],
          migrated: !!node._ggMathOutputsMigrated,
        };
      },
      async connectInput(mainId, name) {
        const main = app.graph.getNodeById(mainId);
        // inputs 里混着表达式控件的镜像条目，必须按名字找真实端口下标
        const slot = main.inputs.findIndex((i) => !i.widget && i.name === name);
        if (slot < 0) return { error: 'input not found', name, inputs: main.inputs.map((i) => i.name) };
        const src = window.LiteGraph.createNode('GGInteger');
        app.graph.add(src);
        src.pos = [-400, 80 + slot * 90];
        const link = src.connect(0, main, slot);
        await settle();
        return { link: link ? true : null, srcId: src.id, slot };
      },
      async connectOutput(mainId, slot) {
        const main = app.graph.getNodeById(mainId);
        const dst = window.LiteGraph.createNode('GGSimpleMath');
        app.graph.add(dst);
        dst.pos = [700, 80 + slot * 90];
        await settle();
        const target = dst.inputs.findIndex((i) => !i.widget && i.name === 'a');
        const link = main.connect(slot, dst, target);
        await settle();
        return { link: link ? true : null, dstId: dst.id, target };
      },
      async disconnectOutput(mainId, slot) {
        const main = app.graph.getNodeById(mainId);
        main.disconnectOutput(slot);
        await settle();
      },
      async roundtrip() {
        const data = app.graph.serialize();
        app.graph.clear();
        await settle();
        await app.loadGraphData(data);
        await settle();
        return data.nodes.map((n) => n.id);
      },
      async legacyMigration() {
        // 直接把一条真实连线 + 旧输出名注入节点，验证迁移函数本身：
        // 浮点_1(slot 1) 的连线必须改指结果_1(slot 0)，输出名统一成结果_n。
        // 不借 loadGraphData —— 新版前端在 configure 阶段对「旧格式工作流」
        // 的连线恢复有自己一套规则，用夹具拼出来的混搭存档测不出产品逻辑。
        app.graph.clear();
        await settle();
        const main = window.LiteGraph.createNode('GGSimpleMath');
        app.graph.add(main);
        const dst = window.LiteGraph.createNode('GGSimpleMath');
        app.graph.add(dst);
        await settle();
        const target = dst.inputs.findIndex((i) => !i.widget && i.name === 'a');
        main.connect(1, dst, target);
        await settle();

        // 不改画布上的 output.name：新版前端发现名字与 nodeType 不符会重建
        // 输出数组并顺手断线。真实老工作流的凭据由 _ggMathLegacyHint 传入。
        const countLinks = () => {
          const l = app.graph.links;
          const all = typeof l?.values === 'function' ? Array.from(l.values()) : (Array.isArray(l) ? l : Object.values(l ?? {}));
          return { n: all.length, slots: all.map((x) => x?.origin_slot ?? x?._state?.originSlot ?? null), ids: all.map((x) => String(x?.origin_id ?? x?._state?.originNodeId ?? '')) };
        };
        const beforeInject = countLinks();
        const outputsBefore = main.outputs.map((o) => ({ name: o.name, links: o.links }));
        main._ggMathLegacyHint = true;
        main._ggMathOutputsMigrated = false;
        main._ggMathStateKey = null;
        main.onConnectionsChange?.(2);
        await settle();

        const links = app.graph.links;
        const all = typeof links?.values === 'function'
          ? Array.from(links.values())
          : (Array.isArray(links) ? links : Object.values(links ?? {}));
        const link = all.find((l) => l && String(l.origin_id ?? l._state?.originNodeId) === String(main.id));
        return {
          beforeInject,
          outputsBefore,
          outputs: (main.outputs ?? []).map((o) => o.name),
          originSlot: link?.origin_slot ?? link?._state?.originSlot ?? null,
          linkCount: all.length,
          exprVisible: (main.widgets ?? []).filter(
            (w) => /^表达式_\d+$/.test(String(w.name)) && !w.hidden && !String(w.type).startsWith('ggHidden'),
          ).length,
        };
      },

      async legacyWidgetValues() {
        // 老存档只有 2 条表达式值，加载后前两条不能变，后 8 条补默认值
        app.graph.clear();
        await settle();
        const node = window.LiteGraph.createNode('GGSimpleMath');
        app.graph.add(node);
        await settle();
        const data = app.graph.serialize();
        const entry = data.nodes.find((n) => String(n.id) === String(node.id));
        entry.widgets_values = ['a*c/d', 'b*c/d'];
        await app.loadGraphData(data);
        await settle();
        const fresh = app.graph.getNodeById(node.id);
        const exprs = (fresh?.widgets ?? []).filter((w) => /^表达式_\d+$/.test(String(w.name)));
        return { count: exprs.length, values: exprs.slice(0, 3).map((w) => w.value) };
      },
      async objectInfo() {
        const res = await fetch('/object_info/GGSimpleMath');
        const data = await res.json();
        const info = data?.GGSimpleMath;
        return {
          optional: Object.keys(info?.input?.optional ?? {}),
          required: Object.keys(info?.input?.required ?? {}),
          output: info?.output ?? [],
          outputNames: info?.output_name ?? [],
        };
      },
      async executeFlow() {
        // 真机执行：两个 GGInteger 喂 a/b，结果_1 接给下游 GGSimpleMath 的 a，
        // 整条链路跑一遍，验证 * 输出能被下游接住、执行不报错。
        const exprDefaults = () => {
          const inputs = {};
          for (let i = 1; i <= 10; i += 1) inputs[`表达式_${i}`] = String.fromCharCode(96 + i);
          return inputs;
        };
        const payload = {
          1: { class_type: 'GGInteger', inputs: { 整数: 8 } },
          2: { class_type: 'GGInteger', inputs: { 整数: 7 } },
          3: { class_type: 'GGSimpleMath', inputs: { ...exprDefaults(), 表达式_1: 'a*10', 表达式_2: 'b/4', a: ['1', 0], b: ['2', 0] } },
          4: { class_type: 'GGSimpleMath', inputs: { ...exprDefaults(), 表达式_1: 'a+1', a: ['3', 0] } },
          // ComfyUI 要求 prompt 里至少有一个输出节点才肯排队，
          // 用一张 8x8 预览图凑数，与要验证的数值链路无关。
          5: { class_type: 'EmptyImage', inputs: { width: 8, height: 8, batch_size: 1, color: 0 } },
          6: { class_type: 'PreviewImage', inputs: { images: ['5', 0] } },
        };
        const res = await fetch('/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: payload, client_id: 'gg-verify-simple-math' }),
        });
        const ticket = await res.json();
        if (!ticket?.prompt_id) {
          return { error: 'no prompt_id', ticket: JSON.stringify(ticket).slice(0, 300) };
        }
        for (let i = 0; i < 60; i += 1) {
          await new Promise((r) => setTimeout(r, 500));
          const history = await (await fetch(`/history/${ticket.prompt_id}`)).json();
          const entry = history?.[ticket.prompt_id];
          if (entry?.status) {
            return {
              promptId: ticket.prompt_id,
              status: entry.status.status_str,
              completed: entry.status.completed === true,
              outputs: Object.keys(entry.outputs ?? {}),
            };
          }
        }
        return { error: 'timeout', promptId: ticket.prompt_id };
      },
      settle,
    };
  });

  const run = (fn, ...args) => page.evaluate(({ fn, args }) => window.__mathTest[fn](...args), { fn, args });

  // 后端声明
  const info = await run('objectInfo');
  check('后端声明 26 个 a~z 输入', info.optional.length === 26 && info.optional[0] === 'a' && info.optional[25] === 'z', info.optional.join(','));
  check('后端声明 10 条表达式', info.required.length === 10 && info.required[0] === '表达式_1', info.required.join(','));
  check('输出全部为通配数值且不再有 FLOAT 端口',
    info.output.length === 10 && info.output.every((t) => t === '*') && info.outputNames[0] === '结果_1',
    JSON.stringify(info.outputNames));

  // 默认态
  await run('reset');
  const mainId = await run('create');
  let state = await run('state', mainId);
  check('默认 1 个输入 / 1 条表达式 / 2 个输出',
    state.inputs.length === 1 && state.inputs[0].name === 'a'
    && state.exprVisible === 1 && state.outputs.length === 2
    && state.outputs[0].name === '结果_1',
    JSON.stringify(state));
  check('默认输出端口未接线', state.outputs.every((o) => o.links === 0), JSON.stringify(state.outputs));

  // 接第一个输入
  await run('connectInput', mainId, 'a');
  state = await run('state', mainId);
  check('接上 a 后长出 b，表达式仍是 1 条',
    state.inputs.length === 2 && state.inputs[1].name === 'b' && state.exprVisible === 1,
    JSON.stringify({ inputs: state.inputs.map((i) => i.name), expr: state.exprVisible }));

  // 接第二个输入
  await run('connectInput', mainId, 'b');
  state = await run('state', mainId);
  check('接上 b 后长出 c，表达式变 2 条',
    state.inputs.length === 3 && state.inputs[2].name === 'c' && state.exprVisible === 2,
    JSON.stringify({ inputs: state.inputs.map((i) => i.name), expr: state.exprVisible }));

  // 接第 2 个输出 → 第 3 个输出
  await run('connectOutput', mainId, 0);
  await run('connectOutput', mainId, 1);
  state = await run('state', mainId);
  check('接上第 2 个输出后新增第 3 个输出',
    state.outputs.length === 3 && state.outputs[2].name === '结果_3',
    JSON.stringify(state.outputs.map((o) => o.name)));

  // 接第 3 个输出 → 第 4 个输出，表达式同步到 3 条
  await run('connectOutput', mainId, 2);
  state = await run('state', mainId);
  check('接上第 3 个输出后新增第 4 个输出，表达式同步到 3 条',
    state.outputs.length === 4 && state.outputs[3].name === '结果_4' && state.exprVisible === 3,
    JSON.stringify({ outputs: state.outputs.map((o) => o.name), expr: state.exprVisible }));

  // 断线回缩
  await run('disconnectOutput', mainId, 2);
  await run('disconnectOutput', mainId, 1);
  state = await run('state', mainId);
  check('断开输出后尾部槽位回收',
    state.outputs.length <= 3 && state.outputs.every((o) => o.name.startsWith('结果_')),
    JSON.stringify(state.outputs.map((o) => o.name)));

  // 存图往返
  const before = await run('state', mainId);
  await run('roundtrip');
  state = await run('state', mainId);
  check('存图往返后输入 / 表达式 / 输出数量与连线都不变',
    state.inputs.length === before.inputs.length
    && state.exprVisible === before.exprVisible
    && state.outputs.length === before.outputs.length
    && state.inputs.filter((i) => i.linked).length === before.inputs.filter((i) => i.linked).length
    && JSON.stringify(state.exprValues) === JSON.stringify(before.exprValues),
    JSON.stringify({
      before: [before.inputs.length, before.inputs.filter((i) => i.linked).length, before.exprVisible, before.outputs.length],
      after: [state.inputs.length, state.inputs.filter((i) => i.linked).length, state.exprVisible, state.outputs.length],
    }));

  // 旧输出与 FLOAT 连线迁移
  const legacy = await run('legacyMigration');
  check('旧输出迁移成结果_n 且 FLOAT 连线改指结果_1',
    legacy.outputs[0] === '结果_1' && legacy.originSlot === 0 && legacy.linkCount === 1,
    JSON.stringify(legacy));
  const legacyValues = await run('legacyWidgetValues');
  check('旧工作流表达式值原样保留、后 8 条补默认值',
    legacyValues.count === 10
    && legacyValues.values[0] === 'a*c/d'
    && legacyValues.values[1] === 'b*c/d'
    && legacyValues.values[2] === 'c',
    JSON.stringify(legacyValues));

  // 真机执行：结果_1 作为下游输入整条链路跑通
  const runResult = await run('executeFlow');
  check('接线后整图执行成功（结果输出可被下游接住）',
    runResult.status === 'success' && runResult.completed === true,
    JSON.stringify(runResult));

  await page.screenshot({ path: path.join(OUT_DIR, 'simple_math_final.png'), fullPage: false });
  const bad = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ results, bad, consoleErrors }, null, 1));
  console.log(bad.length === 0 && consoleErrors.length === 0
    ? `PASS ${results.length}/${results.length}`
    : `FAIL ${bad.length}/${results.length}`);
  await browser.close();
})();
