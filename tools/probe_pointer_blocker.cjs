// 定位是谁在捕获阶段吞掉了 pointerdown：给 stopPropagation 打桩记录调用栈。
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WORKFLOW =
  'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/user/default/workflows/GG-人像背景分区编辑_Qwen2.1_Turbo.json';
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });

  const workflow = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));

  // 先在不加载工作流的状态下测一次，对比基线
  const baseline = await page.evaluate(() => {
    window.__ev = { down: 0 };
    window.app.canvas.canvas.addEventListener('pointerdown', () => { window.__ev.down += 1; }, true);
    return true;
  });

  const point = await page.evaluate(() => {
    const r = window.app.canvas.canvas.getBoundingClientRect();
    return [Math.round(r.left + r.width * 0.6), Math.round(r.top + r.height * 0.55)];
  });
  await page.mouse.move(point[0], point[1]);
  await page.mouse.down();
  await page.mouse.up();
  const baseCount = await page.evaluate(() => window.__ev.down);

  // 加载工作流后重测
  await page.evaluate(async (wf) => { await window.app.loadGraphData(wf, true, true); }, workflow);
  await page.waitForTimeout(1200);

  const after = await page.evaluate(() => {
    window.__ev.down = 0;
    window.__stops = [];
    const orig = Event.prototype.stopPropagation;
    Event.prototype.stopPropagation = function () {
      if (this.type === 'pointerdown') {
        window.__stops.push(String(this.target?.tagName) + '\n' + new Error().stack.split('\n').slice(1, 9).join('\n'));
      }
      return orig.call(this);
    };
    return { point: null };
  });

  const point2 = await page.evaluate(() => {
    const r = window.app.canvas.canvas.getBoundingClientRect();
    return [Math.round(r.left + r.width * 0.6), Math.round(r.top + r.height * 0.55)];
  });
  await page.mouse.move(point2[0], point2[1]);
  await page.mouse.down();
  await page.mouse.move(point2[0] + 200, point2[1] + 100, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  const result = await page.evaluate(() => ({
    downCount: window.__ev.down,
    stops: window.__stops,
    offset: window.app.canvas.ds.offset.map((v) => Math.round(v)),
  }));

  console.log(JSON.stringify({
    baselinePointerdownBeforeLoad: baseCount,
    afterLoadPointerdown: result.downCount,
    stopCalls: result.stops.length,
    stopStacks: result.stops.slice(0, 3),
    offsetAfter: result.offset,
  }, null, 2));
  await browser.close();
})();
