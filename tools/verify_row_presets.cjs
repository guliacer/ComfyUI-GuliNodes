// 批量验证：登记了单行列布局的节点能否正常建、行是否成形、点击是否落对格子。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_row_presets.cjs
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = path.join(__dirname, 'out');
const TARGETS = [
  'GG色彩校正',
  'GGImageCompressSave',
  'GG反推模型',
  'GGVideoBridgeFromImageAudio',
  'GG纯色图像',
  'GGInpaintCrop',
  'GGLoRACustomLoader',
  'GGZImageSampler',
];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1200);

  const results = [];
  for (const target of TARGETS) {
    const info = await page.evaluate(async (cls) => {
      const app = window.app;
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      app.graph.clear();
      app.canvas.ds.scale = 1;
      app.canvas.ds.offset = [40, 60];
      const node = window.LiteGraph.createNode(cls);
      if (!node) return { ok: false, reason: 'createNode 失败' };
      app.graph.add(node);
      node.pos = [60, 60];
      await new Promise((r) => setTimeout(r, 350));
      node.arrange?.();
      app.canvas.setDirty(true, true);
      await tick();
      window.__last = node;

      const shown = node.widgets.filter((w) => !w.hidden && !String(w.type).startsWith('ggHidden'));
      const rows = {};
      for (const w of shown) {
        const key = String(w.y);
        (rows[key] = rows[key] || []).push({ name: w.name, col: w._ggCol ? [w._ggCol.x, w._ggCol.w] : null });
      }
      // _ggCol 的矩形带左右内边距（SIDE=15，就是 BaseWidget.margin），相邻格必然
      // 「矩形相交」，那不是问题。要查的是控件形状本体有没有压在一起，按形状区间比。
      const SIDE = 15;
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
          if (aEnd > bStart + 1 && bEnd > aStart + 1) overlap.push([a.name, b.name]);
        }
      }
      const rect = app.canvas.canvas.getBoundingClientRect();
      const scale = app.canvas.ds.scale;
      return {
        ok: true,
        size: [...node.size],
        computeSize: node.computeSize(),
        rows: Object.keys(rows).length,
        rowDetail: rows,
        overlap,
        clip: {
          x: rect.left + node.pos[0] * scale + app.canvas.ds.offset[0] - 6,
          y: rect.top + (node.pos[1] - 30) * scale + app.canvas.ds.offset[1],
          width: node.size[0] * scale + 12,
          height: (node.size[1] + 36) * scale,
        },
      };
    }, target);

    const shot = path.join(OUT_DIR, `rows_${target.replace(/[^\w\u4e00-\u9fa5]/g, '')}.png`);
    if (info.ok && info.clip?.width > 8 && info.clip?.height > 8) {
      await page.screenshot({ path: shot, clip: info.clip });
    }
    results.push({ target, ...info, shot: info.ok ? shot : null });
  }

  console.log(JSON.stringify({ results, errors: errors.slice(0, 6) }, null, 2));
  await browser.close();
})();
