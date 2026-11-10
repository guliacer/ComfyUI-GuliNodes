// 回归：GGImageLoad 的「快捷按钮 + 预览面板」在各种坏时序下都必须回来
//
// 背景（用户反馈）：图像加载节点上的四个快捷按钮不见了，遮罩文件还变成了单行文本框。
// 根因有两条，这里逐条钉死：
//   1) setupNode 原来「先置位 _ggImageLoaderInstalled = true 再创建」，中间任何一步
//      抛错（addDOMWidget 未就绪、DOM 层没挂好、读档时机早于定位层）都会把节点永久
//      标成已装，于是按钮再也不出现，而且没有任何重试机会。
//   2) 后端把「遮罩文件」定义成 STRING，前端只能渲染成一行文本框，与「图像」的文件
//      选择控件形态不一致。
//
// 断言：
//   A 新建节点 → 4 个快捷按钮、文字齐全、遮罩文件是 combo 且默认空串
//   B 创建过程中抛错 → 不置「已装」标记，恢复后同一节点能装成功
//   C 重复驱动 setup → 幂等，只有一份面板
//   D 面板消失（DOM 被清掉）→ ensureMounted 能把面板补回来
//   E 全程零 pageerror、零本模块 console error
const { chromium } = require('playwright');
const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out';
const URL = 'http://127.0.0.1:8188/';

