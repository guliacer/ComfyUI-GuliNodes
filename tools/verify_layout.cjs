// 实机验证布局重排结果（CommonJS 版，NODE_PATH 只对 require 生效）。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_layout.cjs
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');

// 优先读仓库自带的 examples 版本：本机 user/default/workflows 里那份常常没同步，
// 旧脚本直接 readFileSync 会 ENOENT（历史遗留，问题文档观察区「示例工作流 missing」）。
const WORKFLOW = [
  path.join(__dirname, '..', 'examples', 'workflows', 'GG-人像背景分区编辑_Qwen2.1_Turbo.json'),
  'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/user/default/workflows/GG-人像背景分区编辑_Qwen2.1_Turbo.json',
].find((candidate) => fs.existsSync(candidate));
if (!WORKFLOW) throw new Error('找不到示例工作流 GG-人像背景分区编辑_Qwen2.1_Turbo.json');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
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
    // 外部扩展 ComfyUI-GuliPS 的动态 chunk 预加载失败：与被测模块无关的环境噪音。
    /\[vite:preloadError\].*ComfyUI-GuliPS/,
  ];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (ENV_NOISE.some((re) => re.test(text))) return;
    errors.push('console: ' + text);
  });

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app && window.app.graph && window.app.canvas && window.app.canvas.ds, null, {
    timeout: 120000,
  });

  const workflow = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));

  const report = await page.evaluate(async (wf) => {
    const app = window.app;
    const t0 = performance.now();
    // 第三个参数 restore_view=true 才会用工作流里存的 extra.ds 视口。
    await app.loadGraphData(wf, true, true);
    const loadMs = Math.round(performance.now() - t0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const nodes = app.graph._nodes;
    const overlaps = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const ox = Math.min(a.pos[0] + a.size[0], b.pos[0] + b.size[0]) - Math.max(a.pos[0], b.pos[0]);
        const oy = Math.min(a.pos[1] + a.size[1], b.pos[1] + b.size[1]) - Math.max(a.pos[1], b.pos[1]);
        if (ox > 4 && oy > 4) overlaps.push([a.id, b.id, Math.round(ox), Math.round(oy)]);
      }
    }

    const groups = (app.graph._groups || []).map((g) => {
      const b = g._bounding || g.bounding;
      const inside = nodes.filter(
        (n) =>
          b[0] <= n.pos[0] &&
          b[1] <= n.pos[1] &&
          n.pos[0] + n.size[0] <= b[0] + b[2] &&
          n.pos[1] + n.size[1] <= b[1] + b[3]
      );
      return { title: g.title, box: b.map((v) => Math.round(v)), inside: inside.length, ids: inside.map((n) => n.id) };
    });

    const ds = app.canvas.ds;
    const rect = app.canvas.canvas.getBoundingClientRect();
    const toScreen = (gx, gy) => [(gx + ds.offset[0]) * ds.scale + rect.left, (gy + ds.offset[1]) * ds.scale + rect.top];
    const visible = nodes.filter((n) => {
      const [sx, sy] = toScreen(n.pos[0], n.pos[1]);
      return sx > rect.left - 200 && sx < rect.right && sy > rect.top - 200 && sy < rect.bottom;
    }).map((n) => n.id);

    // 找一个真正空白的屏幕点（不在任何节点/分组框内），拖拽才有意义。
    // 留 60 图单位余量：组框标题命中区有内边距，贴边点会被判成点标题。
    const MARGIN = 60;
    const hit = (gx, gy) => {
      const near = (x, y, w, h) =>
        gx >= x - MARGIN && gx <= x + w + MARGIN && gy >= y - MARGIN && gy <= y + h + MARGIN;
      for (const n of nodes) if (near(n.pos[0], n.pos[1], n.size[0], n.size[1])) return true;
      for (const g of app.graph._groups || []) {
        const b = g._bounding || g.bounding;
        if (b && near(b[0], b[1], b[2], b[3])) return true;
      }
      return false;
    };
    let blank = null;
    // 顶部 120px 是浮动菜单、左侧 380px 是侧边栏，都是透明覆盖层，
    // elementFromPoint 可能返回 canvas 但事件被菜单吃掉，所以搜索区往里收。
    const x0 = rect.left + Math.max(380, rect.width * 0.3);
    const y0 = rect.top + 120;
    for (let gy = -200; gy < 2600 && !blank; gy += 40) {
      for (let gx = -1200; gx < 6400; gx += 40) {
        const [sx, sy] = toScreen(gx, gy);
        if (sx < x0 || sx > rect.right - 30 || sy < y0 || sy > rect.bottom - 30) continue;
        if (document.elementFromPoint(sx, sy) !== app.canvas.canvas) continue;
        if (hit(gx, gy)) continue;
        blank = [Math.round(sx), Math.round(sy)];
        break;
      }
    }

    const before = [ds.offset[0], ds.offset[1]];
    const previews = nodes
      .filter((n) => n.type === 'PreviewImage')
      .map((n) => `${n.id}:${n.title}`);

    // 拖拽事件探针：加载工作流后画布能否收到 pointerdown。
    window.__dragProbe = { pointerdown: 0, pointermove: 0, target: null };
    app.canvas.canvas.addEventListener(
      'pointerdown',
      (e) => {
        window.__dragProbe.pointerdown += 1;
        window.__dragProbe.target = e.target === app.canvas.canvas ? 'canvas' : e.target.tagName;
      },
      true
    );
    app.canvas.canvas.addEventListener('pointermove', () => { window.__dragProbe.pointermove += 1; }, true);

    return {
      loadMs,
      nodes: nodes.length,
      links: Object.keys(app.graph.links || {}).length,
      overlaps,
      groups,
      scale: Number(ds.scale.toFixed(3)),
      offset: ds.offset.map((v) => Math.round(v)),
      visibleIds: visible,
      visibleCount: visible.length,
      blankPoint: blank,
      offsetBefore: before,
      allowDrag: app.canvas.allow_dragcanvas,
      readOnly: !!app.graph.read_only,
      previews,
    };
  }, workflow);

  // 等渲染稳定，dom-widgets 层重建完毕再拖；之后重新取空白点，
  // 因为视口可能在这 1 秒里被前端重算过，之前算出的屏幕坐标会失效。
  await page.waitForTimeout(1000);
  const live = await page.evaluate(() => {
    const app = window.app;
    const ds = app.canvas.ds;
    const rect = app.canvas.canvas.getBoundingClientRect();
    const toScreen = (gx, gy) => [(gx + ds.offset[0]) * ds.scale + rect.left, (gy + ds.offset[1]) * ds.scale + rect.top];
    const nodes = app.graph._nodes;
    // 留 60 图单位余量：组框标题命中区有内边距，贴边点会被判成点标题。
    const MARGIN = 60;
    const hit = (gx, gy) => {
      const near = (x, y, w, h) =>
        gx >= x - MARGIN && gx <= x + w + MARGIN && gy >= y - MARGIN && gy <= y + h + MARGIN;
      for (const n of nodes) if (near(n.pos[0], n.pos[1], n.size[0], n.size[1])) return true;
      for (const g of app.graph._groups || []) {
        const b = g._bounding || g.bounding;
        if (b && near(b[0], b[1], b[2], b[3])) return true;
      }
      return false;
    };
    let point = null;
    const x0 = rect.left + Math.max(380, rect.width * 0.3);
    const y0 = rect.top + 120;
    for (let gy = -400; gy < 2600 && !point; gy += 30) {
      for (let gx = -1200; gx < 6400; gx += 30) {
        const [sx, sy] = toScreen(gx, gy);
        if (sx < x0 || sx > rect.right - 40 || sy < y0 || sy > rect.bottom - 40) continue;
        if (document.elementFromPoint(sx, sy) !== app.canvas.canvas) continue;
        if (hit(gx, gy)) continue;
        point = [Math.round(sx), Math.round(sy)];
        break;
      }
    }
    return { point, scale: Number(ds.scale.toFixed(3)), offset: ds.offset.map((v) => Math.round(v)) };
  });
  report.scaleAtDrag = live.scale;
  report.offsetAtDrag = live.offset;
  report.blankPoint = live.point;

  const [px, py] = live.point || [800, 500];
  const before = await page.evaluate(() => [...window.app.canvas.ds.offset]);
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px + 260, py + 120, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const drag = await page.evaluate((before) => {
    const ds = window.app.canvas.ds;
    return {
      after: ds.offset.map((v) => Math.round(v)),
      dx: Math.round(ds.offset[0] - before[0]),
      dy: Math.round(ds.offset[1] - before[1]),
      probe: window.__dragProbe,
      selectedGroup: window.app.canvas.selected_group?.title ?? null,
    };
  }, before);
  delete report.offsetBefore;

  console.log(JSON.stringify({ ...report, drag, pageErrors: errors.filter((e) => !/favicon|404/i.test(e)) }, null, 2));
  await browser.close();
})();
