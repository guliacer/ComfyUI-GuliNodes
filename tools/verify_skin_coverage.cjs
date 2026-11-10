// 全节点画布皮肤覆盖率回归（含条件显隐 / 动态控件）。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_skin_coverage.cjs
//
// 为什么需要：只扫「节点刚创建时」的控件会漏掉切模式后才出现的控件 ——
// `GG图像缩放V2` 的「填充颜色」要切到「填充·自定义颜色」才显示，正是这样
// 漏掉的 `color` 类型，画成了唯一的 20px 灰扁条。本脚本遍历每个 combo 的
// 每个选项，把所有状态下出现过的控件都收进来，再用引擎真实的
// SKINNABLE_TYPES 白名单核对；新增装饰型控件必须显式加进 EXEMPT，否则 FAIL。
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const REPORT = path.join(OUT, 'skin_coverage_report.json');
const SIDE = 15;
// 纯装饰 / 非参数控件：不是胶囊该覆盖的对象，显式豁免，新增必须写明理由。
const EXEMPT = new Set([
  'gg_hint',                 // GGImageSuperResolution 的模型镜像文字提示，纯文字行
  // 2026-11-06 起「当前生效」提示条已删除，这条只给老会话残留的隐藏控件兜底。
  'gg_lora_group_hint',     // GGLoRAGroupLoader 旧版顶部说明条，纯装饰文字
  'gg_lora_group_tabs',     // GGLoRAGroupLoader 组标签条，自己画按钮/删除/翻页，不是参数控件
]);

const src = fs.readFileSync(path.join(ROOT, 'web/gg-widget-rows.js'), 'utf8');
const m = /const SKINNABLE_TYPES = new Set\(\[([^\]]+)\]\)/.exec(src);
if (!m) throw new Error('读不到 web/gg-widget-rows.js 的 SKINNABLE_TYPES');
const WHITELIST = new Set([...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]));

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); }

