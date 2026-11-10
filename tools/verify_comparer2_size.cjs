// GG 图像对比 2张：尺寸不再自动收缩的验证
// 覆盖：新建即 260×420、拉伸后保持、对齐内容类写入不缩、
//       小尺寸写入兜底补回、折叠不干扰、老存档小尺寸读档修复。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_comparer2_size.cjs
// 注意：脚本会临时清空画布，结束前把开始时的工作流原样装回。
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
    const findComparer = () => app.graph._nodes.find(
      (n) => n.comfyClass === 'GGImageComparer2' || n.type === 'GGImageComparer2',
    );
    const snapshot = (node) => ({
      size: [Math.round(node.size[0]), Math.round(node.size[1])],
      collapsed: node.flags?.collapsed === true || node.collapsed === true,
    });
    window.__comparer2Test = {
      settle,
      snapshotSaved() {
        // 用户当前工作流先存一份，收尾时原样装回
        return JSON.stringify(app.graph.serialize());
      },
      async fresh() {
        app.graph.clear();
        app.canvas.ds.scale = 1;
        app.canvas.ds.offset = [40, 80];
        await settle();
        const node = window.LiteGraph.createNode('GGImageComparer2');
        app.graph.add(node);
        node.pos = [60, 80];
        await settle();
        await new Promise((r) => setTimeout(r, 400));
        await settle();
        return snapshot(findComparer());
      },
      async stretchKeep() {
        const node = findComparer();
        node.setSize?.([800, 640]);
        await settle();
        await new Promise((r) => setTimeout(r, 400));
        await settle();
        return snapshot(findComparer());
      },
      async snapWrite() {
        // 前端内部「对齐内容」类写入的形状：setSize(computeSize())
        const node = findComparer();
        node.setSize?.(node.computeSize());
        await settle();
        await new Promise((r) => setTimeout(r, 300));
        await settle();
        return snapshot(findComparer());
      },
      async collapsedCheck() {
        const node = findComparer();
        node.collapse?.();
        await settle();
        const collapsedSize = snapshot(findComparer());
        const collapsedCompute = node.computeSize().map((v) => Math.round(v));
        node.collapse?.();
        await settle();
        await new Promise((r) => setTimeout(r, 300));
        await settle();
        return { collapsedSize, collapsedCompute, expanded: snapshot(findComparer()) };
      },
      computeFloor() {
        const node = findComparer();
        return node.computeSize().map((v) => Math.round(v));
      },
      async loadRepair() {
        // 老存档里存过被收小的尺寸（用户截图那种 110×95），读档要补回下限
        const data = app.graph.serialize();
        const entry = data.nodes.find((n) => n.type === 'GGImageComparer2');
        if (!entry) return { error: 'node missing' };
        entry.size = [110, 95];
        app.graph.clear();
        await settle();
        await app.loadGraphData(data);
        await settle();
        await new Promise((r) => setTimeout(r, 400));
        await settle();
        return snapshot(findComparer());
      },
      async restore(saved) {
        await app.loadGraphData(JSON.parse(saved));
        await settle();
      },
    };
  });

  const run = (fn, ...args) => page.evaluate(({ fn, args }) => window.__comparer2Test[fn](...args), { fn, args });

  const saved = await run('snapshotSaved');
  try {
    const fresh = await run('fresh');
    check('新建即 260×420，不再被 autofit 收成小块',
      fresh.size[0] >= 260 && fresh.size[1] >= 420,
      JSON.stringify(fresh));

    const floor = await run('computeFloor');
    check('computeSize 返回值不低于 260×420',
      floor[0] >= 260 && floor[1] >= 420,
      JSON.stringify(floor));

    const stretched = await run('stretchKeep');
    check('拉伸到 800×640 后保持，不再自动缩回',
      stretched.size[0] >= 790 && stretched.size[1] >= 630,
      JSON.stringify(stretched));

    const snapped = await run('snapWrite');
    check('setSize(computeSize()) 对齐内容写入不缩',
      snapped.size[0] >= 790 && snapped.size[1] >= 630,
      JSON.stringify(snapped));

    const collapsed = await run('collapsedCheck');
    check('折叠不改写节点尺寸（展开原样恢复）、computeSize 交回原生折叠尺寸',
      collapsed.collapsedSize.size[0] === collapsed.expanded.size[0]
      && collapsed.collapsedSize.size[1] === collapsed.expanded.size[1]
      && collapsed.collapsedCompute[0] < 260
      && collapsed.collapsedCompute[1] < 260,
      JSON.stringify(collapsed));
    check('展开后恢复到不低于 260×420',
      collapsed.expanded.size[0] >= 260 && collapsed.expanded.size[1] >= 420,
      JSON.stringify(collapsed.expanded));

    const repaired = await run('loadRepair');
    check('老存档 110×95 读档后补回 260×420',
      repaired.size[0] >= 260 && repaired.size[1] >= 420,
      JSON.stringify(repaired));
  } finally {
    // 无论如何把用户的工作流装回去
    await run('restore', saved).catch((e) => consoleErrors.push('restore: ' + String(e)));
  }

  // 结果收尾后截图（画布已恢复用户工作流）
  await page.screenshot({ path: path.join(OUT_DIR, 'comparer2_size_final.png') });
  const bad = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ results, bad, consoleErrors }, null, 1));
  console.log(bad.length === 0 && consoleErrors.length === 0
    ? `PASS ${results.length}/${results.length}`
    : `FAIL ${bad.length}/${results.length}`);
  await browser.close();
})();
