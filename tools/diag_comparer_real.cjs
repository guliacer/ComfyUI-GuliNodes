// 探针：把两个对比节点的真实形态 dump 出来（控件 / 尺寸 / 端口 / 两种模式）
const { chromium } = require('playwright');
const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out';

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-cmp-${Date.now()}`, {
    headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1500, height: 1100 }, args: ['--no-proxy-server'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3500);
  const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

  const dump = async (type) => page.evaluate(async (t) => {
    const app = window.app;
    app.graph.clear();
    const n = window.LiteGraph.createNode(t);
    if (!n) return { type: t, missing: true };
    app.graph.add(n);
    n.pos = [60, 40];
    app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0];
    app.canvas.setDirty(true, true); app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 1800));
    window.__n = n;
    const w = (x) => ({
      name: x.name, type: x.type, value: typeof x.value === 'object' ? String(x.value) : x.value,
      y: Math.round(x.y ?? -1), h: x.computedHeight,
      on: x.options?.on, off: x.options?.off,
      hidden: !!x.hidden,
    });
    return {
      type: t,
      size: [Math.round(n.size[0]), Math.round(n.size[1])],
      title: n.title,
      widgets: n.widgets.map(w),
      inputs: n.inputs.map((i) => ({ name: i.name, type: i.type, link: i.link })),
      outputs: n.outputs.map((o) => ({ name: o.name, type: o.type })),
      properties: JSON.parse(JSON.stringify(n.properties || {})),
      domCount: document.querySelectorAll('.dom-widget').length,
      domHeights: [...document.querySelectorAll('.dom-widget')].map((e) => Math.round(e.getBoundingClientRect().height)),
    };
  }, type);

  const a = await dump('GGImageComparer2');
  await page.screenshot({ path: `${SHOT}/cmp2_slide.png`, clip: { x: 40, y: 30, width: 480, height: 620 } });

  // 切到 Click
  const clickState = await page.evaluate(async () => {
    const n = window.__n;
    const mode = n.widgets.find((w) => w.name === 'Mode');
    if (!mode) return { missing: true };
    mode.value = true;
    mode.callback?.(true);
    n.setDirtyCanvas?.(true, true);
    window.app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 800));
    return { modeValue: mode.value, on: mode.options?.on, off: mode.options?.off, props: n.properties?.comparer_mode };
  });
  await page.screenshot({ path: `${SHOT}/cmp2_click.png`, clip: { x: 40, y: 30, width: 480, height: 620 } });

  const b = await dump('GGImageComparer4');
  await page.screenshot({ path: `${SHOT}/cmp4_real.png`, clip: { x: 40, y: 30, width: 520, height: 620 } });

  console.log(JSON.stringify({ comparer2: a, clickToggle: clickState, comparer4: b }, null, 2));
  if (errs.length) console.log('PAGEERROR:', errs.slice(0, 3).join('\n'));
  try { await page.evaluate((s) => window.app.loadGraphData(JSON.parse(s)), backup); } catch (_) {}
  await ctx.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
