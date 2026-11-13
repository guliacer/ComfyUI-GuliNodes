// 真机视觉探针：创建视频节点，截图，确认输出端口是否真的画出来
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8188/';
const OUT = 'C:/Users/Admin/.workbuddy/clipboard-images/diag_video_nodes.png';

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-vdiag-${Date.now()}`, {
    headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 900, height: 700 }, args: ['--no-proxy-server'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(4000);

  const report = await page.evaluate(() => {
    const app = window.app;
    app.graph.clear();
    const make = (t) => { const n = window.LiteGraph.createNode(t); app.graph.add(n); return n; };
    const a = make('GGVideoLoad'); a.pos = [40, 40];
    const b = make('GGVideoLoadByPath'); b.pos = [300, 40];
    const c = make('GGVideoSave'); c.pos = [560, 40];
    app.canvas.setDirty(true, true);
    return (app.graph._nodes || []).map((n) => ({
      type: n.comfyClass,
      w: Math.round(n.size[0]), h: Math.round(n.size[1]),
      outs: (n.outputs || []).map((o) => o.name),
      ins: (n.inputs || []).map((i) => i.name),
    }));
  });
  console.log('NODES', JSON.stringify(report, null, 2));
  await page.waitForTimeout(1500);

  // 截图整个画布区域
  const canvas = await page.$('#graph-canvas, canvas');
  await page.screenshot({ path: OUT });
  console.log('SCREENSHOT', OUT);
  console.log('PAGEERRORS', pageErrors.slice(0, 5).join(' | ') || 'none');
  await ctx.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
