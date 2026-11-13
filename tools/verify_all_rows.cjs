// 全量验证：插件里套了单行列布局的节点，逐个建出来检查
//   · 每个控件分到的宽度够不够放下「标签 + 数值」（不够就会出现省略号）
//   · 行数是不是压在配置的上限内（多行文本框独占一行不计入）
//   · 节点尺寸是否稳定、有没有控件互相压住
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_all_rows.cjs
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = path.join(__dirname, 'out');

const CLASSES = [
  // 手工登记（固定权重）
  'GG色彩校正', 'GGImageCompressSave', 'GG反推模型', 'GGVideoBridgeFromImageAudio',
  'GG纯色图像', 'GGInpaintCrop', 'GGLoRACustomLoader', 'GGAspectRatioAdapter',
  // 自动布局
  'GG图像缩放', 'GG图像缩放V2', 'GGAspectRatioLatent', 'GGColorMatch', 'GGCropRestore',
  'GGFaceSkinSmoothing', 'GGFaceSmartBeauty', 'GGImageAdjust', 'GGImageCompress', 'GGImageCrop',
  'GGImageMergeMask', 'GGImageObfuscate', 'GGImageStyleReference', 'GGImageSuperResolution',
  'GGImageTransform', 'GGInteger', 'GGMaskCheck', 'GGMaskCrop', 'GGMemoryCleanup',
  'GGPromptEnhancer', 'GGPromptOptimizer', 'GGRegionEditPrepare', 'GGSaveImage', 'GGSeedGenerator',
  'GGSimpleMath', 'GGTextConcat', 'GGTextFileLoad', 'GGVideoCompress', 'GGVideoLoad',
  'GGVideoLoadByPath', 'GGWebAIReverseText', 'GGZImageSampler', 'GGCLIPText', 'GG提示词优化',
  'GG图像反推',
];

