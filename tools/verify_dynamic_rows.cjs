// 动态显隐验证：切模式类控件（DynamicCombo / 前端自带显隐）切换后，
// 行布局必须跟着重排，不能留下空槽位或堆到别的控件上。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_dynamic_rows.cjs
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = path.join(__dirname, 'out');
const SIDE = 15;
const TEXT_CHROME = 60;
const BOOL_CHROME = 46;
const MAX_CHOICE = 220;
const MAX_TEXT = 130;

// 每个节点点一遍「模式类」下拉的每个取值
const TARGETS = [
  'GG图像缩放V2',
  'GGImageCrop',
  'GGFaceSmartBeauty',
  'GGImageObfuscate',
  'GGMaskCrop',
  'GG图像缩放',
  'GGAspectRatioLatent',
];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
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
  for (const cls of TARGETS) {
    const info = await page.evaluate(async ({ cls, SIDE, TEXT_CHROME, BOOL_CHROME, MAX_CHOICE, MAX_TEXT }) => {
      const app = window.app;
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const settle = async (ms = 220) => {
        await new Promise((r) => setTimeout(r, ms));
        await tick();
        await tick();
      };
      app.graph.clear();
      const node = window.LiteGraph.createNode(cls);
      if (!node) return { error: 'createNode 失败' };
      app.graph.add(node);
      await settle(320);

      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = '12px Inter, sans-serif';

      const snapshot = () => {
        const shown = node.widgets.filter((w) => {
          if (w.hidden || String(w.type).startsWith('ggHidden')) return false;
          try { return node.isWidgetRowVisible ? node.isWidgetRowVisible(w) : true; } catch { return true; }
        });
        const bad = [];
        for (const w of shown) {
          const label = String(w.displayName ?? w.label ?? w.name).trim();
          const value = String(w._displayValue ?? w.value ?? '');
          const type = String(w.type).toLowerCase();
          const cap = /combo|number/.test(type) ? MAX_CHOICE : MAX_TEXT;
          const need = ctx.measureText(label).width + Math.min(ctx.measureText(value).width, cap) + (type === 'toggle' ? BOOL_CHROME : TEXT_CHROME);
          const inner = w._ggCol ? w._ggCol.w - SIDE * 2 : node.size[0] - SIDE * 2;
          if (inner + 2 < need) bad.push(`${label}(${Math.round(inner)}<${Math.ceil(need)})`);
        }
        const overlap = [];
        for (let i = 0; i < shown.length; i += 1) {
          for (let j = i + 1; j < shown.length; j += 1) {
            const a = shown[i];
            const b = shown[j];
            if (!a._ggCol || !b._ggCol || a.y !== b.y) continue;
            const aEnd = a._ggCol.x + a._ggCol.w - SIDE;
            const bEnd = b._ggCol.x + b._ggCol.w - SIDE;
            if (aEnd > b._ggCol.x + SIDE + 1 && bEnd > a._ggCol.x + SIDE + 1) overlap.push(`${a.name}/${b.name}`);
          }
        }
        return {
          size: [Math.round(node.size[0]), Math.round(node.size[1])],
          rows: [...new Set(shown.map((w) => Math.round(w.y)))].length,
          columns: node._ggRowLayout?.config?.columns ?? null,
          shown: shown.map((w) => String(w.label ?? w.name)),
          bad,
          overlap,
        };
      };

      // 找第一个「取值会改变控件集合」的下拉：一般就是模式控件
      const combos = node.widgets.filter((w) => Array.isArray(w.options?.values) && w.options.values.length > 1);
      const states = [];
      for (const combo of combos.slice(0, 1)) {
        for (const value of combo.options.values) {
          combo.setValue?.(value, { e: null, node, canvas: app.canvas });
          await settle();
          // 引擎的结构检查按 120ms 节流跑在绘制循环上，真实界面里这次重排
          // 会在 120ms 内落地；这里手动触发同一条 reflow（reflow + applyHeight），
          // 让断言验证布局本身，而不是调度时机。
          node._arrangeWidgets?.();
          await tick();
          await tick();
          states.push({ mode: value, ...snapshot() });
        }
      }
      return { states, comboName: combos[0]?.name ?? null };
    }, { cls, SIDE, TEXT_CHROME, BOOL_CHROME, MAX_CHOICE, MAX_TEXT });

    if (info.error) {
      results.push({ cls, error: info.error });
      continue;
    }
    const problems = info.states.flatMap((s) => [
      ...s.bad.map((x) => `${s.mode} 截断 ${x}`),
      ...s.overlap.map((x) => `${s.mode} 重叠 ${x}`),
      // 单列节点（columns: 1）每个控件一行，行数就该等于控件数，只验「不缺行」；
      // 多列节点才要求压在 5 行以内。
      ...(s.columns === 1
        ? (s.rows === s.shown.length ? [] : [`${s.mode} 单列行数 ${s.rows} ≠ 控件数 ${s.shown.length}`])
        : (s.rows > 5 ? [`${s.mode} 行数 ${s.rows}`] : [])),
    ]);
    results.push({
      cls,
      combo: info.comboName,
      states: info.states.map((s) => `${s.mode}:${s.rows}行/${s.shown.length}控件/${s.size.join('x')}`),
      problems,
    });
    process.stderr.write(`${cls} ${info.states.length} 态 ${problems.length ? 'PROBLEM ' + problems.length : 'ok'}\n`);
  }

  const bad = results.filter((r) => r.problems?.length || r.error);
  console.log(JSON.stringify({ results, bad, errors }, null, 1));
  console.log(bad.length ? `FAIL ${bad.length}/${results.length}` : `PASS ${results.length}/${results.length}`);
  await browser.close();
  process.exit(bad.length ? 1 : 0);
})();
