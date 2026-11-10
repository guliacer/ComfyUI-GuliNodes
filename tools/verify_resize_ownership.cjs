// 节点尺寸归属回归：拖大 / 拖小 / 拖窄 / 值变化 / 真实读档五步，每步必须「到位」。
// 背景：官方 resize onDrag 拿 node.computeSize() 当硬下限钳拉力，任何在 computeSize /
// applyHeight / fitNode 里 return max(内容, 手动标记) 的写法都会把「往下拖」实时顶回去，
// 手动标记永远更新不到小值 → 节点只能拉大。本脚本钉死修复后的语义：
//   拖拽中 computeSize 只报纯内容高（行布局）/ 260×420（对比 2 张），引擎停手；
//   松手后 applyHeight 收敛到 max(内容, 标记)；标记随 properties 持久化、读档优先认领。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_resize_ownership.cjs
const { chromium } = require('playwright-core');

const CLASSES = [
  'GGZImageSampler',
  'GGImageCompressSave',
  'GGColorMatch',
  'GGFaceSmartBeauty',
  'GGImageComparer4',
  'GGLoRACustomLoader',
  'GGImageComparer2',
];
// 高度由内容精确贴合管理的节点（功能语义，不是死锁）：只断言宽度与值变化。
const HEIGHT_OWNED_BY_CONTENT = new Set(['GGImageComparer4', 'GGLoRACustomLoader']);

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: ok ? '' : detail });

  for (const kind of CLASSES) {
    const setup = await page.evaluate(async (cls) => {
      const app = window.app;
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      app.graph.clear();
      app.canvas.ds.scale = 1;
      app.canvas.ds.offset = [0, 0];
      const node = window.LiteGraph.createNode(cls);
      if (!node) return null;
      app.graph.add(node);
      node.pos = [80, 60];
      await new Promise((r) => setTimeout(r, 600));
      await tick(); await tick();
      const rect = app.canvas.canvas.getBoundingClientRect();
      const ds = app.canvas.ds;
      return {
        id: node.id,
        sx: rect.left + (node.pos[0] + node.size[0] - 3 + ds.offset[0]) * ds.scale,
        sy: rect.top + (node.pos[1] + node.size[1] - 3 + ds.offset[1]) * ds.scale,
        size: [Math.round(node.size[0]), Math.round(node.size[1])],
      };
    }, kind);
    if (!setup) {
      check(`${kind} 创建节点`, false, 'createNode 失败');
      continue;
    }

    const dragSE = async (dx, dy, label) => {
      const corner = await page.evaluate((nodeId) => {
        const app = window.app;
        const node = app.graph._nodes.find((n) => n.id === nodeId);
        const rect = app.canvas.canvas.getBoundingClientRect();
        const ds = app.canvas.ds;
        return [
          rect.left + (node.pos[0] + node.size[0] - 3 + ds.offset[0]) * ds.scale,
          rect.top + (node.pos[1] + node.size[1] - 3 + ds.offset[1]) * ds.scale,
        ];
      }, setup.id);
      await page.mouse.move(corner[0], corner[1]);
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, 70));
      await page.mouse.move(corner[0] + dx, corner[1] + dy, { steps: 10 });
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 380));
      return page.evaluate((nodeId) => {
        const n = window.app.graph._nodes.find((x) => x.id === nodeId);
        return [Math.round(n.size[0]), Math.round(n.size[1])];
      }, setup.id);
    };

    const s0 = setup.size;
    const s1 = await dragSE(110, 90, '拖大');
    const s2 = await dragSE(-70, -60, '拖小');
    const s3 = await dragSE(-60, 0, '拖窄');
    const s4 = await page.evaluate(async (nodeId) => {
      const node = window.app.graph._nodes.find((n) => n.id === nodeId);
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const numberWidget = (node.widgets || []).find((w) => w.type === 'number' && !w.hidden);
      const comboWidget = (node.widgets || []).find((w) => w.type === 'combo' && !w.hidden);
      if (numberWidget) {
        numberWidget.value = Number(numberWidget.value || 0) + 1;
        numberWidget.callback?.(numberWidget.value);
      } else if (comboWidget && Array.isArray(comboWidget.options?.values) && comboWidget.options.values.length > 1) {
        const list = comboWidget.options.values;
        comboWidget.value = list[(list.indexOf(comboWidget.value) + 1) % list.length];
        comboWidget.callback?.(comboWidget.value);
      }
      await new Promise((r) => setTimeout(r, 380)); await tick(); await tick();
      return [Math.round(node.size[0]), Math.round(node.size[1])];
    }, setup.id);
    const s5 = await page.evaluate(async ([nodeId]) => {
      const app = window.app;
      const data = app.graph.serialize();
      await app.loadGraphData(JSON.parse(JSON.stringify(data)));
      await new Promise((r) => setTimeout(r, 800));
      const n = app.graph._nodes.find((x) => x.id === nodeId)
        || app.graph._nodes.find((x) => (x.comfyClass || x.type) === 'GGZImageSampler' && false)
        || null;
      return n ? [Math.round(n.size[0]), Math.round(n.size[1])] : null;
    }, [setup.id, kind]);
    const s5b = await page.evaluate((cls) => {
      const n = window.app.graph._nodes.find((x) => (x.comfyClass || x.type) === cls);
      return n ? [Math.round(n.size[0]), Math.round(n.size[1])] : null;
    }, kind);
    const s5final = s5b ?? s5;

    const near = (a, b, tol) => !!a && !!b && Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
    const widthNear = (a, b, tol) => !!a && !!b && Math.abs(a[0] - b[0]) <= tol;
    const checkHeight = !HEIGHT_OWNED_BY_CONTENT.has(kind);

    check(`${kind} 拖大生效`, s1[0] > s0[0] + 60 && (!checkHeight || s1[1] > s0[1] + 60), `${JSON.stringify(s0)} -> ${JSON.stringify(s1)}`);
    check(`${kind} 拖小跟手`, s2[0] <= s1[0] - 40 && (!checkHeight || s2[1] <= s1[1] - 40), `${JSON.stringify(s1)} -> ${JSON.stringify(s2)}`);
    check(`${kind} 拖窄跟手`, s3[0] <= s2[0] - 40, `${JSON.stringify(s2)} -> ${JSON.stringify(s3)}`);
    check(`${kind} 值变化不弹回`, near(s4, s3, 4), `${JSON.stringify(s3)} -> ${JSON.stringify(s4)}`);
    check(`${kind} 读档保持`, checkHeight ? near(s5final, s4, 4) : widthNear(s5final, s4, 4), `${JSON.stringify(s4)} -> ${JSON.stringify(s5final)}`);
  }

  check('无页面异常', errors.length === 0, JSON.stringify(errors.slice(0, 3)));

  const passed = checks.filter((c) => c.ok).length;
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  << ' + c.detail}`);
  console.log(`\n${passed}/${checks.length} 通过`);
  await browser.close();
  process.exit(passed === checks.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
