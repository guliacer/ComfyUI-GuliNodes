// 老工作流回放：把一张带各类节点的图存成 JSON 再 configure 回来，
// 检查行布局是否自动重建、控件值有没有被改动、有没有重叠。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_workflow_reload.cjs
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SIDE = 15;
const CLASSES = [
  'GG色彩校正',
  'GGImageCompressSave',
  'GG反推模型',
  'GGInpaintCrop',
  'GGLoRACustomLoader'.replace('LoRA', 'LoRA'),
  'GGAspectRatioAdapter',
  'GG图像缩放V2',
  'GGFaceSmartBeauty',
  'GGVideoCompress',
  'GGZImageSampler',
  'GG纯色图像',
  'GGCLIPText',
];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const report = await page.evaluate(async ({ classes, SIDE }) => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const settle = async (ms = 260) => {
      await new Promise((r) => setTimeout(r, ms));
      await tick();
      await tick();
    };

    app.graph.clear();
    const before = [];
    for (const cls of classes) {
      const node = window.LiteGraph.createNode(cls);
      if (!node) continue;
      app.graph.add(node);
      // 只比可见控件的值：`LoRA数量` 这种隐藏槽位在加载时会被节点自己重算，与布局无关
      before.push({ cls, values: Object.fromEntries((node.widgets ?? []).filter((w) => !w.hidden && !String(w.type).startsWith('ggHidden')).map((w) => [w.name, w.value])), size: [Math.round(node.size[0]), Math.round(node.size[1])] });
      await settle(120);
    }
    const data = app.graph.serialize();
    await settle(200);

    // 换一张空图再读回来，模拟打开老工作流
    app.graph.clear();
    await settle(150);
    app.graph.configure(data);
    await settle(500);

    const after = [];
    for (const node of app.graph._nodes) {
      const shown = node.widgets.filter((w) => !w.hidden && !String(w.type).startsWith('ggHidden'));
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
      after.push({
        cls: node.comfyClass,
        values: Object.fromEntries((node.widgets ?? []).filter((w) => !w.hidden && !String(w.type).startsWith('ggHidden')).map((w) => [w.name, w.value])),
        size: [Math.round(node.size[0]), Math.round(node.size[1])],
        rows: [...new Set(shown.map((w) => Math.round(w.y)))].length,
        hasCols: shown.some((w) => w._ggCol),
        overlap,
      });
    }
    return { before, after };
  }, { classes: CLASSES, SIDE });

  const problems = [];
  for (const beforeNode of report.before) {
    const afterNode = report.after.find((item) => item.cls === beforeNode.cls);
    if (!afterNode) {
      problems.push(`${beforeNode.cls} 没读回来`);
      continue;
    }
    // LoRA 的 `LoRA数量` 在加载时会被节点自己按启用槽位重算（0 → 1），与布局无关，
    // 序列化往返另由 tools/verify_lora_roundtrip.cjs 覆盖。
    const skipValues = beforeNode.cls === 'GGLoRACustomLoader';
    if (!skipValues && JSON.stringify(beforeNode.values) !== JSON.stringify(afterNode.values)) {
      problems.push(`${beforeNode.cls} 控件值被改动`);
    }
    if (afterNode.overlap.length) {
      problems.push(`${afterNode.cls} 重叠 ${afterNode.overlap.join(',')}`);
    }
    if (afterNode.cls !== 'GGCLIPText' && !afterNode.hasCols) {
      problems.push(`${afterNode.cls} 没有分列`);
    }
  }

  const table = report.after.map((item) => `${item.cls} ${item.size.join('x')} 行=${item.rows} 分列=${item.hasCols ? '是' : '否'}`);
  console.log(JSON.stringify({ table, problems, errors }, null, 1));
  console.log(problems.length ? `FAIL ${problems.length}` : 'PASS');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})();
