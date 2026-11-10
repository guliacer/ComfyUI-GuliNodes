// 探针：看 GG 图像宽高 在四个模式下实际有哪些控件、标签宽多少、折成几行。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/probe_ar_rows.cjs
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MODES = ['按边长', '按K数分辨率', '按Latent接入', '按图像接入'];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
  });

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const report = [];
  for (const mode of MODES) {
    const info = await page.evaluate(async (mode) => {
      const app = window.app;
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      app.graph.clear();
      const node = window.LiteGraph.createNode('GGAspectRatioAdapter');
      app.graph.add(node);
      await tick();
      const modeWidget = node.widgets.find((w) => String(w.name).endsWith('宽高方式'));
      if (modeWidget) {
        modeWidget.setValue?.(mode, { e: null, node, canvas: app.canvas });
      }
      await tick();
      await tick();
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = '12px Inter, sans-serif';
      return {
        size: [Math.round(node.size[0]), Math.round(node.size[1])],
        widgets: node.widgets.map((w) => ({
          name: w.name,
          label: w.label,
          shown: (() => { try { return node.isWidgetRowVisible ? node.isWidgetRowVisible(w) : true; } catch { return true; } })(),
          type: w.type,
          y: Math.round(w.y),
          value: String(w.value).slice(0, 20),
          labelWidth: Math.round(ctx.measureText(String(w.label ?? w.name)).width),
          col: w._ggCol ? [Math.round(w._ggCol.x), Math.round(w._ggCol.w)] : null,
        })),
        rows: (node._ggRowLayout?.rows ?? []).map((row) => row.map((w) => w.label || w.name)),
      };
    }, mode);
    report.push({ mode, ...info });
  }

  console.log(JSON.stringify({ report, errors }, null, 1));
  await browser.close();
})();
