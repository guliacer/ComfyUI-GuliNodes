// 放大 2 倍截图，用来看清控件文字到底有没有省略号。
const path = require('node:path');
const { chromium } = require('playwright-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CLASSES = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1200);
  for (const cls of CLASSES) {
    const box = await page.evaluate(async (cls) => {
      const app = window.app;
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      app.graph.clear();
      app.canvas.ds.scale = 1;
      app.canvas.ds.offset = [40, 80];
      const node = window.LiteGraph.createNode(cls);
      app.graph.add(node);
      node.pos = [50, 80];
      await new Promise((r) => setTimeout(r, 300));
      await tick();
      const rect = app.canvas.canvas.getBoundingClientRect();
      return {
        x: rect.left + node.pos[0] + app.canvas.ds.offset[0] - 8,
        y: rect.top + node.pos[1] - 30 + app.canvas.ds.offset[1],
        width: node.size[0] + 16,
        height: node.size[1] + 40,
      };
    }, cls);
    await page.mouse.move(1500, 1040);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(__dirname, 'out', `zoom_${cls}.png`), clip: box });
    console.log(cls, JSON.stringify(box));
  }
  await browser.close();
})();
