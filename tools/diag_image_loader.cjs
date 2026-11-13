// 诊断：GGImageLoad 的 DOM 预览面板为什么不可见 / 快捷按钮去哪了
// 同时做 A-B 对比：带 gg-dom-widget-layer-fix 与移除它之后
const { chromium } = require('playwright');
const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out';

const clip = { x: 40, y: 30, width: 460, height: 520 };

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-loader-${Date.now()}`, {
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1400, height: 1000 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3500);

  const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

  const probe = () =>
    page.evaluate(() => {
      const n = window.__n;
      const host = document.querySelector('.gg-image-loader-preview');
      const acts = document.querySelector('.gg-image-loader-actions');
      const r = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const dw = host?.closest('.dom-widget');
      return {
        nodeSize: [Math.round(n.size[0]), Math.round(n.size[1])],
        widgets: n.widgets.map((w) => ({ name: w.name, type: w.type, y: Math.round(w.y ?? -1), h: w.computedHeight, hasEl: !!w.element })),
        hostExists: !!host,
        hostRect: r(host),
        hostStyle: host ? (host.getAttribute('style') || '').slice(0, 160) : null,
        domWidgetStyle: dw ? (dw.getAttribute('style') || '').replace(/\s+/g, ' ').slice(0, 200) : null,
        domWidgetPos: dw ? getComputedStyle(dw).position : null,
        actionsRect: r(acts),
        actionCount: acts ? acts.children.length : -1,
        actionLabels: acts ? [...acts.children].map((b) => b.textContent) : [],
        fixStylePresent: !!document.getElementById('gg-dom-widget-layer-fix'),
      };
    });

  await page.evaluate(async () => {
    const app = window.app;
    app.graph.clear();
    const n = window.LiteGraph.createNode('GGImageLoad');
    app.graph.add(n);
    n.pos = [60, 40];
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    window.__n = n;
    app.canvas.setDirty(true, true);
    app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 2200));
    app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 800));
  });

  const withFix = await probe();
  await page.screenshot({ path: `${SHOT}/loader_1_with_fix.png`, clip });

  // 移除我们的定位规则，看是否恢复
  await page.evaluate(async () => {
    document.getElementById('gg-dom-widget-layer-fix')?.remove();
    const app = window.app;
    app.canvas.setDirty(true, true);
    app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 1200));
  });
  const noFix = await probe();
  await page.screenshot({ path: `${SHOT}/loader_2_no_fix.png`, clip });

  console.log(JSON.stringify({ withFix, noFix }, null, 2));
  if (errs.length) console.log('PAGEERROR:', errs.slice(0, 4).join('\n'));

  try { await page.evaluate((b) => window.app.loadGraphData(JSON.parse(b)), backup); } catch (_) {}
  await ctx.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
