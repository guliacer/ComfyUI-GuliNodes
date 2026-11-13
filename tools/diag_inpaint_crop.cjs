// 诊断：GGInpaintCrop 输出端口为什么不显示
const { chromium } = require('playwright');
const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out';

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-inpaint-${Date.now()}`, {
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1400, height: 1000 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3000);

  const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

  const out = await page.evaluate(async () => {
    const app = window.app;
    app.graph.clear();
    const mk = (cls) => {
      const n = window.LiteGraph.createNode(cls);
      app.graph.add(n);
      return n;
    };
    const crop = mk('GGInpaintCrop');
    crop.pos = [80, 80];
    const ref = mk('GG图像缩放');
    ref.pos = [520, 80];
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    await new Promise((r) => setTimeout(r, 2000));
    app.canvas.setDirty(true, true);
    app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 800));

    const dump = (n) => ({
      cls: n.comfyClass || n.type,
      title: n.title,
      pos: [Math.round(n.pos[0]), Math.round(n.pos[1])],
      size: [Math.round(n.size[0]), Math.round(n.size[1])],
      inputs: (n.inputs || []).map((i) => ({
        name: i.name, type: i.type, slot: i.slot_index,
        y: Math.round(i.pos?.[1] ?? -1), hasWidget: !!i.widget, link: i.link,
      })),
      outputs: (n.outputs || []).map((o) => ({
        name: o.name, type: o.type, slot: o.slot_index,
        y: Math.round(o.pos?.[1] ?? -1), links: (o.links || []).length,
      })),
      flags: {
        hidden: n._ggPortListHidden === true,
        drawingHidden: n._ggPortListDrawingHidden === true,
        rowLayout: !!n._ggRowLayout,
        rowLayoutKeys: n._ggRowLayout ? Object.keys(n._ggRowLayout) : null,
        collapsed: n.flags?.collapsed,
        noOutput: n.properties?.no_output,
      },
      widgets: (n.widgets || []).map((w) => ({ n: w.name, t: w.type, y: Math.round(w.y ?? -1), h: w.computedHeight })),
    });

    return { crop: dump(crop), ref: dump(ref) };
  });

  console.log(JSON.stringify(out, null, 2));
  if (errs.length) console.log('PAGEERROR:', errs.slice(0, 3).join('\n'));

  await page.screenshot({ path: `${SHOT}/diag_inpaint_crop.png`, clip: { x: 0, y: 0, width: 1000, height: 800 } });

  try { await page.evaluate((b) => window.app.loadGraphData(JSON.parse(b)), backup); } catch (_) {}
  await ctx.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
