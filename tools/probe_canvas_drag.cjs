// 画布平移专项探针：确认 pointerdown 是否到达 canvas、LiteGraph 是否进入拖拽态。
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const canvas = window.app.canvas;
    const el = canvas.canvas;
    const rect = el.getBoundingClientRect();
    const stats = { pointerdown: 0, mousedown: 0, pointermove: 0, target: null };
    el.addEventListener('pointerdown', (e) => {
      stats.pointerdown += 1;
      stats.target = e.target === el ? 'canvas' : (e.target.className || e.target.tagName);
      stats.pointerType = e.pointerType;
      stats.isPrimary = e.isPrimary;
    }, true);
    el.addEventListener('mousedown', () => { stats.mousedown += 1; }, true);
    el.addEventListener('pointermove', () => { stats.pointermove += 1; }, true);
    window.__stats = stats;
    // 找一个确定干净的屏幕点：画布中心偏右下的空白
    const cx = rect.left + rect.width * 0.55;
    const cy = rect.top + rect.height * 0.55;
    return {
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      point: [Math.round(cx), Math.round(cy)],
      hitEl: (document.elementFromPoint(cx, cy) || {}).tagName,
      hitIsCanvas: document.elementFromPoint(cx, cy) === el,
      dragging: canvas.dragging,
      allowDrag: canvas.allow_dragcanvas,
      readOnly: window.app.graph?.read_only,
      offset: [...canvas.ds.offset],
      scale: canvas.ds.scale,
    };
  });

  const [x, y] = info.point;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 300, y + 150, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => ({
    offset: [...window.app.canvas.ds.offset].map((v) => Math.round(v)),
    stats: window.__stats,
    dragging: window.app.canvas.dragging,
  }));

  console.log(JSON.stringify({
    canvasRect: info.rect,
    point: info.point,
    hitIsCanvas: info.hitIsCanvas,
    hitEl: info.hitEl,
    allowDrag: info.allowDrag,
    readOnly: info.readOnly,
    offsetBefore: info.offset.map((v) => Math.round(v)),
    offsetAfter: after.offset,
    delta: [after.offset[0] - Math.round(info.offset[0]), after.offset[1] - Math.round(info.offset[1])],
    events: after.stats,
  }, null, 2));
  await browser.close();
})();
