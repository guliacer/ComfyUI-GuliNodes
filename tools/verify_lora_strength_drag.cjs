// GG LoRA 自定义加载：强度显示/编辑、按钮居中、拖拽手柄重排 的实机回归。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_lora_strength_drag.cjs
//
// 覆盖：
//   1. 新前端代码确实加载（pointer 捕获已装 + 强度 precision=2）；
//   2. 强度格画出 0.50 / 0.80 / 1.20（窄列紧凑数值，不再是空白）；
//   3. 点强度格中间弹输入框，输入 0.75 后值真的写回；
//   4. 点强度格左 / 右 1/4 区真的减 / 加一个步长，节点不被拖走；
//   5. 「新增LoRA」按钮默认宽与拉宽后都水平居中；
//   6. 启用列画出六点拖拽手柄（每行 6 个 r=1.2 圆点）；
//   7. 真实鼠标从 LoRA1 手柄拖到 LoRA3，三行 启用/名称/强度 整组换序；
//   8. serialize -> loadGraphData 读档后顺序不变；
//   9. 全程无 pageerror，收尾把用户画布装回去。
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = path.join(__dirname, 'out');
const NODE_CLASS = 'GGLoRACustomLoader';
const SIDE = 15;
const MIN_NODE_WIDTH = 280;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
}
const near = (a, b, tol = 2) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

