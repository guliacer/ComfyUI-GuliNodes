// 画布 color 控件：胶囊皮肤 + 全节点十六进制编辑 的实机回归。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_color_widget_skin.cjs
//
// 背景：ComfyUI 的 ColorWidget 是单行 canvas 自绘，官方画 20px 灰扁条 + 40×14
// 色块，与 24px 胶囊完全不是一套；且它不在皮肤白名单里，导致「整节点只有
// 这一行是扁条」。`GG图像缩放V2` 的那一格还要切到「填充·自定义颜色」才出现，
// 静态扫描很容易漏。这里两个节点都测，并把十六进制编辑也一起验。
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = path.join(__dirname, 'out');
const SIDE = 15;
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const missing = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });
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

  const CASES = [
    { key: 'solid', cls: 'GG纯色图像', mode: null, hex: '#00ff00', next: '#123abc' },
    { key: 'v2', cls: 'GG图像缩放V2', mode: '填充·自定义颜色', hex: '#364254', next: '#ff0000' },
  ];

  const shots = [];
  for (const spec of CASES) {
    // ---------- 造景 + 切到目标模式 ----------
    const setup = await page.evaluate(async ({ cls, mode, SIDE }) => {
      const app = window.app;
      if (!window.__ggSavedGraph) window.__ggSavedGraph = app.graph.serialize();
      app.graph.clear();
      app.canvas.ds.scale = 1;
      app.canvas.ds.offset = [0, 0];
      const node = window.LiteGraph.createNode(cls);
      app.graph.add(node);
      node.pos = [60, 120];
      await new Promise((r) => setTimeout(r, 450));
      if (mode) {
        const modeWidget = (node.widgets ?? []).find((w) => /模式/.test(w.name));
        if (modeWidget) { modeWidget.value = mode; modeWidget.callback?.(mode); }
        await new Promise((r) => setTimeout(r, 450));
      }
      window.__ggNode = node;
      node.setDirtyCanvas?.(true, true);
      app.canvas.draw(true, true);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      // 一帧里记录：带 shadow 的 roundRect / 色块填充 / 官方 drawWidget 调用次数
      const proto = CanvasRenderingContext2D.prototype;
      const origRR = proto.roundRect;
      const origFill = proto.fill;
      const origText = proto.fillText;
      const shadows = [];
      const fills = [];
      const texts = [];
      const calls = {};
      const origs = {};
      for (const w of node.widgets ?? []) {
        if (typeof w.drawWidget !== 'function') continue;
        origs[w.name] = w.drawWidget;
        const name = w.name;
        w.drawWidget = function (...args) {
          calls[name] = (calls[name] || 0) + 1;
          return origs[name].apply(this, args);
        };
      }
      proto.roundRect = function (x, y, w, h, r) {
        if (this.shadowBlur > 0) shadows.push([Math.round(x), Math.round(y), Math.round(w), Math.round(h)]);
        return origRR.call(this, x, y, w, h, r);
      };
      proto.fill = function (...args) {
        fills.push(String(this.fillStyle));
        return origFill.apply(this, args);
      };
      proto.fillText = function (t, ...rest) { texts.push(String(t)); return origText.call(this, t, ...rest); };
      try { app.canvas.draw(true, true); } finally {
        proto.roundRect = origRR;
        proto.fill = origFill;
        proto.fillText = origText;
        for (const w of node.widgets ?? []) if (origs[w.name]) w.drawWidget = origs[w.name];
      }

      const widgets = (node.widgets ?? []).filter((w) => !w.hidden && !String(w.type).startsWith('ggHidden'));
      return {
        cls, size: [...node.size],
        widgets: widgets.map((w) => ({
          name: w.name, type: String(w.type), y: w.y, h: w.computedHeight ?? 24,
          col: w._ggCol ? [w._ggCol.x, w._ggCol.w] : [0, node.size[0]],
          shape: w._ggCol
            ? [w._ggCol.x + SIDE, w._ggCol.x + w._ggCol.w - SIDE]
            : [SIDE, node.size[0] - SIDE],
          officialDrawCalls: calls[w.name] || 0,
          hasHook: !!w._ggSolidColorHook,
          value: w.value,
        })),
        shadows, fills, texts,
      };
    }, { cls: spec.cls, mode: spec.mode, SIDE });

    const colorWidget = setup.widgets.find((w) => w.type === 'color');
    check(`${spec.cls} 存在可见 color 控件`, !!colorWidget,
      { widgets: setup.widgets.map((w) => `${w.name}:${w.type}`) });
    if (!colorWidget) continue;

    // ---------- 1. color 已换肤，官方扁条不再绘制 ----------
    check(`${spec.cls} color 不再走官方 drawWidget`,
      colorWidget.officialDrawCalls === 0, { calls: colorWidget.officialDrawCalls });
    const flat = setup.shadows.filter((r) => r[3] === 20 && r[0] === colorWidget.shape[0]);
    check(`${spec.cls} 不再出现官方 20px 灰扁条`, flat.length === 0, flat);
    const capsule = setup.shadows.filter((r) => r[0] === colorWidget.shape[0]
      && r[1] === colorWidget.y && r[3] === 24);
    check(`${spec.cls} color 行是 24px 胶囊底格（带投影）`, capsule.length > 0,
      { expectX: colorWidget.shape[0], expectY: colorWidget.y, capsule });

    // ---------- 2. 所有可见控件都吃到胶囊（含 color） ----------
    const uncovered = setup.widgets.filter((w) => {
      if (w.type === 'gg_hint') return false; // 纯文字提示行，不是参数控件
      return !setup.shadows.some((r) => r[0] === w.shape[0] && r[1] === w.y && r[3] === 24);
    });
    check(`${spec.cls} 全部可见参数控件都有胶囊底格`, uncovered.length === 0,
      uncovered.map((w) => `${w.name}:${w.type}@${w.shape[0]},${w.y}`));

    // ---------- 3. 十六进制值与色块真的画出来 ----------
    const hex = String(colorWidget.value).toLowerCase();
    check(`${spec.cls} 显示十六进制颜色值`, setup.texts.some((t) => t.toLowerCase() === hex),
      { hex, sample: setup.texts.filter((t) => /^#/.test(t)) });
    check(`${spec.cls} 色块用真实颜色填充`, setup.fills.some((f) => f.toLowerCase() === hex),
      { hex, fills: setup.fills.filter((f) => f.startsWith('#')).slice(0, 8) });

    // ---------- 4. 十六进制编辑器可点开、可写回 ----------
    check(`${spec.cls} color 控件挂上了十六进制编辑钩子`, colorWidget.hasHook,
      { hasHook: colorWidget.hasHook });

    const toScreen = await page.evaluate(([lx, ly]) => {
      const app = window.app;
      const rect = app.canvas.canvas.getBoundingClientRect();
      const n = window.__ggNode;
      return [
        rect.left + (n.pos[0] + lx) * app.canvas.ds.scale + app.canvas.ds.offset[0],
        rect.top + (n.pos[1] + ly) * app.canvas.ds.scale + app.canvas.ds.offset[1],
      ];
    }, [(colorWidget.shape[0] + colorWidget.shape[1]) / 2, colorWidget.y + 12]);

    await page.mouse.click(toScreen[0], toScreen[1]);
    await page.waitForTimeout(300);
    const editor = await page.evaluate(() => {
      const host = document.querySelector('[data-gg-solid-color]');
      if (!host) return { open: false };
      const input = host.querySelector('input.gg-field');
      return { open: true, title: host.querySelector('.gg-popover-title')?.textContent, value: input?.value };
    });
    check(`${spec.cls} 点击弹出十六进制编辑器`, editor.open, editor);

    if (editor.open) {
      const input = page.locator('[data-gg-solid-color] input.gg-field');
      await input.fill(spec.next);
      await input.press('Enter');
      await page.waitForTimeout(300);
    }
    const afterEdit = await page.evaluate(() => {
      const n = window.__ggNode;
      const w = (n.widgets ?? []).find((x) => String(x.type).toLowerCase() === 'color');
      return { value: w?.value, editorLeft: !!document.querySelector('[data-gg-solid-color]') };
    });
    check(`${spec.cls} 输入 ${spec.next} 后写回且弹层关闭`,
      String(afterEdit.value).toLowerCase() === spec.next.toLowerCase() && !afterEdit.editorLeft,
      afterEdit);

    // ---------- 截图（先把指针挪开，否则控件 tooltip / hover 描边会盖住颜色行） ----------
    await page.mouse.move(1450, 950);
    await page.waitForTimeout(450);
    const clip = await page.evaluate(() => {
      const app = window.app;
      const n = window.__ggNode;
      const rect = app.canvas.canvas.getBoundingClientRect();
      return {
        x: rect.left + n.pos[0] * app.canvas.ds.scale + app.canvas.ds.offset[0] - 12,
        y: rect.top + n.pos[1] * app.canvas.ds.scale + app.canvas.ds.offset[1] - 42,
        width: n.size[0] * app.canvas.ds.scale + 24,
        height: n.size[1] * app.canvas.ds.scale + 56,
      };
    });
    const shot = path.join(OUT_DIR, `color_widget_${spec.key}.png`);
    await page.screenshot({ path: shot, clip });
    shots.push(shot);
  }

  check('全程无页面脚本异常', errors.length === 0, errors.slice(0, 6));
  const ourMissing = missing.filter((u) => /gg-solid-color|gg-widget-rows|gg-ui-design/.test(u));
  check('404 只来自本机缺预览资源，前端模块无缺失', ourMissing.length === 0,
    { total: missing.length, ourMissing });

  await page.evaluate(() => {
    if (window.__ggSavedGraph) window.app.loadGraphData(window.__ggSavedGraph);
  });
  await page.waitForTimeout(300);

  const pass = checks.filter((c) => c.ok).length;
  checks.forEach((c) => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`));
  console.log(`\n${pass}/${checks.length} passed`);
  console.log(JSON.stringify({ shots, errors: errors.slice(0, 6) }, null, 2));
  await browser.close();
  if (pass !== checks.length) process.exitCode = 1;
})();
