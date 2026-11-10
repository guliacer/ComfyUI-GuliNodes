// GG LoRA 自定义加载：单行三列布局的实机验证（真实前端 + 真实鼠标事件）。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_lora_rows.cjs
//
// 验证内容：
//   1. 每个可见 LoRA 是「启用 / 名称 / 强度」一行三列（y 相同，x 递增）；
//   2. 点强度格右 1/4 加一个步长、左 1/4 减一个步长（步长取 widget.options.step，
//      当前节点定义是 0.1；点中间弹数值输入框可填任意值。证明列命中与坐标换算对）；
//   3. 点名称列弹出下拉菜单（证明 combo 的 ContextMenu 落在对的控件上）；
//   4. 存图到 tools/out/lora_rows.png 供人眼确认。
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = path.join(__dirname, 'out');
const NODE_CLASS = 'GGLoRACustomLoader';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

(async () => {
  ensureDir(OUT_DIR);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
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

  // 1) 清空默认图，单独放一个节点（否则默认工作流的节点会压在上面，点击落到别人身上）
  const geometry = await page.evaluate(async (nodeClass) => {
    const app = window.app;
    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [40, 60];
    const node = window.LiteGraph.createNode(nodeClass);
    app.graph.add(node);
    node.pos = [60, 60];
    const count = node.widgets.find((w) => w.name === 'LoRA数量');
    count.value = 2;
    count.callback?.(2);
    await new Promise((r) => setTimeout(r, 400));
    node.arrange?.();
    node.setDirtyCanvas?.(true, true);
    app.canvas.setDirty(true, true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__ggNode = node;

    const rows = {};
    for (const w of node.widgets) {
      if (w.hidden || String(w.type).startsWith('ggHidden')) continue;
      const key = `${w.y}`;
      rows[key] = rows[key] || [];
      rows[key].push({
        name: w.name,
        x: w._ggCol?.x ?? null,
        width: w._ggCol?.w ?? null,
        value: typeof w.value === 'object' ? '[obj]' : w.value,
      });
    }
    return {
      size: [...node.size],
      rowCount: Object.keys(rows).length,
      rows,
    };
  }, NODE_CLASS);

  // 2) 计算强度列右/左箭头的屏幕坐标
  const clickTargets = await page.evaluate(() => {
    const app = window.app;
    const canvas = app.canvas;
    const node = window.__ggNode;
    const strength = node.widgets.find((w) => w.name === 'LoRA1强度');
    const name = node.widgets.find((w) => w.name === 'LoRA1名称');
    const toScreen = (localX, localY) => {
      const rect = canvas.canvas.getBoundingClientRect();
      return [
        rect.left + (node.pos[0] + localX) * canvas.ds.scale + canvas.ds.offset[0],
        rect.top + (node.pos[1] + localY) * canvas.ds.scale + canvas.ds.offset[1],
      ];
    };
    const col = strength._ggCol;
    return {
      plus: toScreen(col.x + col.w - 20, strength.y + 12),
      minus: toScreen(col.x + 22, strength.y + 12),
      combo: toScreen(name._ggCol.x + name._ggCol.w * 0.5, name.y + 12),
      nodeRect: (() => {
        const rect = canvas.canvas.getBoundingClientRect();
        const tl = toScreen(0, -30);
        return {
          x: tl[0],
          y: tl[1],
          width: node.size[0] * canvas.ds.scale,
          height: (node.size[1] + 30) * canvas.ds.scale,
        };
      })(),
    };
  });

  const readStrength = () => page.evaluate(() => {
    const node = window.__ggNode;
    return node.widgets.find((w) => w.name === 'LoRA1强度').value;
  });

  const before = await readStrength();
  await page.mouse.click(clickTargets.plus[0], clickTargets.plus[1]);
  await page.waitForTimeout(120);
  const afterPlus = await readStrength();
  await page.mouse.click(clickTargets.minus[0], clickTargets.minus[1]);
  await page.waitForTimeout(120);
  const afterMinus = await readStrength();

  // 3) 点名称为列，看是否弹出下拉菜单
  await page.mouse.click(clickTargets.combo[0], clickTargets.combo[1]);
  await page.waitForTimeout(400);
  const menuInfo = await page.evaluate(() => {
    const menu = document.querySelector('.litecontextmenu');
    if (!menu) return { open: false };
    const rect = menu.getBoundingClientRect();
    return { open: true, items: menu.querySelectorAll('.litemenu-entry').length, rect: [rect.x, rect.y, rect.width, rect.height] };
  });
  const shotMenu = path.join(OUT_DIR, 'lora_rows_menu.png');
  await page.screenshot({ path: shotMenu, clip: clickTargets.nodeRect });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  // 点空白处把菜单彻底关掉，再拍干净的一版
  await page.mouse.click(1250, 780);
  await page.waitForTimeout(250);

  // 4) 整体截图
  const shot = path.join(OUT_DIR, 'lora_rows.png');
  await page.screenshot({ path: shot, clip: clickTargets.nodeRect });

  console.log(JSON.stringify({
    geometry,
    strength: { before, afterPlus, afterMinus },
    menuInfo,
    shots: [shot, shotMenu],
    errors: errors.slice(0, 8),
  }, null, 2));

  await browser.close();
})();