// 异常收集统一口径（问题文档第 5 条）：外部扩展 gulips.bridge 启动时抛
// `io is not defined`，被 ComfyUI 用 console.error 兜住，属环境噪音；
// pageerror 全收，console error 里提到本模块文件的才算异常，其余单独归类。
// 不能无脑忽略全部 console error，否则「无脚本异常」会空跑。
const OWN_MODULE = /gg-lora-custom-loader|gg-lora-group-loader|gg-widget-rows|gg-ui-design|lora_tools/i;
const isOwnModuleError = (text) => OWN_MODULE.test(String(text));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  const missingResources = [];
  const externalNoise = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() === 404) missingResources.push(r.url()); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // 本机缺预览素材会刷一堆 404，属于环境噪音；由 response 钩子单独归类核对。
    if (/Failed to load resource/.test(m.text())) return;
    const text = m.text();
    if (!isOwnModuleError(text)) { externalNoise.push('console: ' + text); return; }
    errors.push('console: ' + text);
  });

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const toScreen = (local) => page.evaluate(([lx, ly]) => {
    const app = window.app;
    const rect = app.canvas.canvas.getBoundingClientRect();
    return [
      rect.left + (window.__ggNode.pos[0] + lx) * app.canvas.ds.scale + app.canvas.ds.offset[0],
      rect.top + (window.__ggNode.pos[1] + ly) * app.canvas.ds.scale + app.canvas.ds.offset[1],
    ];
  }, local);

  const readRows = () => page.evaluate(() => {
    const node = window.__ggNode;
    const rows = (node._ggRowLayout?.rows ?? []).filter((r) => r.length > 1);
    return rows.map((row) => {
      const get = (suffix) => row.find((w) => String(w?.name ?? '').endsWith(suffix))?.value;
      return { enable: get('启用'), name: get('名称'), strength: get('强度') };
    });
  });

  // ---------- 造景 ----------
  const setup = await page.evaluate(async ({ nodeClass, SIDE }) => {
    const app = window.app;
    window.__ggSavedGraph = app.graph.serialize();
    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [40, 60];
    const node = window.LiteGraph.createNode(nodeClass);
    app.graph.add(node);
    node.pos = [60, 60];
    const count = node.widgets.find((w) => w.name === 'LoRA数量');
    count.value = 3;
    count.callback?.(3);
    await new Promise((r) => setTimeout(r, 600));
    const vals = [
      ['loraA.safetensors', 0.5, true],
      ['loraB.safetensors', 0.8, false],
      ['loraC.safetensors', 1.2, true],
    ];
    vals.forEach(([n, s, e], i) => {
      const k = i + 1;
      const name = node.widgets.find((w) => w.name === `LoRA${k}名称`);
      const str = node.widgets.find((w) => w.name === `LoRA${k}强度`);
      const en = node.widgets.find((w) => w.name === `LoRA${k}启用`);
      if (name) name.value = n;
      if (str) str.value = s;
      if (en) en.value = e;
    });
    window.__ggNode = node;
    node.setDirtyCanvas(true, true);
    app.canvas.draw(true, true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // 一帧里同时抓 fillText（数值）和 arc（六点手柄）
    const proto = CanvasRenderingContext2D.prototype;
    const origText = proto.fillText;
    const origArc = proto.arc;
    const origRR = proto.roundRect;
    const texts = [];
    const smallDots = [];
    const shadowRects = [];
    proto.fillText = function (t, ...rest) { texts.push(String(t)); return origText.call(this, t, ...rest); };
    proto.arc = function (x, y, r, ...rest) { if (r === 1.2) smallDots.push([x, y, r]); return origArc.call(this, x, y, r, ...rest); };
    proto.roundRect = function (x, y, w, h, r) {
      if (this.shadowBlur > 0) shadowRects.push([x, y, w, h]);
      return origRR.call(this, x, y, w, h, r);
    };
    try { app.canvas.draw(true, true); } finally {
      proto.fillText = origText;
      proto.arc = origArc;
      proto.roundRect = origRR;
    }

    const str = node.widgets.find((w) => w.name === 'LoRA1强度');
    const btn = node.widgets.find((w) => w.name === '新增LoRA');
    const en = node.widgets.find((w) => w.name === 'LoRA1启用');
    const s3 = node.widgets.find((w) => w.name === 'LoRA3启用');
    return {
      size: [...node.size],
      pointerInstalled: !!app.canvas.canvas._ggLoraPointerInstalled,
      precision: str?.options?.precision,
      step: str?.options?.step,
      min: str?.options?.min,
      max: str?.options?.max,
      texts,
      dots: smallDots.length,
      shadowRects,
      enableGeometry: en?._ggEnableGeometry ? {
        shape: en._ggEnableGeometry.shape,
        handle: en._ggEnableGeometry.handle,
        toggle: en._ggEnableGeometry.toggle,
        gap: en._ggEnableGeometry.gap,
      } : null,
      strengthShape: [str._ggCol.x + SIDE, str._ggCol.x + str._ggCol.w - SIDE],
      strengthY: str.y + 12,
      buttonCenter: btn._ggCol.x + btn._ggCol.w / 2,
      buttonW: btn._ggCol.w,
      row3Y: s3.y + 12,
      handleCenter: [en._ggCol.x + 21, en.y + 12],
      posBefore: [...node.pos],
    };
  }, { nodeClass: NODE_CLASS, SIDE });

  // ---------- 1. 新代码已加载 ----------
  check('前端新代码已加载（pointer 捕获 + precision=2）',
    setup.pointerInstalled && setup.precision === 2,
    { pointerInstalled: setup.pointerInstalled, precision: setup.precision });

  // ---------- 2. 强度值真的画出来 ----------
  const drawn = ['0.50', '0.80', '1.20'].map((t) => setup.texts.includes(t));
  check('强度格画出 0.50 / 0.80 / 1.20', drawn.every(Boolean),
    { found: drawn, texts: setup.texts.filter((t) => /^\d/.test(t)) });

  // ---------- 3. 按钮居中（默认宽 + 拉宽） ----------
  check('新增LoRA 按钮默认宽水平居中',
    near(setup.buttonCenter, setup.size[0] / 2),
    { center: setup.buttonCenter, half: setup.size[0] / 2, w: setup.buttonW });

  const narrow = await page.evaluate(({ width }) => {
    const node = window.__ggNode;
    node.size[0] = width;
    node.setDirtyCanvas(true, true);
    const proto = CanvasRenderingContext2D.prototype;
    const original = proto.fillText;
    const drawn = [];
    proto.fillText = function (text, ...args) {
      drawn.push(String(text));
      return original.call(this, text, ...args);
    };
    try { window.app.canvas.draw(true, true); } finally { proto.fillText = original; }
    const strengths = node.widgets.filter((widget) => /LoRA\\d+强度/.test(widget.name));
    return {
      width: node.size[0],
      values: strengths.map((widget) => Number(widget.value).toFixed(2)),
      drawn: drawn.filter((text) => /^\\d/.test(text)),
    };
  }, { width: MIN_NODE_WIDTH });
  check(`最小节点宽度 ${MIN_NODE_WIDTH}px 下强度数字完整显示`,
    narrow.values.every((value) => narrow.drawn.includes(value)), narrow);
  await page.evaluate(() => {
    const node = window.__ggNode;
    node.size[0] = 460;
    node.setDirtyCanvas(true, true);
    window.app.canvas.draw(true, true);
  });

  const wide = await page.evaluate(() => {
    const app = window.app;
    const node = window.__ggNode;
    node.size[0] = 620;
    node.setDirtyCanvas(true, true);
    app.canvas.draw(true, true);
    const btn = node.widgets.find((w) => w.name === '新增LoRA');
    return { size: [...node.size], center: btn._ggCol.x + btn._ggCol.w / 2 };
  });
  check('节点拉宽到 620 后按钮仍居中',
    near(wide.center, wide.size[0] / 2), wide);
  // 拉宽状态留着，正好验证等比列与紧凑数值在宽节点下也成立
  const wideTexts = await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    const texts = [];
    proto.fillText = function (t, ...rest) { texts.push(String(t)); return orig.call(this, t, ...rest); };
    try { window.app.canvas.draw(true, true); } finally { proto.fillText = orig; }
    return texts;
  });
  check('拉宽后强度值仍显示为紧凑数值',
    ['0.50', '0.80', '1.20'].every((t) => wideTexts.includes(t)),
    wideTexts.filter((t) => /^\d/.test(t)));
  // 还原宽度，后续点击坐标按 460 算
  await page.evaluate(() => {
    const node = window.__ggNode;
    node.size[0] = 460;
    node.setDirtyCanvas(true, true);
    window.app.canvas.draw(true, true);
  });

  // ---------- 4. 六点手柄绘制 + 独立胶囊与窄宽数字 ----------
  check('最窄节点宽度下强度值仍逐字完整绘制',
    await page.evaluate(() => {
      const node = window.__ggNode;
      node.size[0] = 280;
      node.setDirtyCanvas(true, true);
      const proto = CanvasRenderingContext2D.prototype;
      const original = proto.fillText;
      const texts = [];
      proto.fillText = function (text, ...args) {
        texts.push(String(text));
        return original.call(this, text, ...args);
      };
      try { window.app.canvas.draw(true, true); } finally { proto.fillText = original; }
      return ['0.50', '0.80', '1.20'].every((text) => texts.includes(text));
    }),
    { width: 280, values: ['0.50', '0.80', '1.20'] });
  await page.evaluate(() => {
    const node = window.__ggNode;
    node.size[0] = 460;
    node.setDirtyCanvas(true, true);
    window.app.canvas.draw(true, true);
  });
  check('每行启用列画出六点拖拽手柄（3 行共 18 点）',
    setup.dots >= 18, { dots: setup.dots });
  const enableRects = setup.shadowRects.filter(([x]) => near(x, SIDE, 0.5));
  check('启用列分成手柄胶囊 / 空白 / 启用胶囊，且都在列内',
    !!setup.enableGeometry
      && setup.enableGeometry.gap >= 3
      && setup.enableGeometry.handle.right < setup.enableGeometry.toggle.left
      && setup.enableGeometry.shape.left <= setup.enableGeometry.handle.left
      && setup.enableGeometry.toggle.right <= setup.enableGeometry.shape.right,
    setup.enableGeometry);
  check('自绘启用列也吃到胶囊底格 + 投影（3 行各至少 2 个）',
    enableRects.length >= 6,
    { enableRects: enableRects.length, all: setup.shadowRects.length, xs: setup.shadowRects.map((r) => r[0]) });
  check('全节点胶囊投影覆盖分开的启用区域、名称、强度与按钮',
    setup.shadowRects.length >= 10, { count: setup.shadowRects.length });

  // ---------- 5. 点中间弹输入框并写入 0.75 ----------
  const [sLeft, sRight] = setup.strengthShape;
  const sCenter = (sLeft + sRight) / 2;
  const mid = await toScreen([sCenter, setup.strengthY]);
  await page.mouse.click(mid[0], mid[1]);
  await page.waitForTimeout(250);
  const dialog = await page.evaluate(() => {
    const el = document.querySelector('.graphdialog input.value');
    return el ? { open: true, value: el.value } : { open: false };
  });
  check('点强度格中间弹出数值输入框', dialog.open, dialog);

  if (dialog.open) {
    const input = page.locator('.graphdialog input.value');
    await input.fill('0.75');
    await input.press('Enter');
    await page.waitForTimeout(250);
  }
  const afterPrompt = await page.evaluate(() => ({
    value: window.__ggNode.widgets.find((w) => w.name === 'LoRA1强度').value,
    dialogLeft: !!document.querySelector('.graphdialog input.value'),
    pos: [...window.__ggNode.pos],
  }));
  check('输入 0.75 后强度值写回且浮层关闭',
    near(afterPrompt.value, 0.75, 1e-6) && !afterPrompt.dialogLeft, afterPrompt);

  // ---------- 6. 左 / 右 1/4 区步进 ----------
  const step = Number(setup.step) || 0.05;
  const leftPt = await toScreen([sLeft + 3, setup.strengthY]);
  await page.mouse.click(leftPt[0], leftPt[1]);
  await page.waitForTimeout(150);
  const afterLeft = await page.evaluate(() => window.__ggNode.widgets.find((w) => w.name === 'LoRA1强度').value);
  check('点强度格左 1/4 减一个步长',
    near(afterLeft, 0.75 - step, 1e-6), { before: 0.75, after: afterLeft, step });

  const rightPt = await toScreen([sRight - 3, setup.strengthY]);
  await page.mouse.click(rightPt[0], rightPt[1]);
  await page.waitForTimeout(150);
  const afterRight = await page.evaluate(() => window.__ggNode.widgets.find((w) => w.name === 'LoRA1强度').value);
  check('点强度格右 1/4 加一个步长',
    near(afterRight, afterLeft + step, 1e-6), { before: afterLeft, after: afterRight, step });

  const posAfterClicks = await page.evaluate(() => [...window.__ggNode.pos]);
  check('点强度不会顺手把节点拖走',
    near(posAfterClicks[0], setup.posBefore[0], 0.01) && near(posAfterClicks[1], setup.posBefore[1], 0.01),
    { before: setup.posBefore, after: posAfterClicks });

  // ---------- 7. 真实拖拽重排 ----------
  const beforeDrag = await readRows();
  const start = await toScreen(setup.handleCenter);
  const end = await toScreen([setup.handleCenter[0], setup.row3Y]);
  await page.mouse.move(start[0], start[1]);
  await page.mouse.down();
  await page.mouse.move(end[0], end[1], { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const afterDrag = await readRows();
  const expected = [beforeDrag[1], beforeDrag[2], beforeDrag[0]];
  const reordered = JSON.stringify(afterDrag) === JSON.stringify(expected)
    && afterDrag.length === 3;
  check('拖 LoRA1 手柄到 LoRA3 后三行整组换序',
    reordered, { beforeDrag, afterDrag, expected });
  const posAfterDrag = await page.evaluate(() => [...window.__ggNode.pos]);
  check('拖拽重排不会把节点本身拖走',
    near(posAfterDrag[0], setup.posBefore[0], 0.01) && near(posAfterDrag[1], setup.posBefore[1], 0.01),
    { before: setup.posBefore, after: posAfterDrag });

  // ---------- 8. 读档保持 ----------
  const roundtrip = await page.evaluate(async () => {
    const app = window.app;
    const data = app.graph.serialize();
    app.graph.clear();
    app.loadGraphData(data);
    await new Promise((r) => setTimeout(r, 900));
    const node = (app.graph._nodes ?? []).find((n) => n?.comfyClass === 'GGLoRACustomLoader');
    if (!node) return { found: false };
    window.__ggNode = node;
    const rows = (node._ggRowLayout?.rows ?? []).filter((r) => r.length > 1);
    return {
      found: true,
      count: rows.length,
      rows: rows.map((row) => {
        const get = (suffix) => row.find((w) => String(w?.name ?? '').endsWith(suffix))?.value;
        return { enable: get('启用'), name: get('名称'), strength: get('强度') };
      }),
    };
  });
  check('serialize -> loadGraphData 读档后顺序不变',
    roundtrip.found && JSON.stringify(roundtrip.rows) === JSON.stringify(afterDrag),
    roundtrip);

  // ---------- 9. 截图 + 无异常 + 还原画布 ----------
  const shot = path.join(OUT_DIR, 'lora_strength_drag.png');
  try {
    const clip = await page.evaluate(() => {
      const app = window.app;
      const node = window.__ggNode;
      const rect = app.canvas.canvas.getBoundingClientRect();
      return {
        x: rect.left + node.pos[0] * app.canvas.ds.scale + app.canvas.ds.offset[0] - 10,
        y: rect.top + node.pos[1] * app.canvas.ds.scale + app.canvas.ds.offset[1] - 40,
        width: node.size[0] * app.canvas.ds.scale + 20,
        height: node.size[1] * app.canvas.ds.scale + 50,
      };
    });
    await page.screenshot({ path: shot, clip });
  } catch (e) {
    check('截图成功', false, String(e));
  }
  check('全程无页面脚本异常（外部扩展启动噪音单独归类）',
    errors.length === 0, errors.slice(0, 6));
  // 反向验证：本模块自身的错误必须仍被计入，防止「无脚本异常」空跑。
  check('异常过滤器有效，不会把本模块错误当噪音吞掉',
    isOwnModuleError('Uncaught TypeError in gg-lora-custom-loader.js')
      && !isOwnModuleError("Error calling extension 'gulips.bridge' method 'setup': io is not defined")
      && !externalNoise.some((s) => isOwnModuleError(s)),
    { externalNoise: externalNoise.length, sample: externalNoise.slice(0, 2) });
  // 404 必须只是本机缺素材，不能是我们改的前端模块没加载成功。
  const ourFiles = missingResources.filter((u) => /gg-lora-custom-loader|gg-widget-rows|gg-ui-design/.test(u));
  check('404 只来自本机缺预览资源，前端模块无缺失', ourFiles.length === 0,
    { total: missingResources.length, ourFiles, sample: missingResources.slice(0, 4) });

  await page.evaluate(() => {
    const app = window.app;
    if (window.__ggSavedGraph) app.loadGraphData(window.__ggSavedGraph);
  });
  await page.waitForTimeout(300);

  const pass = checks.filter((c) => c.ok).length;
  checks.forEach((c) => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`));
  console.log(`\n${pass}/${checks.length} passed`);
  console.log(JSON.stringify({ setup: { size: setup.size, precision: setup.precision, step, dots: setup.dots, buttonCenter: setup.buttonCenter }, shot, errors: errors.slice(0, 6) }, null, 2));
  await browser.close();
  if (pass !== checks.length) process.exitCode = 1;
})();
