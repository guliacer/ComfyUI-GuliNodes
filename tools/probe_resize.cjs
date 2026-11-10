// 节点尺寸归属全场景探针：真实鼠标拖大 → 拖小 → 拖窄 → 值变化 → 读档，
// 每步记录尺寸与手动标记，找出「拖完弹回」的具体环节。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/probe_resize.cjs [--json]
const { chromium } = require('playwright-core');

const CLASSES = [
  'GGZImageSampler',
  'GGImageCompressSave',
  'GGColorMatch',
  'GGFaceSmartBeauty',
  'GGImageComparer4',
  'GGLoRACustomLoader',
  'GGImageComparer2',
];

(async () => {
  const asJson = process.argv.includes('--json');
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const setup = (kind) => page.evaluate(async (cls) => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    const node = window.LiteGraph.createNode(cls);
    if (!node) return { error: 'createNode 失败' };
    app.graph.add(node);
    node.pos = [80, 60];
    await new Promise((r) => setTimeout(r, 600));
    await tick(); await tick();
    return { id: node.id, snap0: {
      label: '默认',
      size: [Math.round(node.size[0]), Math.round(node.size[1])],
      rowW: node._ggRowLayoutManualWidth ?? null,
      rowH: node._ggRowLayoutManualHeight ?? null,
      autoFit: Array.isArray(node._ggAutoFitManualSize)
        ? [Math.round(node._ggAutoFitManualSize[0]), Math.round(node._ggAutoFitManualSize[1])] : null,
      userSize: Array.isArray(node.properties?._ggRowUserSize)
        ? [Math.round(node.properties._ggRowUserSize[0]), Math.round(node.properties._ggRowUserSize[1])] : null,
    } };
  }, kind);

  // 拖拽前算右下角屏幕坐标；down 后立刻查 resizing_node 是否命中本节点。
  const seCorner = (id) => page.evaluate((nodeId) => {
    const app = window.app;
    const node = app.graph._nodes.find((n) => n.id === nodeId);
    const rect = app.canvas.canvas.getBoundingClientRect();
    const ds = app.canvas.ds;
    return [
      rect.left + (node.pos[0] + node.size[0] - 3 + ds.offset[0]) * ds.scale,
      rect.top + (node.pos[1] + node.size[1] - 3 + ds.offset[1]) * ds.scale,
    ];
  }, id);

  const resizingHit = (id) => page.evaluate((nodeId) => {
    const node = window.app.graph._nodes.find((n) => n.id === nodeId);
    return window.app.canvas.resizing_node === node;
  }, id);

  const readSnap = (id, label) => page.evaluate(([nodeId, tag]) => {
    const node = window.app.graph._nodes.find((n) => n.id === nodeId);
    if (!node) return { label: tag, size: null, gone: true };
    return {
      label: tag,
      size: [Math.round(node.size[0]), Math.round(node.size[1])],
      rowW: node._ggRowLayoutManualWidth ?? null,
      rowH: node._ggRowLayoutManualHeight ?? null,
      autoFit: Array.isArray(node._ggAutoFitManualSize)
        ? [Math.round(node._ggAutoFitManualSize[0]), Math.round(node._ggAutoFitManualSize[1])] : null,
      userSize: Array.isArray(node.properties?._ggRowUserSize)
        ? [Math.round(node.properties._ggRowUserSize[0]), Math.round(node.properties._ggRowUserSize[1])] : null,
    };
  }, [id, label]);

  const changeValue = (id) => page.evaluate(async (nodeId) => {
    const node = window.app.graph._nodes.find((n) => n.id === nodeId);
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const numberWidget = (node.widgets || []).find((w) => w.type === 'number' && !w.hidden);
    const comboWidget = (node.widgets || []).find((w) => w.type === 'combo' && !w.hidden);
    let tag = '改值后(无可改控件)';
    if (numberWidget) {
      numberWidget.value = Number(numberWidget.value || 0) + 1;
      numberWidget.callback?.(numberWidget.value);
      tag = '改number后';
    } else if (comboWidget && Array.isArray(comboWidget.options?.values) && comboWidget.options.values.length > 1) {
      const list = comboWidget.options.values;
      comboWidget.value = list[(list.indexOf(comboWidget.value) + 1) % list.length];
      comboWidget.callback?.(comboWidget.value);
      tag = '改combo后';
    }
    await new Promise((r) => setTimeout(r, 380)); await tick(); await tick();
    return tag;
  }, id);

  const reload = (kind, id) => page.evaluate(async ([cls, nodeId]) => {
    const app = window.app;
    const data = app.graph.serialize();
    const savedNode = (data.nodes || []).find((n) => n.id === nodeId);
    const savedUserSize = savedNode?.properties?._ggRowUserSize ?? null;
    const savedSize = savedNode?.size ?? null;
    // 用户真实读档走 app.loadGraphData（会触发扩展的 loadedGraphNode 认领），
    // 直调 graph.configure 不触发，测出来的是假弹回。
    await app.loadGraphData(JSON.parse(JSON.stringify(data)));
    await new Promise((r) => setTimeout(r, 800));
    const node = app.graph._nodes.find((n) => (n.comfyClass || n.type) === cls)
      || app.graph._nodes.find((n) => n.id === nodeId);
    if (!node) return { label: '读档后', size: null, gone: true };
    return {
      label: '读档后',
      size: [Math.round(node.size[0]), Math.round(node.size[1])],
      rowW: node._ggRowLayoutManualWidth ?? null,
      rowH: node._ggRowLayoutManualHeight ?? null,
      autoFit: Array.isArray(node._ggAutoFitManualSize)
        ? [Math.round(node._ggAutoFitManualSize[0]), Math.round(node._ggAutoFitManualSize[1])] : null,
      userSize: Array.isArray(node.properties?._ggRowUserSize)
        ? [Math.round(node.properties._ggRowUserSize[0]), Math.round(node.properties._ggRowUserSize[1])] : null,
      savedUserSize,
      savedSize,
    };
  }, [kind, id]);

  const results = [];
  for (const kind of CLASSES) {
    try {
      const steps = [];
      const setupR = await setup(kind);
      if (setupR.error) { results.push({ kind, error: setupR.error }); continue; }
      const id = setupR.id;
      steps.push(setupR.snap0);
      const resizingSeen = { hit: false };

      const dragSE = async (dx, dy, tag) => {
        const [sx, sy] = await seCorner(id);
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await new Promise((r) => setTimeout(r, 70));
        if (await resizingHit(id)) resizingSeen.hit = true;
        await page.mouse.move(sx + dx, sy + dy, { steps: 10 });
        await page.mouse.up();
        await new Promise((r) => setTimeout(r, 380));
        steps.push(await readSnap(id, tag));
      };

      await dragSE(110, 90, '拖大(+110,+90)');
      await dragSE(-70, -60, '拖小(-70,-60)');
      await dragSE(-60, 0, '拖窄(宽-60)');
      const tag = await changeValue(id);
      steps.push(await readSnap(id, tag));
      steps.push(await reload(kind, id));
      results.push({ kind, resizingSeen: resizingSeen.hit, steps });
    } catch (e) {
      results.push({ kind, error: String(e) });
    }
  }

  await browser.close();

  const rows = [];
  for (const r of results) {
    if (r.error) { rows.push({ kind: r.kind, error: r.error }); continue; }
    const by = (prefix) => r.steps.find((s) => s.label && s.label.startsWith(prefix)) || {};
    const s1 = by('拖大'), s2 = by('拖小'), s3 = by('拖窄'),
      s4 = by('改number'), s4c = by('改combo'), s5 = by('改值后'), s6 = by('读档后');
    const afterValue = s4.size ? s4 : (s4c.size ? s4c : s5);
    const moved = (a, b) => !a || !b ? false : Math.abs(a[0] - b[0]) > 6 && Math.abs(a[1] - b[1]) > 6;
    rows.push({
      kind: r.kind,
      resizingHit: r.resizingSeen,
      拖大: s1.size,
      拖小后: s2.size,
      拖小弹回: moved(s1.size, s2.size) && Math.abs(s2.size[0] - s1.size[0]) < 30 && Math.abs(s2.size[1] - s1.size[1]) < 30,
      拖窄后: s3.size,
      值变化后: afterValue.size,
      值变化弹回: moved(s3.size, afterValue.size),
      读档后: s6.size,
      读档弹回: moved(afterValue.size, s6.size),
      标记: { rowW: s3.rowW ?? s6.rowW, rowH: s3.rowH ?? s6.rowH, autoFit: s3.autoFit ?? s6.autoFit, userSize: s3.userSize ?? null, 存档: { size: s6.savedSize ?? null, userSize: s6.savedUserSize ?? null }, 读档userSize: s6.userSize ?? null },
    });
  }

  if (asJson) {
    console.log(JSON.stringify({ results, rows, pageErrors: errors }, null, 2));
  } else {
    for (const row of rows) {
      console.log(`\n### ${row.kind}${row.error ? '  ERROR ' + row.error : ''}`);
      if (row.error) continue;
      console.log(`  resizing命中:${row.resizingHit}  拖大:${JSON.stringify(row.拖大)} 拖小后:${JSON.stringify(row.拖小后)}${row.拖小弹回 ? '  <<拖小弹回' : ''}`);
      console.log(`  拖窄后:${JSON.stringify(row.拖窄后)} 值变化后:${JSON.stringify(row.值变化后)}${row.值变化弹回 ? '  <<值变化弹回' : ''} 读档后:${JSON.stringify(row.读档后)}${row.读档弹回 ? '  <<读档弹回' : ''}`);
      console.log(`  标记: ${JSON.stringify(row.标记)}`);
    }
    if (errors.length) console.log('\n页面异常:', JSON.stringify(errors));
  }
})().catch((e) => { console.error(e); process.exit(1); });
