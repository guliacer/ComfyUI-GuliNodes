// 复现用户场景：老工作流里视频节点输出端口被停到节点外（[4000,0]），
// 走真实 loadGraphData 加载，截图确认端口是否真的画出来。
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8188/';
const OUT = 'C:/Users/Admin/.workbuddy/clipboard-images/diag_video_loaded.png';

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-vloaded-${Date.now()}`, {
    headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 900, height: 700 }, args: ['--no-proxy-server'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(4000);

  // 1) 造一份“坏”图：输出端口停到外面
  await page.evaluate(() => {
    const app = window.app;
    app.graph.clear();
    const make = (t, x) => { const n = window.LiteGraph.createNode(t); app.graph.add(n); n.pos = [x, 40]; return n; };
    const a = make('GGVideoLoad', 40);
    const b = make('GGVideoLoadByPath', 300);
    a.outputs.forEach((o) => { o.pos = [4000, 0]; });
    b.outputs.forEach((o) => { o.pos = [4000, 0]; });
    window.__badGraph = app.graph.serialize();
  });

  // 2) 真实加载路径
  const report = await page.evaluate(() => {
    const app = window.app;
    app.graph.clear();
    app.loadGraphData(window.__badGraph);
    return true;
  });
  await page.waitForTimeout(2500);

  const after = await page.evaluate(() => {
    const app = window.app;
    return (app.graph._nodes || []).map((n) => ({
      type: n.comfyClass,
      w: Math.round(n.size[0]), h: Math.round(n.size[1]),
      outs: (n.outputs || []).map((o) => ({ name: o.name, pos: o.pos ? [Math.round(o.pos[0]), Math.round(o.pos[1])] : null })),
    }));
  });
  console.log('AFTER LOAD', JSON.stringify(after, null, 2));

  await page.screenshot({ path: OUT });
  console.log('SCREENSHOT', OUT);
  console.log('PAGEERRORS', pageErrors.slice(0, 5).join(' | ') || 'none');
  await ctx.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
