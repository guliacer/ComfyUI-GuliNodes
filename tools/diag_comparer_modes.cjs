// 真机取证：GG 图像对比 2张 的两种模式（Slide / Click）到底长什么样
// A 图取 input 目录里的真实照片，B 图在 canvas 里调一版（提亮+偏暖），
// 这样两张同构图不同调 —— 正是对比节点的实际用法。
const { chromium } = require('playwright');
const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out';

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-cmpm-${Date.now()}`, {
    headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1200, height: 900 }, args: ['--no-proxy-server'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(4000);
  const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

  const info = await page.evaluate(async () => {
    const app = window.app;
    app.graph.clear();
    const n = window.LiteGraph.createNode('GGImageComparer2');
    app.graph.add(n);
    n.pos = [80, 60];
    app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0];
    app.canvas.setDirty(true, true); app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 1800));
    window.__n = n;

    // 取 input 目录第一张图，B 图做提亮+暖调
    const oi = await (await fetch('/object_info/GGImageLoad')).json();
    const files = oi.GGImageLoad.input.required['图像'][1].options;
    const name = files.find((f) => /\.(png|jpe?g|webp)$/i.test(f));
    const url = `/view?filename=${encodeURIComponent(name)}&type=input&subfolder=`;
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const a = await load(url);
    const cv = document.createElement('canvas');
    cv.width = a.naturalWidth; cv.height = a.naturalHeight;
    const cx = cv.getContext('2d');
    cx.drawImage(a, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      px[i] = Math.min(255, px[i] * 1.12 + 14);
      px[i + 1] = Math.min(255, px[i + 1] * 1.06 + 6);
      px[i + 2] = Math.min(255, px[i + 2] * 0.94);
    }
    cx.putImageData(d, 0, 0);
    const b = await load(cv.toDataURL('image/png'));

    n.ggComparer.imgs[0] = a;
    n.ggComparer.imgs[1] = b;
    n.setDirtyCanvas(true, true); app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 600));
    return { file: name, size: [Math.round(n.size[0]), Math.round(n.size[1])], imgs: n.ggComparer.imgs.length, mode: n.ggComparer.comparerMode };
  });
  const clip = { x: 60, y: 40, width: 320, height: 500 };

  // ---- Slide：鼠标悬停在 35% 处 ----
  await page.evaluate(async () => {
    const n = window.__n, app = window.app;
    n.ggComparer.comparerMode = 'Slide';
    n.ggComparer.isPointerOver = true;
    n.ggComparer.pointerPos = [n.pos[0] + 90, n.pos[1] + 240];
    n.setDirtyCanvas(true, true); app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 500));
  });
  await page.screenshot({ path: `${SHOT}/cmp_mode_slide.png`, clip });

  // ---- Click：未按下 / 按下 ----
  await page.evaluate(async () => {
    const n = window.__n, app = window.app;
    n.ggComparer.comparerMode = 'Click';
    n.ggComparer.isPointerOver = false;
    app.canvas.pointer_is_down = false;
    n.setDirtyCanvas(true, true); app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 400));
  });
  await page.screenshot({ path: `${SHOT}/cmp_mode_click_up.png`, clip });

  await page.evaluate(async () => {
    const n = window.__n, app = window.app;
    app.canvas.pointer_is_down = true;
    n.setDirtyCanvas(true, true); app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 400));
    app.canvas.pointer_is_down = false;
  });
  await page.screenshot({ path: `${SHOT}/cmp_mode_click_down.png`, clip });

  // ---- 空态 ----
  await page.evaluate(async () => {
    const n = window.__n, app = window.app;
    n.ggComparer.imgs = [];
    n.ggComparer.comparerMode = 'Slide';
    n.setDirtyCanvas(true, true); app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 400));
  });
  await page.screenshot({ path: `${SHOT}/cmp_mode_empty.png`, clip });

  console.log(JSON.stringify({ info, errors: errs.slice(0, 3) }, null, 2));
  try { await page.evaluate((s) => window.app.loadGraphData(JSON.parse(s)), backup); } catch (_) {}
  await ctx.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
