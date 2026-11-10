// GG 图像压缩保存 布局探针：控件、行、宽度、拖高/拖宽后的实际尺寸。
// NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules node tools/probe_compress_save.cjs
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, 'out');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const snap = await page.evaluate(async () => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [60, 90];
    const node = window.LiteGraph.createNode('GGImageCompressSave');
    app.graph.add(node);
    node.pos = [60, 90];
    await tick(); await tick(); await tick();

    const state = node._ggRowLayout;
    const read = (label) => ({
      label,
      size: [Math.round(node.size[0]), Math.round(node.size[1])],
      minWidth: state?.minWidth,
      stateHeight: state?.height,
      flexible: state?.flexible,
      manualSize: node._ggAutoFitManualSize ?? null,
      manualW: node._ggRowLayoutManualWidth ?? null,
      manualH: node._ggRowLayoutManualHeight ?? null,
      lockedSize: node._ggCompressSaveSize ?? null,
      rows: (state?.rows ?? []).map((row) => row.map((w) => ({
        name: w.name, label: w.label, value: String(w._displayValue ?? w.value ?? ''),
        x: Math.round(w._ggCol?.x ?? -1), w: Math.round(w._ggCol?.w ?? -1),
        y: Math.round(w.y ?? -1),
      }))),
    });

    const out = { widgets: (node.widgets ?? []).map((w) => ({
      name: w.name, label: w.label, type: w.type, value: String(w._displayValue ?? w.value ?? ''),
      hidden: !!w.hidden, hasLayoutSize: typeof w.computeLayoutSize === 'function',
    })) };
    out.initial = read('initial');

    // 用户拖高：让画布认为正在拖拽这个节点，再 setSize（setSize 内部触发 onResize）
    app.canvas.resizing_node = node;
    node.setSize([node.size[0], 320]);
    app.canvas.resizing_node = null;
    await tick(); await tick(); await tick();
    out.afterDragTall = read('afterDragTall');

    // 用户拖宽
    app.canvas.resizing_node = node;
    node.setSize([620, 320]);
    app.canvas.resizing_node = null;
    await tick(); await tick(); await tick();
    out.afterDragWide = read('afterDragWide');

    // 用户拖窄
    app.canvas.resizing_node = node;
    node.setSize([220, 320]);
    app.canvas.resizing_node = null;
    await tick(); await tick(); await tick();
    out.afterDragNarrow = read('afterDragNarrow');
    return out;
  });

  console.log(JSON.stringify({ ...snap, errors }, null, 2));
  await browser.close();
})();
