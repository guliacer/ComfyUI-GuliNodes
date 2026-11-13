// 取证：视频节点输出端口画没画出来（数据在、看不见 = 绘制层问题）
const { chromium } = require('playwright');
const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out';
(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-vpv-${Date.now()}`, {
    headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1500, height: 800 }, args: ['--no-proxy-server'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(4000);
  const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));
  const res = await page.evaluate(async () => {
    const app = window.app;
    app.graph.clear();
    const types = ['GGVideoLoad', 'GGVideoLoadByPath', 'GGVideoCompress'];
    const nodes = [];
    let x = 60;
    for (const t of types) {
      const n = window.LiteGraph.createNode(t);
      if (!n) continue;
      app.graph.add(n); n.pos = [x, 60]; x += 300;
      nodes.push(n);
    }
    app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0];
    app.canvas.setDirty(true, true);
    app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 1200));
    app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 400));
    return nodes.map((n) => ({
      type: n.comfyClass,
      size: [Math.round(n.size[0]), Math.round(n.size[1])],
      outPos: (n.outputs || []).map((o) => o.pos ? [Math.round(o.pos[0]), Math.round(o.pos[1])] : null),
      inPos: (n.inputs || []).slice(0, 3).map((i) => i.pos ? [Math.round(i.pos[0]), Math.round(i.pos[1])] : null),
    }));
  });
  await page.screenshot({ path: `${SHOT}/video_ports_new.png`, clip: { x: 30, y: 30, width: 900, height: 560 } });
  console.log(JSON.stringify(res, null, 2));
  try { await page.evaluate((s) => window.app.loadGraphData(JSON.parse(s)), backup); } catch (_) {}
  await ctx.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