const EXPECT_ACTIONS = ['粘贴', '蒙版', '裁剪', '选择文件上传'];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(
    `C:/Users/Admin/AppData/Local/Temp/gg-loader-res-${Date.now()}`,
    {
      headless: true,
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      viewport: { width: 1400, height: 1000 },
      args: ['--no-proxy-server'],
    },
  );
  const page = ctx.pages()[0] || (await ctx.newPage());
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // 环境噪音：外部扩展 gulips.bridge 启动报 io is not defined、CSP report-only 报告
    if (/gulips\.bridge|io is not defined|report-only|Content Security Policy/i.test(t)) return;
    consoleErrors.push(t);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3500);

  const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

  // ---------- A：新建节点 ----------
  const a = await page.evaluate(async () => {
    const app = window.app;
    app.graph.clear();
    const n = window.LiteGraph.createNode('GGImageLoad');
    app.graph.add(n);
    n.pos = [60, 40];
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    window.__n = n;
    app.canvas.setDirty(true, true);
    app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 2200));
    window.app.ggImageLoader.setup(n);
    await new Promise((r) => setTimeout(r, 600));

    const acts = document.querySelector('.gg-image-loader-actions');
    const mask = n.widgets.find((w) => w.name === '遮罩文件');
    return {
      labels: acts ? [...acts.children].map((b) => b.textContent) : [],
      maskType: mask ? mask.type : null,
      maskValue: mask ? mask.value : '__missing__',
      installed: !!n._ggImageLoaderInstalled,
      hasWidget: !!n._ggImageLoaderPanel?.widget,
      hostCount: document.querySelectorAll('.gg-image-loader-preview').length,
      // 后端给 Combo 带 image_upload 时，前端会偷偷插一个 "upload" 按钮控件
      // 和一张 232px 的 $$canvas-image-preview，与自带面板重复并顶高内容。
      widgetNames: n.widgets.map((w) => w.name),
      lastWidgetBottom: Math.max(...n.widgets.map((w) => (w.y || 0) + (w.computedHeight || 0))),
      nodeHeight: Math.round(n.size[1]),
    };
  });
  check('A1 四个快捷按钮齐全', JSON.stringify(a.labels) === JSON.stringify(EXPECT_ACTIONS), JSON.stringify(a.labels));
  check('A2 遮罩文件是下拉控件', a.maskType === 'combo', `type=${a.maskType}`);
  check('A3 遮罩文件默认空（不自动套目录里的图）', a.maskValue === '', `value=${JSON.stringify(a.maskValue)}`);
  check('A4 面板已装并持有 DOM widget', a.installed && a.hasWidget, `installed=${a.installed} widget=${a.hasWidget}`);
  check('A5 没有前端自动插的 upload / 图像预览控件',
    !a.widgetNames.includes('upload') && !a.widgetNames.some((x) => String(x).includes('canvas-image-preview')),
    JSON.stringify(a.widgetNames));
  check('A6 控件没有溢出节点高度', a.lastWidgetBottom <= a.nodeHeight + 2,
    `bottom=${a.lastWidgetBottom} nodeH=${a.nodeHeight}`);

  await page.screenshot({ path: `${SHOT}/loader_res_A.png`, clip: { x: 40, y: 30, width: 460, height: 520 } });

  // ---------- B：创建期抛错 → 不许留「已装」标记 ----------
  const b = await page.evaluate(async () => {
    const app = window.app;
    app.graph.clear();
    const n = window.LiteGraph.createNode('GGImageLoad');
    app.graph.add(n);
    n.pos = [60, 40];
    window.__n2 = n;
    n._ggImageLoaderInstalled = false;
    n._ggImageLoaderPanel = null;
    document.querySelectorAll('.gg-image-loader-preview').forEach((el) => el.remove());

    // 1) 让面板创建那一刻必然抛错（模拟定位层未就绪 / addDOMWidget 拒绝）
    const proto = Object.getPrototypeOf(n);
    const original = proto.addDOMWidget;
    proto.addDOMWidget = () => { throw new Error('模拟 addDOMWidget 未就绪'); };

    let threw = false;
    try { window.app.ggImageLoader.setup(n); } catch (_) { threw = true; }
    const afterFail = {
      installed: !!n._ggImageLoaderInstalled,
      hasWidget: !!n._ggImageLoaderPanel?.widget,
    };

    // 2) 恢复后同一节点再驱动一次，必须装上
    proto.addDOMWidget = original;
    window.app.ggImageLoader.setup(n);
    await new Promise((r) => setTimeout(r, 600));
    const acts = document.querySelector('.gg-image-loader-actions');
    return {
      threw,
      afterFail,
      afterRetry: {
        installed: !!n._ggImageLoaderInstalled,
        hasWidget: !!n._ggImageLoaderPanel?.widget,
        labels: acts ? [...acts.children].map((x) => x.textContent) : [],
      },
    };
  });
  check('B1 创建失败后没有留下「已装」标记', b.afterFail.installed === false && b.afterFail.hasWidget === false,
    `installed=${b.afterFail.installed} widget=${b.afterFail.hasWidget}`);
  check('B2 失败后同一节点能重装成功', b.afterRetry.installed && b.afterRetry.hasWidget
    && JSON.stringify(b.afterRetry.labels) === JSON.stringify(EXPECT_ACTIONS),
    JSON.stringify(b.afterRetry.labels));

  // ---------- C：幂等 ----------
  const c = await page.evaluate(async () => {
    const n = window.__n2;
    for (let i = 0; i < 3; i++) window.app.ggImageLoader.setup(n);
    await new Promise((r) => setTimeout(r, 400));
    const acts = document.querySelector('.gg-image-loader-actions');
    return {
      hostCount: document.querySelectorAll('.gg-image-loader-preview').length,
      labels: acts ? [...acts.children].map((x) => x.textContent) : [],
    };
  });
  check('C1 重复驱动不产生第二份面板', c.hostCount === 1, `hostCount=${c.hostCount}`);
  check('C2 重复驱动按钮不重复堆叠', JSON.stringify(c.labels) === JSON.stringify(EXPECT_ACTIONS), JSON.stringify(c.labels));

  // ---------- D：面板被清掉后能补回 ----------
  const d = await page.evaluate(async () => {
    const n = window.__n2;
    document.querySelectorAll('.gg-image-loader-preview').forEach((el) => el.remove());
    n._ggImageLoaderPanel = null;
    n._ggImageLoaderInstalled = false;
    window.app.ggImageLoader.ensureMounted(n);
    await new Promise((r) => setTimeout(r, 600));
    const acts = document.querySelector('.gg-image-loader-actions');
    return {
      hostCount: document.querySelectorAll('.gg-image-loader-preview').length,
      labels: acts ? [...acts.children].map((x) => x.textContent) : [],
    };
  });
  check('D1 面板丢失后 ensureMounted 能补回', d.hostCount === 1
    && JSON.stringify(d.labels) === JSON.stringify(EXPECT_ACTIONS), `hostCount=${d.hostCount}`);

  // ---------- E：异常 ----------
  // B 场景故意注入的那条错误是我们自己制造的，不能算缺陷；但反过来必须证明
  // 「注入真的走通了 catch 分支」，否则 B1/B2 可能只是空跑。
  const injected = consoleErrors.filter((t) => /模拟 addDOMWidget 未就绪/.test(t));
  const ownErrors = consoleErrors.filter((t) => /gg-image-loader|GGImageLoad/i.test(t) && !/模拟 addDOMWidget 未就绪/.test(t));
  check('E0 注入的创建期异常确实被捕获并记录（防止 B 场景空跑）', injected.length > 0, `${injected.length} 条`);
  check('E1 无 pageerror（反向验证：本机确实会抛外部噪音时才算有效）', pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | ') || 'none');
  check('E2 无本模块 console error', ownErrors.length === 0, ownErrors.slice(0, 3).join(' | ') || 'none');

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果：${pass}/${results.length} 通过`);
  if (pageErrors.length) console.log('PAGEERROR:', pageErrors.slice(0, 4).join('\n'));

  try { await page.evaluate((s) => window.app.loadGraphData(JSON.parse(s)), backup); } catch (_) {}
  await ctx.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