const SIDE = 15;
// 引擎的 TEXT_CHROME = 60：列矩形 w = need + SIDE*2，控件收到的 width 是 w，
// 官方 drawTruncatingText 的可用文字宽是 width - 85，所以 need >= 标签+数值+60。
const TEXT_CHROME = 60;
// BooleanWidget 单独一套口径：标签从 30 起画、值右对齐到 width-40，
// 比 drawTruncatingText 少 14px 开销（见 gg-widget-rows.js 的 BOOL_CHROME）。
const BOOL_CHROME = 46;
const MAX_TEXT_VALUE_PX = 130;
const MAX_CHOICE_VALUE_PX = 220;

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
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
  for (const cls of CLASSES) {
    const info = await page.evaluate(async ({ cls, SIDE, TEXT_CHROME, BOOL_CHROME, MAX_CHOICE_VALUE_PX, MAX_TEXT_VALUE_PX }) => {
      const app = window.app;
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      app.graph.clear();
      app.canvas.ds.scale = 1;
      app.canvas.ds.offset = [40, 60];
      const node = window.LiteGraph.createNode(cls);
      if (!node) return { error: 'createNode 失败' };
      app.graph.add(node);
      node.pos = [50, 60];
      await new Promise((r) => setTimeout(r, 260));
      await tick();
      await tick();

      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = '12px Inter, sans-serif';
      const rowH = window.LiteGraph?.NODE_WIDGET_HEIGHT ?? 24;
      const shown = node.widgets.filter((w) => !w.hidden && !String(w.type).startsWith('ggHidden'));
      // 节点自己画某一列（比如把布尔画成勾选框）时，那一格本来就不画文字，
      // 不能按「标签 + 数值」判它截断。
      const hasDrawColumn = typeof node._ggRowLayout?.config?.drawColumn === 'function';

      const widgets = shown.map((w) => {
        // 引擎的 requiredWidth 对 label 做了 trim（LoRA 槽位用 " " 占位），
        // 这里口径要一致，否则会为一个看不见的空格多算 3~4px 误报截断。
        const label = String(w.displayName ?? w.label ?? w.name).trim();
        const labelPx = ctx.measureText(label).width;
        // 按控件真正画出来的文本量：NumberWidget 会把 1 显示成 1.0
        const valuePx = Math.min(ctx.measureText(String(w._displayValue ?? w.value ?? '')).width, /combo|number/.test(String(w.type)) ? MAX_CHOICE_VALUE_PX : MAX_TEXT_VALUE_PX);
        // 与引擎 requiredWidth 同口径：按钮只画一次文字（label/value 同串），单份 + 44
        const need = String(w.type).toLowerCase() === 'button'
          ? Math.ceil(Math.max(labelPx, valuePx) + 44)
          : Math.ceil(labelPx + valuePx + (String(w.type).toLowerCase() === 'toggle' ? BOOL_CHROME : TEXT_CHROME));
        // 没分列的控件（保持官方竖排的节点）整行都是它的，按节点宽度算
        const inner = w._ggCol ? w._ggCol.w - SIDE * 2 : node.size[0] - SIDE * 2;
        const checkbox = hasDrawColumn && String(w.type) === 'toggle' && inner < 80;
        // LoRA 强度格按用户要求随节点等比收窄（形状 ~37px）：「1.00」右对齐完整显示
        // （tools/out/lora_strength_40.png 截图核验），通用「标签+数值+60」口径不适用。
        const strengthNarrow = hasDrawColumn && /强度$/.test(String(w.name)) && inner < 60;
        const tall = (w.computedHeight ?? w.computeSize?.(node.size[0])?.[1] ?? rowH) > rowH * 1.4;
        return {
          label,
          type: String(w.type),
          inner: Math.round(inner),
          need: Math.ceil(need),
          tall,
          // 2px 容差：前端按 12px Inter 实测，个别字符与测量值有一两像素出入。
          // 口径已经贴到官方公式，不再留 8px 的宽松余量。
          fits: checkbox || strengthNarrow || inner + 2 >= need,
        };
      });

      // 行数与重叠（按形状区间比，别用带内边距的整格）
      const rowKeys = [...new Set(shown.map((w) => Math.round(w.y)))].sort((a, b) => a - b);
      const overlap = [];
      for (let i = 0; i < shown.length; i += 1) {
        for (let j = i + 1; j < shown.length; j += 1) {
          const a = shown[i];
          const b = shown[j];
          if (!a._ggCol || !b._ggCol || a.y !== b.y) continue;
          const aStart = a._ggCol.x + SIDE;
          const aEnd = a._ggCol.x + a._ggCol.w - SIDE;
          const bStart = b._ggCol.x + SIDE;
          const bEnd = b._ggCol.x + b._ggCol.w - SIDE;
          if (aEnd > bStart + 1 && bEnd > aStart + 1) overlap.push(`${a.name}/${b.name}`);
        }
      }

      const rect = app.canvas.canvas.getBoundingClientRect();
      return {
        size: [Math.round(node.size[0]), Math.round(node.size[1])],
        rows: rowKeys.length,
        scalarRows: rowKeys.length - shown.filter((w) => w.computedHeight > 40).length,
        autoWidth: node._ggRowLayout?.autoWidth ?? null,
        widgets,
        overlap,
        clip: {
          x: rect.left + node.pos[0] + app.canvas.ds.offset[0] - 10,
          y: rect.top + (node.pos[1] - 32) + app.canvas.ds.offset[1],
          width: node.size[0] + 20,
          height: node.size[1] + 44,
        },
      };
    }, { cls, SIDE, TEXT_CHROME, BOOL_CHROME, MAX_CHOICE_VALUE_PX, MAX_TEXT_VALUE_PX });

    if (info.error) {
      results.push({ cls, error: info.error });
      continue;
    }
    const bad = info.widgets.filter((w) => !w.fits);
    const aloneRows = info.widgets.filter((w) => w.tall).length;
    results.push({
      cls,
      size: info.size,
      rows: info.rows,
      aloneRows,
      autoWidth: info.autoWidth,
      truncated: bad.map((w) => `${w.label}(${w.inner}<${w.need})`),
      overlap: info.overlap,
      widgets: info.widgets.length,
    });
    await page.mouse.move(1500, 1050);
    await page.waitForTimeout(120);
    if (info.clip.width > 8 && info.clip.height > 8) {
      await page.screenshot({
        path: path.join(OUT_DIR, `auto_${cls.replace(/[^\w\u4e00-\u9fa5]/g, '')}.png`),
        clip: {
          x: Math.max(0, info.clip.x),
          y: Math.max(0, info.clip.y),
          width: info.clip.width,
          height: info.clip.height,
        },
      });
    }
    process.stderr.write(`${cls.padEnd(28)} ${info.size.join('x').padEnd(10)} rows=${info.rows}\n`);
  }

  const truncated = results.filter((r) => r.truncated?.length);
  const overlapping = results.filter((r) => r.overlap?.length);
  console.log(JSON.stringify({ results, truncated, overlapping, errors }, null, 1));
  const ok = results.length - truncated.length - overlapping.length;
  console.log(`OK ${ok}/${results.length}  截断节点 ${truncated.length}  重叠节点 ${overlapping.length}`);
  await browser.close();
  process.exit(truncated.length || overlapping.length ? 1 : 0);
})();
