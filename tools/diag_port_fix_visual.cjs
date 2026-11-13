// 视觉验证：复现「输出源消失」并确认修复后恢复
const { chromium } = require('playwright');
const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out';

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-pv-${Date.now()}`, {
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1400, height: 1000 },
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
    const n = window.LiteGraph.createNode('GGInpaintCrop');
    app.graph.add(n);
    n.pos = [60, 40];
    n.title = 'GG 局部重绘裁剪';
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    window.__n = n;
    app.canvas.setDirty(true, true);
    app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 2000));
  });

  const clip = { x: 40, y: 30, width: 420, height: 420 };
  await page.screenshot({ path: `${SHOT}/port_1_normal.png`, clip });

  // 复现用户截图状态：输出被停在节点外
  await page.evaluate(async () => {
    for (const o of window.__n.outputs) o.pos = [4000, 0];
    window.app.canvas.setDirty(true, true);
    window.app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 900));
  });
  await page.screenshot({ path: `${SHOT}/port_2_broken.png`, clip });

  // 修复
  const fixed = await page.evaluate(async () => {
    const ok = window.app.ggRepairPortGeometry(window.__n);
    window.app.canvas.setDirty(true, true);
    window.app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 1200));
    return {
      ok,
      outputs: window.__n.outputs.map((o) => ({ name: o.name, pos: o.pos ?? null })),
    };
  });
  await page.screenshot({ path: `${SHOT}/port_3_fixed.png`, clip });

  console.log(JSON.stringify(fixed, null, 2));

  try { await page.evaluate((b) => window.app.loadGraphData(JSON.parse(b)), backup); } catch (_) {}
  await ctx.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
