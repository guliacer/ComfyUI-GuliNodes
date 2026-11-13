// 诊断：面板在不同节点位置下是否跟得住（验证 position:fixed 方案是否引入偏移）
const { chromium } = require('playwright');
const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out';

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-lp-${Date.now()}`, {
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1500, height: 1000 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3500);

  const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

  await page.evaluate(async () => {
    const app = window.app;
    app.graph.clear();
    const n = window.LiteGraph.createNode('GGImageLoad');
    app.graph.add(n);
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    window.__n = n;
    await new Promise((r) => setTimeout(r, 1800));
  });

  const probe = async (pos) => {
    await page.evaluate(async (p) => {
      const app = window.app;
      const n = window.__n;
      n.pos = [p[0], p[1]];
      app.canvas.setDirty(true, true);
      app.canvas.draw(true, true);
      await new Promise((r) => setTimeout(r, 1000));
      app.canvas.draw(true, true);
      await new Promise((r) => setTimeout(r, 500));
    }, pos);

    return page.evaluate(() => {
      const n = window.__n;
      const app = window.app;
      const host = document.querySelector('.gg-image-loader-preview');
      const dw = host?.closest('.dom-widget');
      const gcc = document.querySelector('.graph-canvas-container').getBoundingClientRect();
      const ds = app.canvas.ds;
      const b = host?.getBoundingClientRect();
      const dws = dw ? getComputedStyle(dw) : null;
      // 期望：host 落在节点内，节点右上角 + 标题高 + widget.y
      const expX = gcc.left + (n.pos[0] + ds.offset[0]) * ds.scale;
      const expY = gcc.top + (n.pos[1] + ds.offset[1]) * ds.scale;
      const widget = n.widgets.find((w) => w.name === 'gg_image_loader_preview');
      return {
        pos: [Math.round(n.pos[0]), Math.round(n.pos[1])],
        scale: ds.scale,
        nodeScreen: { x: Math.round(expX), y: Math.round(expY) },
        hostRect: b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null,
        domPos: dws?.position,
        domLeft: dw ? dw.style.left : null,
        domTop: dw ? dw.style.top : null,
        widgetY: Math.round(widget?.y ?? -1),
        // host 右上角相对节点左上角的偏移，应约等于 (margin, 标题高 + widget.y)
        offsetInNode: b ? { dx: Math.round(b.x - expX), dy: Math.round(b.y - expY) } : null,
        visible: b ? b.width > 0 && b.height > 0 : false,
      };
    });
  };

  const out = {};
  for (const [key, pos] of Object.entries({ a_左上: [60, 60], b_中间: [520, 320], c_右下: [980, 620], d_负坐标: [-200, 300] })) {
    out[key] = await probe(pos);
  }

  console.log(JSON.stringify(out, null, 2));

  // 在画布中间位置截一张，肉眼核对
  await probe([520, 320]);
  await page.screenshot({ path: `${SHOT}/loader_pos_mid.png`, clip: { x: 460, y: 260, width: 480, height: 620 } });

  try { await page.evaluate((b) => window.app.loadGraphData(JSON.parse(b)), backup); } catch (_) {}
  await ctx.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