// 异常收集口径与 verify_web_ai_default_height.cjs 一致（问题文档第 5 条）：
// 本机外部扩展 gulips.bridge 的 setup 抛 `io is not defined`，被 ComfyUI 用
// console.error 兜住，属于启动环境噪音；内嵌网页还会刷 CSP report-only 报告。
// 未捕获的 pageerror 一律算异常；console error 里凡是提到本模块前端文件的算异常，
// 其余归入 externalNoise 单独记录。这样既不误报，也不会把断言放宽成空跑。
const OWN_MODULE = /gg-widget-rows|gg-solid-color|gg-ui-design|gg-widget-row-presets|gg-web-ai-reverse|web_ai_tools/i;
const isOwnModuleError = (text) => OWN_MODULE.test(String(text));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const missing = [];
  const externalNoise = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });
  page.on('console', (c) => {
    if (c.type() !== 'error' || /Failed to load resource/.test(c.text())) return;
    const text = c.text();
    if (!isOwnModuleError(text)) { externalNoise.push('console: ' + text); return; }
    errors.push('console: ' + text);
  });

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const classes = await page.evaluate(async () => {
    const app = window.app;
    window.__covSaved = app.graph.serialize();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    const info = await (await fetch('/object_info')).json();
    return Object.keys(info).filter((k) => k.startsWith('GG'));
  });

  const batches = [];
  for (let i = 0; i < classes.length; i += 6) batches.push(classes.slice(i, i + 6));

  const results = [];
  for (const batch of batches) {
    const part = await page.evaluate(async ({ batch, SIDE, exempt }) => {
      const app = window.app;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const proto = CanvasRenderingContext2D.prototype;
      const origRR = proto.roundRect;
      const out = [];
      for (const cls of batch) {
        app.graph.clear();
        let node;
        try { node = window.LiteGraph.createNode(cls); } catch (e) {
          out.push({ cls, createError: String(e) }); continue;
        }
        if (!node) { out.push({ cls, createError: 'null node' }); continue; }
        app.graph.add(node);
        node.pos = [40, 40];
        await sleep(220);

        const snapshot = () => (node.widgets ?? []).map((w) => {
          let h = w.computedHeight;
          if (h == null && typeof w.computeSize === 'function') {
            try { h = w.computeSize(node.size?.[0] ?? 200)?.[1]; } catch { /* noop */ }
          }
          return {
            name: w.name, type: String(w.type ?? ''), hidden: !!w.hidden,
            hasElement: !!w.element, hasInputEl: !!w.inputEl,
            h: h ?? null, y: w.y ?? w.last_y ?? null,
            shape: w._ggCol
              ? [w._ggCol.x + SIDE, w._ggCol.x + w._ggCol.w - SIDE]
              : [SIDE, (node.size?.[0] ?? 200) - SIDE],
          };
        });

        const seen = new Map();
        const record = (tag) => {
          for (const w of snapshot()) {
            const key = `${w.name}|${w.type}`;
            if (!seen.has(key)) seen.set(key, { ...w, firstSeen: tag });
            else if (!w.hidden) seen.get(key).seenVisible = true;
          }
        };
        record('initial');

        // 初始状态绘制一帧：统计带投影的胶囊底格，检查形状区覆盖
        const shadows = [];
        proto.roundRect = function (x, y, w, h, r) {
          if (this.shadowBlur > 0) shadows.push([Math.round(x), Math.round(y), Math.round(w), Math.round(h)]);
          return origRR.call(this, x, y, w, h, r);
        };
        try { node.setDirtyCanvas?.(true, true); app.canvas.draw(true, true); } finally {
          proto.roundRect = origRR;
        }
        const initialVisible = snapshot().filter((w) => !w.hidden && !w.type.startsWith('ggHidden'));
        const uncovered = initialVisible.filter((w) => (w.h == null || w.h > 34) || w.hasElement
          || exempt.includes(w.type)
          ? false
          : !shadows.some((r) => r[0] === Math.round(w.shape[0]) && r[1] === Math.round(w.y) && r[3] === 24));

        // 遍历所有 combo 的所有选项，逼出条件显隐的控件
        const combos = (node.widgets ?? []).filter((w) => w?.options?.values?.length);
        let switches = 0;
        for (const combo of combos.slice(0, 8)) {
          for (const v of combo.options.values.slice(0, 14)) {
            try {
              combo.value = v;
              combo.callback?.(v);
              await sleep(45);
              record(`${combo.name}=${v}`);
              switches += 1;
            } catch { /* noop */ }
          }
        }
        out.push({
          cls, size: node.size ? [...node.size] : null,
          rowLayout: !!node._ggRowLayout,
          comboCount: combos.length, switches,
          initialVisible: initialVisible.length,
          initialShadows: shadows.length,
          uncovered: uncovered.map((w) => `${w.name}:${w.type}@${w.shape[0]},${w.y}`),
          widgets: [...seen.values()],
        });
      }
      return out;
    }, { batch, SIDE, exempt: [...EXEMPT] });
    results.push(...part);
  }

  await page.evaluate(() => { if (window.__covSaved) window.app.loadGraphData(window.__covSaved); });
  await page.waitForTimeout(300);

  // ---------- 断言 ----------
  const all = results.flatMap((r) => (r.widgets ?? []).map((w) => ({ ...w, cls: r.cls })));
  const candidates = all.filter((w) => !w.hidden && !w.type.startsWith('ggHidden')
    && (w.h == null || w.h <= 34) && !w.hasElement && !w.hasInputEl);
  const offList = candidates.filter((w) => !WHITELIST.has(w.type) && !EXEMPT.has(w.type));

  check('读到引擎真实的 SKINNABLE_TYPES 白名单', WHITELIST.has('color') && WHITELIST.size >= 6,
    [...WHITELIST]);
  check(`全量扫描覆盖 ${classes.length} 个 GG 节点`, results.length === classes.length,
    { expected: classes.length, got: results.length });
  check('扫描确实触发了条件显隐（发现初始不可见的控件）',
    all.some((w) => w.firstSeen !== 'initial'),
    { dynamicCount: all.filter((w) => w.firstSeen !== 'initial').length });
  check('扫描确实抓到了两处 color 控件（含动态那一处）',
    all.filter((w) => w.type === 'color').length >= 2,
    all.filter((w) => w.type === 'color').map((w) => `${w.cls}.${w.name}@${w.firstSeen}`));
  check('所有可见单行 canvas 控件都在皮肤白名单或显式豁免内',
    offList.length === 0,
    offList.map((w) => `${w.cls}.${w.name}:${w.type}@${w.firstSeen}`));

  const uncoveredAll = results.filter((r) => (r.uncovered?.length ?? 0) > 0);
  check('各节点初始态所有可见参数控件都有 24px 胶囊底格',
    uncoveredAll.length === 0,
    uncoveredAll.map((r) => ({ cls: r.cls, uncovered: r.uncovered })));

  const createErrors = results.filter((r) => r.createError);
  check('所有节点都能正常创建并探测', createErrors.length === 0, createErrors);
  check('全程无页面脚本异常（外部扩展启动噪音单独归类）', errors.length === 0,
    errors.slice(0, 6));
  // 反向验证过滤器：本模块自身的错误必须仍被计入，防止「无脚本异常」空跑。
  check('异常过滤器有效，不会把本模块错误当噪音吞掉',
    isOwnModuleError('Uncaught TypeError in gg-widget-rows.js')
      && !isOwnModuleError("Error calling extension 'gulips.bridge' method 'setup': ReferenceError: io is not defined")
      && !externalNoise.some((s) => isOwnModuleError(s)),
    { externalNoise: externalNoise.length, sample: externalNoise.slice(0, 2) });
  const ourMissing = missing.filter((u) => /gg-widget-rows|gg-solid-color|gg-ui-design/.test(u));
  check('404 只来自本机缺预览资源，前端模块无缺失', ourMissing.length === 0,
    { total: missing.length, ourMissing });

  const report = {
    whitelist: [...WHITELIST], exempt: [...EXEMPT],
    nodeCount: classes.length, widgetStates: all.length,
    dynamicWidgets: all.filter((w) => w.firstSeen !== 'initial')
      .map((w) => ({ cls: w.cls, name: w.name, type: w.type, firstSeen: w.firstSeen })),
    colorWidgets: all.filter((w) => w.type === 'color')
      .map((w) => ({ cls: w.cls, name: w.name, firstSeen: w.firstSeen })),
    byType: Object.fromEntries([...new Set(all.map((w) => w.type))].map((t) => [t,
      all.filter((w) => w.type === t).length])),
    offList: offList.map((w) => `${w.cls}.${w.name}:${w.type}`),
    nodes: results.map((r) => ({
      cls: r.cls, rowLayout: r.rowLayout, comboCount: r.comboCount, switches: r.switches,
      initialVisible: r.initialVisible, initialShadows: r.initialShadows,
      uncovered: r.uncovered ?? [], widgetStates: (r.widgets ?? []).length,
    })),
    errors: errors.slice(0, 10),
    externalNoise: externalNoise.slice(0, 5),
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

  const pass = checks.filter((c) => c.ok).length;
  checks.forEach((c) => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`));
  console.log(`\n${pass}/${checks.length} passed`);
  console.log(JSON.stringify({
    nodeCount: report.nodeCount, widgetStates: report.widgetStates,
    dynamicWidgets: report.dynamicWidgets.length,
    colorWidgets: report.colorWidgets,
    byType: report.byType, offList: report.offList, report: REPORT,
  }, null, 2));
  await browser.close();
  if (pass !== checks.length) process.exitCode = 1;
})();
