// GG LoRA 自定义加载：节点高度锁死贴合内容（与 GG LoRA组加载 同一套机制）。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_lora_custom_loader_height.cjs
//
// 覆盖：lockHeightToContent 已生效 / 默认（不同 LoRA 数）底部无大空白 /
//       外部 setSize 顶高后下一帧自行收回 / 拖高不持久化 / 读档冗余高度被锁回 /
//       全程无页面脚本异常。
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NODE_CLASS = 'GGLoRACustomLoader';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); }
function dumpAndExit(error) {
  console.error('SCRIPT ERROR', error);
  checks.forEach((c) => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`));
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} passed (中断)`);
  process.exit(1);
}
process.on('uncaughtException', dumpAndExit);
process.on('unhandledRejection', dumpAndExit);

const OWN_MODULE = /gg-lora-custom-loader|gg-widget-rows|lora_tools|GGLoRACustomLoader/i;
const isOwnModuleError = (text) => OWN_MODULE.test(String(text));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  const externalNoise = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error' || /Failed to load resource/.test(m.text())) return;
    const text = m.text();
    if (!isOwnModuleError(text)) { externalNoise.push('console: ' + text); return; }
    errors.push('console: ' + text);
  });

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  await page.evaluate(async (nodeClass) => {
    const app = window.app;
    window.__ggSavedGraph = app.graph.serialize();
    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [40, 60];
    const node = window.LiteGraph.createNode(nodeClass);
    app.graph.add(node);
    node.pos = [60, 60];
    await new Promise((r) => setTimeout(r, 1200));
    app.canvas.draw(true, true);
    window.__ggNode = node;
  }, NODE_CLASS);

  const setCount = (n) => page.evaluate(async (n) => {
    const app = window.app;
    const node = window.__ggNode;
    const count = node.widgets.find((w) => w.name === 'LoRA数量');
    count.value = n;
    count.callback?.(n);
    await new Promise((r) => setTimeout(r, 400));
    node.arrange?.();
    app.canvas.draw(true, true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, n);

  const readState = () => page.evaluate((nodeClass) => {
    const app = window.app;
    const node = (app.graph._nodes ?? []).find((n) => n?.comfyClass === nodeClass);
    window.__ggNode = node;
    if (!node) return null;
    app.canvas.draw(true, true);
    let lastBottom = 0;
    let visible = 0;
    for (const w of node.widgets ?? []) {
      if (w.hidden || String(w.type ?? '').startsWith('ggHidden')) continue;
      visible += 1;
      const bottom = (Number(w.y) || 0) + (Number(w.computedHeight) || 24);
      if (bottom > lastBottom) lastBottom = bottom;
    }
    const st = node._ggRowLayout ?? {};
    return {
      size: [...node.size],
      visible,
      lastBottom,
      gap: (Number(node.size[1]) || 0) - lastBottom,
      lockHeight: st.config?.lockHeightToContent === true,
      manualHeightFlag: node._ggRowLayoutManualHeight ?? null,
      userSize: Array.isArray(node.properties?._ggRowUserSize)
        ? [...node.properties._ggRowUserSize] : null,
    };
  }, NODE_CLASS);

  // 1) lockHeightToContent 已生效
  let st = await readState();
  check('节点已登记 lockHeightToContent（高度锁生效）', st && st.lockHeight === true, st);

  // 2) 不同 LoRA 数下默认高度贴合内容（底部不留大空白）
  for (const n of [0, 1, 3, 8]) {
    await setCount(n);
    await sleep(1600); // 留出每帧 applyHeight 的回收窗口
    st = await readState();
    check(`LoRA数量=${n} 时底部无大空白（gap≤50 且高度<260）`,
      st && st.gap <= 50 && st.size[1] < 260,
      { size: st?.size, gap: st?.gap, visible: st?.visible });
  }

  // 当前 content 高度（用于后续对比）
  const contentH = (await readState()).size[1];

  // 3) 外部 setSize 把高度顶高（不触发 onResize），下一帧高度锁自行收回
  await page.evaluate(() => {
    const node = window.__ggNode;
    node.size[1] = node.size[1] + 150; // 直接改数组，绕过 onResize，模拟「外部 / 折叠残留」
    window.app.canvas.draw(true, true);
  });
  await sleep(2500);
  st = await readState();
  check('外部 setSize 顶高后高度锁自行收回贴合内容（不残留空白）',
    st && Math.abs(st.size[1] - contentH) <= 16,
    { beforeTall: contentH + 150, after: st?.size });

  // 4) 拖高（resizing_node 期间）→ 松手后不持久化
  await page.evaluate(() => {
    const app = window.app;
    const node = window.__ggNode;
    app.canvas.resizing_node = node;
    node.size[1] = node.size[1] + 170;
    app.canvas.draw(true, true);
  });
  await sleep(400);
  await page.evaluate(() => {
    const app = window.app;
    const node = window.__ggNode;
    app.canvas.resizing_node = null;
    node.size[1] = node.size[1] + 170; // 松手瞬间的尺寸
    app.canvas.draw(true, true);
  });
  await sleep(2500);
  st = await readState();
  check('拖高不持久化：松手后高度回到内容高、无手动高度标记',
    st && Math.abs(st.size[1] - contentH) <= 16 && st.manualHeightFlag == null,
    { after: st?.size, manualHeightFlag: st?.manualHeightFlag, userSize: st?.userSize });

  // 5) 读档时老存档冗余高度被锁回内容高度（用「小节点 + 明显过大存档高」排除歧义）
  await setCount(1);
  await sleep(1600);
  const baseH = (await readState()).size[1]; // 1 个 LoRA 的内容高度
  await page.evaluate(async (tamperH) => {
    const app = window.app;
    const node = window.__ggNode;
    const g = app.graph.serialize();
    const n = g.nodes.find((x) => String(x.id) === String(node.id));
    n.size = [node.size[0], tamperH]; // 篡改存档高度为明显冗余的大值
    app.loadGraphData(g);
    await new Promise((r) => setTimeout(r, 200));
    app.canvas.draw(true, true);
  }, baseH + 150);
  await sleep(2500);
  st = await readState();
  check('读档冗余高度被锁回内容高度（不残留、不持久化）',
    st && Math.abs(st.size[1] - baseH) <= 16 && st.size[1] < baseH + 60,
    { baseH, tamperedTo: baseH + 150, after: st?.size, gap: st?.gap });

  // 6) 全程无页面脚本异常（外部扩展启动噪音单独归类）
  const ownErrors = errors.filter(isOwnModuleError);
  check('全程无本模块页面脚本异常',
    ownErrors.length === 0 && errors.length === 0,
    { errors, externalNoiseCount: externalNoise.length });
  if (externalNoise.length) {
    console.log(`（环境噪音 console error 已单独归类，共 ${externalNoise.length} 条，不计入异常）`);
  }

  // 还原现场
  await page.evaluate(async () => {
    const app = window.app;
    if (window.__ggSavedGraph) app.loadGraphData(window.__ggSavedGraph);
  });

  let pass = 0;
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`);
    if (c.ok) pass += 1;
  }
  console.log(`\n${pass}/${checks.length} passed`);
  await browser.close();
  process.exit(pass === checks.length ? 0 : 1);
})();
