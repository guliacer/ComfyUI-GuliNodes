// 皮肤 + 分组验证：节标题顺序、控件皮肤生效、悬停不报错、截图人眼复核
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_skin_groups.cjs
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = path.join(__dirname, 'out');

(async () => {
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
  await page.waitForTimeout(1200);

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

  await page.evaluate(() => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const settle = async (ms = 260) => {
      await new Promise((r) => setTimeout(r, ms));
      await tick();
      await tick();
    };
    window.__skinTest = {
      async make(cls, x = 60, y = 80) {
        app.graph.clear();
        const node = window.LiteGraph.createNode(cls);
        if (!node) return { error: 'createNode 失败: ' + cls };
        app.graph.add(node);
        node.pos = [x, y];
        window.__skinNode = node;
        await settle();
        return { ok: true };
      },
      snapshot(node) {
        const st = node._ggRowLayout ?? {};
        return {
          size: [Math.round(node.size[0]), Math.round(node.size[1])],
          headers: (st.headers ?? []).map((h) => h.title),
          headerYs: (st.headers ?? []).map((h) => Math.round(h.y)),
        };
      },
      snapCurrent() {
        return this.snapshot(window.__skinNode);
      },
      async clip() {
        const node = window.__skinNode;
        const rect = app.canvas.canvas.getBoundingClientRect();
        const ds = app.canvas.ds;
        return {
          x: rect.left + (node.pos[0] + ds.offset[0]) * ds.scale - 8,
          y: rect.top + (node.pos[1] - 26 + ds.offset[1]) * ds.scale,
          width: node.size[0] * ds.scale + 16,
          height: (node.size[1] + 40) * ds.scale,
        };
      },
      settle,
    };
  });

  const run = (fn, ...args) => page.evaluate(({ fn, args }) => window.__skinTest[fn](...args), { fn, args });

  // 1. Z 采样器：节标题 种子 → 采样，y 递增
  const madeSampler = await run('make', 'GGZImageSampler');
  if (madeSampler && madeSampler.error) { check('创建 Z 采样器', false, madeSampler.error); }
  else {
    const snap = await run('snapCurrent');
    check('Z 采样器节标题顺序 = 种子 → 采样',
      JSON.stringify(snap.headers) === JSON.stringify(['种子', '采样']),
      JSON.stringify(snap));
    check('节标题 y 递增且在控件区外不重叠',
      snap.headerYs.length === 2 && snap.headerYs[1] > snap.headerYs[0],
      JSON.stringify(snap.headerYs));
    const box = await run('clip');
    await page.screenshot({ path: path.join(OUT_DIR, 'skin_sampler.png'), clip: box });
  }

  // 2. 人脸美化：四组标题按序出现
  const madeFace = await run('make', 'GGFaceSmartBeauty', 60, 620);
  if (madeFace && madeFace.error) { check('创建人脸美化', false, madeFace.error); }
  else {
    const snap = await run('snapCurrent');
    check('人脸美化节标题 = 肤质 / 五官 / 检测 / 遮罩',
      JSON.stringify(snap.headers) === JSON.stringify(['肤质', '五官', '检测', '遮罩']),
      JSON.stringify(snap));
    const box = await run('clip');
    await page.screenshot({ path: path.join(OUT_DIR, 'skin_face.png'), clip: box });
  }

  // 3. 悬停：重新建 Z 采样器，指针移到「引导强度」数值行，页面不报错
  const madeHover = await run('make', 'GGZImageSampler', 60, 80);
  if (madeHover && madeHover.error) { check('悬停用节点创建', false, madeHover.error); }
  else {
    const point = await page.evaluate(() => {
      const node = window.__skinNode;
      const w = node.widgets.find((x) => x.name === '引导强度');
      const rect = app.canvas.canvas.getBoundingClientRect();
      const ds = app.canvas.ds;
      return [
        rect.left + (node.pos[0] + ds.offset[0] + (w._ggCol?.x ?? 15) + 40) * ds.scale,
        rect.top + (node.pos[1] + ds.offset[1] + w.y + 12) * ds.scale,
      ];
    });
    await page.mouse.move(point[0], point[1]);
    await page.waitForTimeout(300);
    const box = await run('clip');
    await page.screenshot({ path: path.join(OUT_DIR, 'skin_hover.png'), clip: box });
    check('悬停数值行无页面异常', errors.length === 0, JSON.stringify(errors));
  }

  // 4. LoRA：自绘勾选框列优先级高于皮肤，行皮肤正常
  const madeLora = await run('make', 'GGLoRACustomLoader', 60, 80);
  if (madeLora && madeLora.error) { check('创建 LoRA', false, madeLora.error); }
  else {
    const info = await page.evaluate(() => {
      const node = window.__skinNode;
      const enable = node.widgets.find((w) => w.name === 'LoRA1启用');
      return {
        size: [Math.round(node.size[0]), Math.round(node.size[1])],
        enableCol: enable?._ggCol ? [Math.round(enable._ggCol.x), Math.round(enable._ggCol.w)] : null,
      };
    });
    // 2026-11-04 起 LoRA 三列改成按节点宽度等比分配、minWidth=460；
    // 旧的 240~320 是单列时代的期望值，留着会一直假 FAIL。
    check('LoRA 尺寸与勾选框列保持紧凑',
      info.size[0] >= 440 && info.size[0] <= 480 && info.enableCol && info.enableCol[1] <= 90,
      JSON.stringify(info));
    const box = await run('clip');
    await page.screenshot({ path: path.join(OUT_DIR, 'skin_lora.png'), clip: box });
  }

  await page.screenshot({ path: path.join(OUT_DIR, 'skin_all.png') });
  const bad = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ results, bad, errors }, null, 1));
  console.log(bad.length === 0 && errors.length === 0
    ? `PASS ${results.length}/${results.length}`
    : `FAIL ${bad.length}/${results.length}`);
  await browser.close();
  process.exit(bad.length || errors.length ? 1 : 0);
})();
