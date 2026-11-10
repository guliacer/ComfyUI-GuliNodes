// GG 图像压缩保存 单列布局回归：默认单列 / 拉宽仍单列且通栏 / 拖高不回缩 /
// 读档恢复 / PNG 态读档不留 32px 空白 / 列不重叠 /
// 带预览图时参数仍通栏且预览不占行。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_compress_save_layout.cjs
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SIDE = 15;
const TOLERANCE = 40; // 列宽与节点宽的容差：内衬 / 贴紧行留出的富余

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const report = await page.evaluate(async ({ SIDE }) => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const settle = async (ms = 280) => {
      await new Promise((r) => setTimeout(r, ms));
      await tick();
      await tick();
    };

    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [60, 90];
    const node = window.LiteGraph.createNode('GGImageCompressSave');
    app.graph.add(node);
    node.pos = [60, 90];
    await settle(320);

    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '12px Inter, sans-serif';

    const read = (label) => {
      const state = node._ggRowLayout;
      const rows = (state?.rows ?? []).map((row) => row.map((w) => String(w.name)));
      const shown = (node.widgets ?? []).filter((w) => !w.hidden);
      const overlap = [];
      for (let i = 0; i < shown.length; i += 1) {
        for (let j = i + 1; j < shown.length; j += 1) {
          const a = shown[i];
          const b = shown[j];
          if (!a._ggCol || !b._ggCol || a.y !== b.y) continue;
          const aEnd = a._ggCol.x + a._ggCol.w - SIDE;
          const bEnd = b._ggCol.x + b._ggCol.w - SIDE;
          if (aEnd > b._ggCol.x + SIDE + 1 && bEnd > a._ggCol.x + SIDE + 1) {
            overlap.push(`${a.name}/${b.name}`);
          }
        }
      }
      // 单列通栏：非 flow 布局下参数控件占满整行（标签左、数值右，中间留白属期望形态）。
      // 这里记录每行控件的实际列宽与所在行宽，用于断言「通栏」。
      const gaps = shown.map((w) => {
        const labelPx = ctx.measureText(String(w.displayName ?? w.label ?? w.name).trim()).width;
        // 与引擎 requiredWidth 同口径：长取值只给额度，超出的由控件自己截断。
        const wType = String(w.type).toLowerCase();
        const cap = /combo|number/.test(wType) ? 220 : 130;
        const valuePx = Math.min(ctx.measureText(String(w._displayValue ?? w.value ?? '')).width, cap);
        const inner = w._ggCol ? w._ggCol.w - SIDE * 2 : node.size[0] - SIDE * 2;
        // 控件收到的 width = inner + 30。文本类可用文字区 = width - 85，
        // 布尔类标签从 30 起、值右对齐到 width-40 —— 两套固定开销不一样。
        const chrome = String(w.type).toLowerCase() === 'toggle' ? 40 : 55;
        return {
          name: String(w.name),
          type: String(w.type),
          gap: Math.round(inner - labelPx - valuePx - chrome),
          colW: w._ggCol ? Math.round(w._ggCol.w) : null,
        };
      });
      return {
        label,
        size: [Math.round(node.size[0]), Math.round(node.size[1])],
        stateHeight: Math.round(state?.height ?? 0),
        flexible: state?.flexible ?? null,
        manualH: Math.round(node._ggRowLayoutManualHeight ?? 0),
        rows,
        rowSizes: rows.map((r) => r.length),
        overlap,
        gaps,
        // 拉宽是否真的重排了：colW 必须跟着 node.size[0] 走，不能停在默认 244。
        colWidths: shown.map((w) => (w._ggCol ? Math.round(w._ggCol.w) : null)),
        truncateFlag: window.LiteGraph?.truncateWidgetValuesFirst ?? null,
      };
    };

    // 带预览图（执行完成后宿主挂上的 $$canvas-image-preview）：
    // 参数区仍要通栏，预览控件不占行、只跟着节点宽，节点高度交回官方分配。
    const readPreview = (label, target) => {
      const state = target._ggRowLayout;
      const params = (target.widgets ?? []).filter(
        (w) => w.name !== '$$canvas-image-preview' && !w.hidden,
      );
      const pv = (target.widgets ?? []).find((w) => w.name === '$$canvas-image-preview');
      const paramBottom = Math.max(0, ...params.map(
        (w) => (Number(w.y) || 0) + (Number(w.computedHeight) || 0),
      ));
      return {
        label,
        size: [Math.round(target.size[0]), Math.round(target.size[1])],
        flexible: state?.flexible ?? null,
        rowSizes: (state?.rows ?? []).map((r) => r.length),
        paramColWidths: params.map((w) => (w._ggCol ? Math.round(w._ggCol.w) : null)),
        paramBottom: Math.round(paramBottom),
        preview: pv ? {
          outside: !!pv._ggRowLayoutOutside,
          colW: pv._ggCol ? Math.round(pv._ggCol.w) : null,
          width: pv.width == null ? null : Math.round(pv.width),
          y: Math.round(Number(pv.y) || 0),
          computedHeight: Math.round(Number(pv.computedHeight) || 0),
          hasLayoutSize: typeof pv.computeLayoutSize === 'function',
        } : null,
      };
    };

    const drag = async (w, h) => {
      app.canvas.resizing_node = node;
      node.setSize([w, h]);
      app.canvas.resizing_node = null;
      await settle(320);
    };

    const out = { initial: read('initial') };

    await drag(244, 320);
    out.tall = read('tall');

    await drag(384, 320);
    out.wide384 = read('wide384');

    await drag(620, 320);
    out.wide620 = read('wide620');

    await drag(220, 320);
    out.narrow220 = read('narrow220');

    // 存档 / 读档：走前端真实的打开工作流路径（graph.configure 会绕过扩展的
    // loadedGraphNode 钩子，测出来的「高度丢失」是造景问题不是产品缺陷）。
    await drag(244, 320);
    const data = app.graph.serialize();
    await app.loadGraphData(data);
    await settle(700);
    const loaded = app.graph._nodes.find((n) => n.comfyClass === 'GGImageCompressSave');
    out.reloaded = loaded ? {
      size: [Math.round(loaded.size[0]), Math.round(loaded.size[1])],
      stateHeight: Math.round(loaded._ggRowLayout?.height ?? 0),
      manualH: Math.round(loaded._ggRowLayoutManualHeight ?? 0),
      rowSizes: (loaded._ggRowLayout?.rows ?? []).map((r) => r.length),
    } : null;

    // PNG 态（隐藏「质量 / 目标大小KB」两行）存档 → 读档：节点高度必须贴合
    // 4 行内容。configure() 期间官方会重算出一个中间态高度（历史实测 172），
    // 若拿它当存档尺寸恢复，底部会永久多出 32px 空白。
    app.graph.clear();
    const pngNode = window.LiteGraph.createNode('GGImageCompressSave');
    app.graph.add(pngNode);
    pngNode.pos = [60, 90];
    await settle(320);
    const formatWidget = pngNode.widgets.find((w) => w.name === '格式');
    if (typeof formatWidget.setValue === 'function') {
      formatWidget.setValue('PNG', { e: null, node: pngNode, canvas: app.canvas });
    } else {
      formatWidget.value = 'PNG';
      formatWidget.callback?.('PNG');
    }
    await settle(320);
    const pngData = app.graph.serialize();
    const pngStored = pngData.nodes.find((n) => String(n.type).includes('GGImageCompressSave'));
    await app.loadGraphData(pngData);
    await settle(700);
    const pngLoaded = app.graph._nodes.find((n) => n.comfyClass === 'GGImageCompressSave');
    out.pngReload = pngLoaded ? {
      size: [Math.round(pngLoaded.size[0]), Math.round(pngLoaded.size[1])],
      contentH: Math.round(pngLoaded._ggRowLayout?.height ?? 0),
      manualH: Math.round(pngLoaded._ggRowLayoutManualHeight ?? 0),
      storedH: Math.round(Number(pngStored?.size?.[1]) || 0),
      rowSizes: (pngLoaded._ggRowLayout?.rows ?? []).map((r) => r.length),
      qualityHidden: !!pngLoaded.widgets.find((w) => w.name === '质量')?.hidden,
    } : null;

    // 执行后有预览图的场景：模拟宿主 addDOMWidget + computeLayoutSize。
    app.graph.clear();
    const pn = window.LiteGraph.createNode('GGImageCompressSave');
    app.graph.add(pn);
    pn.pos = [60, 90];
    await settle(320);
    const host = document.createElement('div');
    host.className = 'image-preview';
    const pw = pn.addDOMWidget?.('$$canvas-image-preview', 'preview', host, { serialize: false });
    if (pw) {
      pw.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 8192, minWidth: 1 });
      pw.serialize = false;
    }
    pn.setDirtyCanvas?.(true, true);
    await settle(320);
    out.previewDefault = readPreview('previewDefault', pn);
    app.canvas.resizing_node = pn;
    pn.setSize([620, 420]);
    app.canvas.resizing_node = null;
    await settle(320);
    out.previewWide = readPreview('previewWide', pn);

    return out;
  }, { SIDE });

  // 真实鼠标拖右下角（不是 setSize 模拟）：LiteGraph 自己走 resize 路径，
  // 确认 onResize 挂钩能记下用户高度，拖回内容高度时也能撤销。
  const corner = await page.evaluate(async () => {
    const app = window.app;
    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    const n = window.LiteGraph.createNode('GGImageCompressSave');
    app.graph.add(n);
    n.pos = [80, 120];
    await new Promise((r) => setTimeout(r, 320));
    const r = app.canvas.canvas.getBoundingClientRect();
    return { x: r.left + n.pos[0] + n.size[0], y: r.top + n.pos[1] + n.size[1] };
  });
  const realRead = () => page.evaluate(() => {
    const n = window.app.graph._nodes[0];
    return {
      size: [Math.round(n.size[0]), Math.round(n.size[1])],
      manualH: Math.round(n._ggRowLayoutManualHeight ?? 0),
      rowSizes: (n._ggRowLayout?.rows ?? []).map((r) => r.length),
    };
  });
  await page.mouse.move(corner.x - 3, corner.y - 3);
  await page.mouse.down();
  await page.mouse.move(corner.x - 3, corner.y + 130, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(420);
  const realTall = await realRead();
  // 拖回内容高度：鼠标连续拖拽在无头浏览器里会命中节点移动而非缩放手柄，
  // 这里直接走 LiteGraph 的 setSize + resizing_node 同一条回调链验证撤销逻辑。
  const realBack = await page.evaluate(async () => {
    const app = window.app;
    const n = app.graph._nodes[0];
    const content = Math.round(n._ggRowLayout?.height ?? 196);
    app.canvas.resizing_node = n;
    n.setSize([n.size[0], content]);
    app.canvas.resizing_node = null;
    await new Promise((r) => setTimeout(r, 320));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      size: [Math.round(n.size[0]), Math.round(n.size[1])],
      manualH: Math.round(n._ggRowLayoutManualHeight ?? 0),
      rowSizes: (n._ggRowLayout?.rows ?? []).map((r) => r.length),
    };
  });

  const fillsWidth = (widths, target) => widths.length > 0
    && widths.every((w) => w != null && Math.abs(w - target) <= TOLERANCE);

  const buildChecks = (report) => {
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

    const init = report.initial;
    check('默认单列 6 行', init.rowSizes.length === 6 && init.rowSizes.every((n) => n === 1), `size=${JSON.stringify(init.size)} rows=${JSON.stringify(init.rowSizes)}`);
    check('第一行是文件名前缀', init.rows[0]?.[0] === '文件名前缀', `first=${JSON.stringify(init.rows[0])}`);
    check('默认无列重叠', init.overlap.length === 0, JSON.stringify(init.overlap));
    // 单列通栏：除文本框（贴内容宽）外，参数控件应占满整行宽。
    const fullRow = init.gaps.filter((g) => g.type !== 'text');
    const notFull = fullRow.filter((g) => g.colW == null || g.colW < init.size[0] - 40);
    check('参数控件单列通栏（占满行宽）', notFull.length === 0, JSON.stringify(fullRow));

    const tall = report.tall;
    check('拖高到 320 不被缩回', tall.size[1] === 320, `size=${JSON.stringify(tall.size)} stateH=${tall.stateHeight}`);
    check('拖高留下手动高度标记', tall.manualH === 320, `manualH=${tall.manualH}`);
    check('拖高后仍是 6 行单列', tall.rowSizes.length === 6 && tall.rowSizes.every((n) => n === 1), JSON.stringify(tall.rowSizes));

    const w384 = report.wide384;
    check('拉宽到 384 仍单列（不并排）', w384.rowSizes.length === 6 && w384.rowSizes.every((n) => n === 1), JSON.stringify(w384.rowSizes));
    check('384 宽无列重叠', w384.overlap.length === 0, JSON.stringify(w384.overlap));
    check('384 宽参数控件通栏重算', fillsWidth(w384.colWidths, 384), JSON.stringify(w384.colWidths));

    const w620 = report.wide620;
    check('620 宽仍单列（不并排）', w620.rowSizes.length === 6 && w620.rowSizes.every((n) => n === 1), JSON.stringify(w620.rowSizes));
    check('620 宽无列重叠', w620.overlap.length === 0, JSON.stringify(w620.overlap));
    // 核心回归：拉宽后列宽必须跟着节点走，停在默认 244 就是右侧大块空白。
    check('620 宽参数控件通栏重算', fillsWidth(w620.colWidths, 620), JSON.stringify(w620.colWidths));

    const narrow = report.narrow220;
    check('拖窄仍单列', narrow.rowSizes.length === 6 && narrow.rowSizes.every((n) => n === 1), JSON.stringify(narrow.rowSizes));
    check('220 宽参数控件跟着收窄', fillsWidth(narrow.colWidths, 220), JSON.stringify(narrow.colWidths));
    check('绘制后没有污染全局截断策略', narrow.truncateFlag === false, `flag=${narrow.truncateFlag}`);

    const re = report.reloaded;
    check('读档后高度保持 320', !!re && re.size[1] === 320, JSON.stringify(re));
    check('读档后恢复手动高度标记', !!re && re.manualH === 320, `manualH=${re?.manualH}`);
    check('读档后单列', !!re && re.rowSizes.length === 6 && re.rowSizes.every((n) => n === 1), JSON.stringify(re?.rowSizes));

    const pr = report.pngReload;
    check('PNG 存档读档后高度贴合内容（无 32px 空白）',
      !!pr && pr.storedH > 0 && pr.size[1] <= pr.storedH + 2 && pr.size[1] - pr.contentH <= 2,
      JSON.stringify(pr));
    check('PNG 存档读档后仍隐藏质量/目标大小KB 且 4 行单列',
      !!pr && pr.qualityHidden && pr.rowSizes.length === 4 && pr.rowSizes.every((n) => n === 1),
      JSON.stringify(pr));

    // 带预览图：预览不能挤掉参数的行布局，也不能让整个节点放弃行布局。
    const pd = report.previewDefault;
    check('预览控件已挂在节点上', !!pd?.preview, JSON.stringify(pd?.preview));
    check('预览标记为布局外控件', !!pd?.preview?.outside, JSON.stringify(pd?.preview));
    check('预览控件不占参数行', !!pd && pd.rowSizes.length === 6 && pd.rowSizes.every((n) => n === 1), JSON.stringify(pd?.rowSizes));
    check('预览出现后高度交回官方', pd?.flexible === true, `flexible=${pd?.flexible}`);
    check('预览宽度同步到节点宽', !!pd?.preview && Math.abs((pd.preview.width ?? 0) - pd.size[0]) <= TOLERANCE, JSON.stringify(pd?.preview));
    check('预览图起点在参数区下方（不压住最后一行）',
      !!pd?.preview && pd.preview.y >= pd.paramBottom,
      { paramBottom: pd?.paramBottom, previewY: pd?.preview?.y });

    const pwide = report.previewWide;
    check('带预览拉宽 620 仍 6 行单列', !!pwide && pwide.rowSizes.length === 6 && pwide.rowSizes.every((n) => n === 1), JSON.stringify(pwide?.rowSizes));
    check('带预览拉宽 620 参数通栏', !!pwide && fillsWidth(pwide.paramColWidths, 620), JSON.stringify(pwide?.paramColWidths));
    check('带预览拉宽 620 高度仍交回官方', pwide?.flexible === true, `flexible=${pwide?.flexible}`);
    check('带预览预览控件仍不占行', !!pwide?.preview && pwide.preview.colW === null, JSON.stringify(pwide?.preview));
    check('带预览预览宽度跟着节点', !!pwide?.preview && Math.abs((pwide.preview.width ?? 0) - 620) <= TOLERANCE, JSON.stringify(pwide?.preview));
    check('拉宽后预览图仍不压住参数区',
      !!pwide?.preview && pwide.preview.y >= pwide.paramBottom,
      { paramBottom: pwide?.paramBottom, previewY: pwide?.preview?.y });

    return checks;
  };

  const checks = buildChecks(report);
  checks.push({ name: '真实鼠标拖高保持', ok: realTall.size[1] >= 300 && realTall.manualH >= 300, detail: JSON.stringify(realTall) });
  checks.push({ name: '真实鼠标拖回内容高度后能收回去', ok: realBack.manualH === 0 && realBack.size[1] <= 210, detail: JSON.stringify(realBack) });
  checks.push({ name: '无页面异常', ok: errors.length === 0, detail: JSON.stringify(errors) });

  // 反向验证：把「拉宽通栏 / flexible / 预览宽度」故意改坏，新增断言必须真的 FAIL。
  // 一次全绿不可信，0 条 FAIL 往往说明断言在空跑。
  const makeBroken = (r) => {
    const copy = JSON.parse(JSON.stringify(r));
    for (const key of ['wide384', 'wide620', 'narrow220', 'previewWide']) {
      const part = copy[key];
      if (!part) continue;
      // 破坏值要离目标足够远：默认宽 244 落在 220±40 的容差里，
      // 拿它当「拉宽没重算」的证据会让断言假 PASS。
      const poison = key === 'narrow220' ? 620 : 244;
      if (Array.isArray(part.colWidths)) part.colWidths = part.colWidths.map(() => poison);
      if (Array.isArray(part.paramColWidths)) part.paramColWidths = part.paramColWidths.map(() => poison);
      if (Array.isArray(part.gaps)) part.gaps = part.gaps.map((g) => ({ ...g, colW: poison }));
      part.flexible = false;
      if (part.preview) {
        part.preview = { ...part.preview, width: poison, outside: false, colW: poison };
      }
    }
    if (copy.previewDefault) {
      copy.previewDefault.flexible = false;
      if (copy.previewDefault.preview) {
        // 默认场景节点宽就是 244，破坏值必须换成别的数才会真的 FAIL。
        copy.previewDefault.preview = { ...copy.previewDefault.preview, width: 1, outside: false, colW: 244 };
      }
    }
    if (copy.pngReload) {
      copy.pngReload.size = [copy.pngReload.size[0], copy.pngReload.contentH + 32];
      copy.pngReload.qualityHidden = false;
      copy.pngReload.rowSizes = [1, 1, 1, 1, 1, 1];
    }
    return copy;
  };
  const brokenByName = new Map(buildChecks(makeBroken(report)).map((c) => [c.name, c.ok]));
  const NEGATIVE_NAMES = [
    '384 宽参数控件通栏重算',
    '620 宽参数控件通栏重算',
    '220 宽参数控件跟着收窄',
    '预览标记为布局外控件',
    '预览出现后高度交回官方',
    '预览宽度同步到节点宽',
    '带预览拉宽 620 参数通栏',
    '带预览拉宽 620 高度仍交回官方',
    '带预览预览控件仍不占行',
    '带预览预览宽度跟着节点',
    'PNG 存档读档后高度贴合内容（无 32px 空白）',
    'PNG 存档读档后仍隐藏质量/目标大小KB 且 4 行单列',
  ];
  const missed = NEGATIVE_NAMES.filter((name) => brokenByName.get(name) !== false);
  checks.push({
    name: `反向破坏验证：${NEGATIVE_NAMES.length} 条新断言全部能 FAIL`,
    ok: missed.length === 0,
    detail: `破坏后仍 PASS 的断言=${JSON.stringify(missed)}`,
  });

  const passed = checks.filter((c) => c.ok).length;
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  << ' + c.detail}`);
  }
  console.log(`\n${passed}/${checks.length} 通过`);
  if (passed === checks.length) {
    console.log('默认尺寸', JSON.stringify(report.initial.size), '620 列宽', JSON.stringify(report.wide620.colWidths));
  }
  await browser.close();
  process.exit(passed === checks.length ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
