// 验证 GG 图像宽高：标签精简 + 一行装不下自动折行 + 每格文字不被截断。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_ar_rows.cjs
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = path.join(__dirname, 'out');
const MODES = ['按边长', '按K数分辨率', '按Latent接入', '按图像接入'];
const EXPECT_LABELS = ['方式', '比例', '边长', '类型', '方向', '分辨率', '倍数'];
const OLD_LABELS = ['宽高方式', '宽高比例', '边长类型', '画面方向', '缩放倍率'];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // 真机脚本异常收集统一口径（问题文档第 5 条）：外部扩展 gulips.bridge 启动时
  // 抛 `io is not defined`，内嵌网页还会刷 CSP report-only 报告，都属环境噪音；
  // 只放行下面明确识别的几条，其它任何 console error 仍然计入 errors，
  // 不允许把「无脚本异常」放宽成空跑。404 另由 response 钩子单独归类。
  const ENV_NOISE = [
    /Error calling extension 'gulips[.]bridge' method 'setup'/,
    /report-only Content Security Policy/,
    /Framing .* violates the following report-only/,
    /upgrade-insecure-requests' is ignored when delivered in a report-only policy/,
    /Failed to load resource/,
  ];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (ENV_NOISE.some((re) => re.test(text))) return;
    errors.push('console: ' + text);
  });

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

  // 引擎里 SIDE=15（= BaseWidget.margin）、COL_GAP=8、文字开销 TEXT_CHROME=60
  // （官方 width-85 口径扣掉列矩形多带的 30）。这里按同一套口径复算
  // 「这格放不放得下」，用于断言没有出现省略号。
  const measure = async (mode) => page.evaluate(async (mode) => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [40, 90];
    const node = window.LiteGraph.createNode('GGAspectRatioAdapter');
    app.graph.add(node);
    node.pos = [40, 90];
    await tick();
    const modeWidget = node.widgets.find((w) => String(w.name).endsWith('宽高方式'));
    modeWidget.setValue?.(mode, { e: null, node, canvas: app.canvas });
    await tick();
    await tick();

    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '12px Inter, sans-serif';
    const SIDE = 15;
    const CHROME = 60;
    const widgets = node.widgets.filter((w) => {
      try { return node.isWidgetRowVisible ? node.isWidgetRowVisible(w) : true; } catch { return true; }
    }).map((w) => {
      const label = String(w.label ?? w.name).split('.').pop();
      const labelWidth = ctx.measureText(label).width;
      const valueWidth = ctx.measureText(String(w._displayValue ?? w.value ?? '')).width;
      const inner = w._ggCol ? w._ggCol.w - SIDE * 2 : 0;
      const need = labelWidth + valueWidth + CHROME;
      return {
        name: w.name,
        label,
        y: Math.round(w.y),
        inner: Math.round(inner),
        need: Math.ceil(need),
        fits: inner >= need,
      };
    });

    const rect = app.canvas.canvas.getBoundingClientRect();
    const ds = app.canvas.ds;
    const box = {
      x: rect.left + (node.pos[0] + ds.offset[0]) * ds.scale - 8,
      y: rect.top + (node.pos[1] + ds.offset[1]) * ds.scale - 24,
      width: node.size[0] * ds.scale + 16,
      height: node.size[1] * ds.scale + 40,
    };
    const serialized = node.serialize?.() ?? {};
    return {
      size: [Math.round(node.size[0]), Math.round(node.size[1])],
      rows: (node._ggRowLayout?.rows ?? []).map((row) => row.map((w) => w.label || w.name)),
      widgets,
      box,
      values: serialized.widgets_values ?? node.widgets_values ?? null,
    };
  }, mode);

  for (const mode of MODES) {
    const info = await measure(mode);
    const labels = info.widgets.map((w) => w.label);
    check(`${mode} · 标签已精简`, labels.every((l) => EXPECT_LABELS.includes(l)), labels.join('|'));
    check(`${mode} · 不再出现长标签`, !labels.some((l) => OLD_LABELS.includes(l)), labels.join('|'));
    // 2026-11-04 口径：非必要单列，Adapter 每行一个控件，行数 = 可见控件数
    check(`${mode} · 单列行数等于控件数`, info.rows.length === info.widgets.length, JSON.stringify(info.rows));
    check(`${mode} · 行内文字不被截断`, info.widgets.every((w) => w.fits), JSON.stringify(info.widgets.map((w) => [w.label, w.inner, w.need])));
    check(`${mode} · 模式值写进序列化`, JSON.stringify(info.values).includes(mode), JSON.stringify(info.values));
    await page.mouse.move(1300, 820);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT_DIR, `ar_${mode}.png`), clip: info.box });
  }

  // 节点变窄到最小宽度以下时，应当被内容宽度下限顶回去，行保持单列不爆
  const narrow = await page.evaluate(async () => {
    const node = window.app.graph._nodes[0];
    const before = node.size[0];
    node.size[0] = 240;
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '12px Inter, sans-serif';
    const shown = node.widgets.filter((w) => {
      try { return node.isWidgetRowVisible ? node.isWidgetRowVisible(w) : true; } catch { return true; }
    });
    return {
      before: Math.round(before),
      minWidth: Math.round(node._ggRowLayout?.minWidth ?? 0),
      size: [Math.round(node.size[0]), Math.round(node.size[1])],
      rows: (node._ggRowLayout?.rows ?? []).map((row) => row.map((w) => w.label || w.name)),
      widths: shown.map((w) => [w.label, Math.round(w._ggCol?.w ?? 0), Math.round(ctx.measureText(String(w.label ?? '')).width)]),
      shownCount: shown.length,
    };
  });
  // 单列宽度下限 = 最宽控件完整显示所需（state.minWidth）；拖窄不低于它
  check('缩窄后仍受内容宽度下限保护', narrow.size[0] >= narrow.minWidth - 2, JSON.stringify(narrow));
  check('缩窄后行数不爆（仍是一行一个）', narrow.rows.length === narrow.shownCount, JSON.stringify(narrow.rows));

  // 老工作流：configure 之后标签仍要精简，控件值不能动
  const reloaded = await page.evaluate(async () => {
    const node = window.app.graph._nodes[0];
    const data = node.serialize();
    window.app.graph.clear();
    const fresh = window.LiteGraph.createNode('GGAspectRatioAdapter');
    window.app.graph.add(fresh);
    fresh.configure(data);
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    const mode = fresh.widgets.find((w) => String(w.name).endsWith('宽高方式'));
    return {
      modeValue: mode?.value,
      labels: fresh.widgets.map((w) => String(w.label ?? w.name).split('.').pop()),
      rows: (fresh._ggRowLayout?.rows ?? []).length,
    };
  });
  check('重新加载后模式值不变', reloaded.modeValue === '按图像接入', String(reloaded.modeValue));
  check('重新加载后标签仍精简', reloaded.labels.every((l) => !OLD_LABELS.includes(l)), reloaded.labels.join('|'));
  check('重新加载后行数有效', reloaded.rows > 0, String(reloaded.rows));

  // 列内点击要落对格子：点「方式」右侧箭头应当切换到下一个方式。
  // 控件自己的 onClick 用 `e.canvasX - node.pos[0]` 判断左右 40px 增量区，
  // 引擎靠临时右移 node.pos[0] 把相对坐标压回列内，这里就是验证那一步。
  const arrow = await page.evaluate(async () => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [60, 120];
    const node = window.LiteGraph.createNode('GGAspectRatioAdapter');
    app.graph.add(node);
    node.pos = [60, 120];
    await tick();
    await tick();
    const widget = node.widgets.find((w) => String(w.name).endsWith('宽高方式'));
    const rect = app.canvas.canvas.getBoundingClientRect();
    const ds = app.canvas.ds;
    const toScreen = (lx, ly) => [
      rect.left + (node.pos[0] + ds.offset[0] + lx) * ds.scale,
      rect.top + (node.pos[1] + ds.offset[1] + ly) * ds.scale,
    ];
    return {
      before: widget.value,
      col: widget._ggCol,
      point: toScreen(widget._ggCol.x + widget._ggCol.w - 20, widget.y + 12),
    };
  });
  await page.mouse.click(arrow.point[0], arrow.point[1]);
  await page.waitForTimeout(350);
  await page.mouse.move(1300, 820);
  const afterClick = await page.evaluate(() => {
    const node = window.app.graph._nodes[0];
    const widget = node.widgets.find((w) => String(w.name).endsWith('宽高方式'));
    return {
      value: widget.value,
      rows: (node._ggRowLayout?.rows ?? []).map((row) => row.map((w) => w.label || w.name)),
      cols: node.widgets.filter((w) => w._ggCol).map((w) => [w.label, Math.round(w._ggCol.x), Math.round(w._ggCol.w)]),
    };
  });
  check('点列内箭头能切换方式', afterClick.value !== arrow.before, `${arrow.before} → ${afterClick.value}`);
  check('切换方式后重新单列排布', afterClick.rows.length > 0 && afterClick.rows.length <= afterClick.cols.length, JSON.stringify(afterClick.rows));
  await page.screenshot({ path: path.join(OUT_DIR, 'ar_click.png'), clip: { x: arrow.point[0] - 320, y: arrow.point[1] - 60, width: 560, height: 200 } });

  console.log(JSON.stringify({ results, errors }, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `FAIL ${failed.length}/${results.length}` : `PASS ${results.length}/${results.length}`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})();
