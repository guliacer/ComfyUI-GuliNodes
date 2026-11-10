// GG 图像对比 N张：高度不再自动伸长的验证
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_comparer_height.cjs
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

  await page.evaluate(() => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const settle = async () => {
      for (let i = 0; i < 4; i += 1) await tick();
      await new Promise((r) => setTimeout(r, 250));
      for (let i = 0; i < 2; i += 1) await tick();
    };
    window.__comparerTest = {
      async fresh() {
        app.graph.clear();
        app.canvas.ds.scale = 1;
        app.canvas.ds.offset = [40, 80];
        await settle();
        const node = window.LiteGraph.createNode('GGImageComparer4');
        app.graph.add(node);
        node.pos = [60, 80];
        await settle();
        await new Promise((r) => setTimeout(r, 300));
        await settle();
        return this.snapshot(node);
      },
      snapshot(node) {
        const visible = (node.widgets ?? []).filter(
          (w) => !w.hidden && !String(w.type ?? '').startsWith('ggHidden'),
        );
        return {
          size: [Math.round(node.size[0]), Math.round(node.size[1])],
          visibleWidgets: visible.map((w) => w.name),
          imageInputs: node.inputs.filter((i) => !i.widget && String(i.name).startsWith('图像_')).map((i) => i.name),
          minFloor: node._ggAutoFitMinWidth ?? null,
        };
      },
      async loadWithTallSize() {
        const data = app.graph.serialize();
        const entry = data.nodes.find((n) => n.type === 'GGImageComparer4');
        if (!entry) return { error: 'node missing' };
        // 老工作流里存的是 widget 全可见时撑出来的高度（截图里 820 那种空白）
        entry.size = [250, 820];
        app.graph.clear();
        await settle();
        await app.loadGraphData(data);
        await settle();
        await new Promise((r) => setTimeout(r, 400));
        await settle();
        const node = app.graph.getNodeById(entry.id);
        return this.snapshot(node);
      },
      async manualKeep() {
        const node = app.graph._nodes.find((n) => n.comfyClass === 'GGImageComparer4' || n.type === 'GGImageComparer4');
        if (!node) return { error: 'node missing' };
        node._ggAutoFitManualSize = [Math.round(node.size[0]), 500];
        node.size[1] = 500;
        node.onResize?.(node.size);
        await settle();
        await new Promise((r) => setTimeout(r, 300));
        await settle();
        return this.snapshot(node);
      },
      async connectTwo() {
        const node = app.graph._nodes.find((n) => n.comfyClass === 'GGImageComparer4' || n.type === 'GGImageComparer4');
        if (!node) return { error: 'node missing' };
        node._ggAutoFitManualSize = null;
        // 图像输入要接 IMAGE 输出，GGInteger 的 INT 连不上
        const src = window.LiteGraph.createNode('EmptyImage');
        app.graph.add(src);
        src.pos = [-320, 60];
        const src2 = window.LiteGraph.createNode('EmptyImage');
        app.graph.add(src2);
        src2.pos = [-320, 180];
        await settle();
        const slotA = node.inputs.findIndex((i) => !i.widget && i.name === '图像_A');
        src.connect(0, node, slotA);
        await settle();
        // 接上 A 之后应当长出 图像_B 空槽
        const slotB = node.inputs.findIndex((i) => !i.widget && i.name === '图像_B');
        if (slotB >= 0) src2.connect(0, node, slotB);
        await settle();
        const two = this.snapshot(node);
        // 断开后尾部空槽由 normalizeComparerInputs 自己回收
        src.disconnectOutput?.(0);
        src2.disconnectOutput?.(0);
        await settle();
        await new Promise((r) => setTimeout(r, 300));
        await settle();
        const after = this.snapshot(node);
        return { two, after };
      },
      settle,
    };
  });

  const run = (fn, ...args) => page.evaluate(({ fn, args }) => window.__comparerTest[fn](...args), { fn, args });

  // 会话保护：脚本要清空画布，先把用户当前工作流存下来，收尾原样装回
  const savedGraph = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));
  try {
    await runTests();
  } finally {
    await page.evaluate((saved) => window.app.loadGraphData(JSON.parse(saved)), savedGraph).catch(() => {});
  }

  async function runTests() {
    const fresh = await run('fresh');
  check('新建即紧凑：高度贴内容、没有大片空白',
    fresh.size[1] <= 200 && fresh.size[1] >= 120,
    JSON.stringify(fresh));
  check('新建时只留一个图像输入与一个标签',
    fresh.imageInputs.length === 1 && fresh.imageInputs[0] === '图像_A' && fresh.visibleWidgets.includes('标签_A'),
    JSON.stringify(fresh));
  check('宽度下限按「标签 + 数值 + 90」量出来，数值不被切',
    Number(fresh.minFloor) >= 150 && fresh.size[0] >= Number(fresh.minFloor),
    JSON.stringify(fresh));

  const loaded = await run('loadWithTallSize');
  check('老存档 820 高的节点加载后收回内容高',
    loaded.size[1] <= 200 && loaded.size[1] >= 120,
    JSON.stringify(loaded));

  const manual = await run('manualKeep');
  check('用户手动拖高之后不再收（只增不减）',
    manual.size[1] === 500,
    JSON.stringify(manual));

  const wired = await run('connectTwo');
  check('接上图像后长出空槽、标签跟到接线的槽位、断开后回收',
    wired.two
    && wired.two.imageInputs.length >= 2
    && wired.two.visibleWidgets.includes('标签_A')
    && wired.two.visibleWidgets.includes('标签_B')
    && wired.after
    && wired.after.imageInputs.length === 1,
    JSON.stringify(wired));
  }

  await page.screenshot({ path: path.join(OUT_DIR, 'comparer_height_final.png') });
  const bad = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ results, bad, consoleErrors }, null, 1));
  console.log(bad.length === 0 && consoleErrors.length === 0
    ? `PASS ${results.length}/${results.length}`
    : `FAIL ${bad.length}/${results.length}`);
  await browser.close();
})();
