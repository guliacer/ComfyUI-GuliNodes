// GG 图像压缩保存 流式布局放大截图：默认 / 拖宽 / 拖窄。
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, 'out');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 2400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const setup = await page.evaluate(async () => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    app.graph.clear();
    app.canvas.ds.scale = 2;
    app.canvas.ds.offset = [40, 40];
    const node = window.LiteGraph.createNode('GGImageCompressSave');
    app.graph.add(node);
    node.pos = [40, 40];
    await tick(); await tick(); await tick();
    const rect = app.canvas.canvas.getBoundingClientRect();
    const ds = app.canvas.ds;
    return {
      x: rect.left + (node.pos[0] + ds.offset[0]) * ds.scale,
      y: rect.top + (node.pos[1] + ds.offset[1]) * ds.scale,
      scale: ds.scale,
      size: [node.size[0], node.size[1]],
    };
  });

  const shot = async (name) => {
    const box = await page.evaluate(() => {
      const node = window.app.graph._nodes[0];
      const rect = window.app.canvas.canvas.getBoundingClientRect();
      const ds = window.app.canvas.ds;
      return {
        x: rect.left + (node.pos[0] + ds.offset[0]) * ds.scale,
        y: rect.top + (node.pos[1] + ds.offset[1]) * ds.scale,
        w: node.size[0] * ds.scale,
        h: node.size[1] * ds.scale,
      };
    });
    await page.mouse.move(2300, 800);
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(OUT, name),
      clip: { x: box.x - 10, y: box.y - 12, width: box.w + 20, height: box.h + 24 },
    });
  };

  await shot('compress_default.png');

  const resize = async (w, h) => page.evaluate(async ([width, height]) => {
    const app = window.app;
    const node = app.graph._nodes[0];
    app.canvas.resizing_node = node;
    node.setSize([width, height]);
    app.canvas.resizing_node = null;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, [w, h]);

  await resize(384, 168);
  await shot('compress_wide384.png');
  await resize(430, 168);
  await shot('compress_wide430.png');
  await resize(620, 168);
  await shot('compress_wide620.png');
  await resize(220, 240);
  await shot('compress_narrow220.png');
  await resize(244, 320);
  await shot('compress_tall320.png');

  console.log(JSON.stringify({ setup, errors }, null, 2));
  await browser.close();
})();
