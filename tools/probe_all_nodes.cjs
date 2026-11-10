// 探针：把插件所有节点建一遍，导出控件清单（名称 / 类型 / 值 / 是否多行 / 是否隐藏 /
// 当前节点尺寸），用于决定哪些节点可以套单行列布局、标签要不要收短。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/probe_all_nodes.cjs
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, 'out', 'all_nodes.json');

const CLASSES = [
  'GG纯色图像', 'GG反推模型', 'GG色彩校正', 'GG提示词优化', 'GG图像反推', 'GG图像缩放',
  'GG图像缩放V2', 'GGAspectRatioAdapter', 'GGAspectRatioLatent', 'GGCLIPText', 'GGColorMatch',
  'GGCropRestore', 'GGFaceSkinSmoothing', 'GGFaceSmartBeauty', 'GGGroupControllerM',
  'GGGroupControllerS', 'GGImageAdjust', 'GGImageComparer2', 'GGImageComparer4', 'GGImageCompress',
  'GGImageCompressSave', 'GGImageCrop', 'GGImageMergeMask', 'GGImageObfuscate',
  'GGImageStyleReference', 'GGImageSuperResolution', 'GGImageTransform', 'GGInpaintCrop',
  'GGInteger', 'GGKeyInput', 'GGLightingPrompt', 'GGLoRACustomLoader', 'GGMaskCheck', 'GGMaskCrop',
  'GGMemoryCleanup', 'GGPreviewImage', 'GGPromptEnhancer', 'GGPromptLibrary', 'GGPromptOptimizer',
  'GGRegionEditPrepare', 'GGSaveImage', 'GGSeedGenerator', 'GGSimpleMath', 'GGTextConcat',
  'GGTextDisplayCopy', 'GGTextFileLoad', 'GGTitleNode', 'GGVAE解码', 'GGVideoBridgeFromImageAudio',
  'GGVideoCompress', 'GGVideoLoad', 'GGVideoLoadByPath', 'GGVideoSave', 'GGWebAIReverseImage',
  'GGWebAIReverseText', 'GGZImageSampler',
];

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
  });

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const report = [];
  for (const cls of CLASSES) {
    const info = await page.evaluate(async (cls) => {
      const app = window.app;
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      app.graph.clear();
      let node;
      try {
        node = window.LiteGraph.createNode(cls);
      } catch (e) {
        return { cls, error: String(e) };
      }
      if (!node) return { cls, error: 'createNode 返回 null' };
      app.graph.add(node);
      await new Promise((r) => setTimeout(r, 200));
      await tick();
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = '12px Inter, sans-serif';
      return {
        cls,
        comfyClass: node.comfyClass,
        size: [Math.round(node.size[0]), Math.round(node.size[1])],
        inputs: (node.inputs ?? []).length,
        outputs: (node.outputs ?? []).length,
        widgets: (node.widgets ?? []).map((w) => {
          const options = w.options ?? {};
          const values = options.values;
          const label = String(w.label ?? '').trim();
          return {
            name: w.name,
            label: label || null,
            type: String(w.type ?? ''),
            value: String(w.value ?? '').slice(0, 24),
            hidden: !!w.hidden,
            multiline: options.multiline === true,
            values: Array.isArray(values) ? values.slice(0, 6) : (values && typeof values === 'object' ? Object.keys(values).slice(0, 6) : null),
            valueCount: Array.isArray(values) ? values.length : null,
            labelPx: Math.round(ctx.measureText(label || String(w.name)).width),
            valuePx: Math.round(ctx.measureText(String(w.value ?? '').slice(0, 24)).width),
            custom: typeof w.draw === 'function' || typeof w.drawWidget === 'function',
          };
        }),
      };
    }, cls);
    report.push(info);
    process.stderr.write(`${cls} ${info.error ? 'ERR ' + info.error : (info.widgets?.length ?? 0) + ' widgets'}\n`);
  }

  fs.writeFileSync(OUT, JSON.stringify({ report, errors }, null, 1), 'utf8');
  console.log(`saved ${OUT}`);
  await browser.close();
})();
