// 实时冒烟探针：在 8402 的 ComfyUI 上创建 GG 节点，遍历各宽度档，
// 强制标题栏按钮绘制 + 右键菜单，捕获任何运行时异常（尤其 null 矩形崩溃）。
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:8188/';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console:' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1000);

  const result = await page.evaluate(async () => {
    const app = window.app;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    app.graph.clear();
    await sleep(100);

    // 取一个 GG 节点类型
    let cls = null;
    try {
      const info = await (await fetch('/object_info')).json();
      const keys = Object.keys(info).filter((k) => k.startsWith('GG')
        || String(info[k]?.category ?? '').includes('GuliNodes'));
      cls = keys[0];
    } catch (e) { /* ignore */ }
    if (!cls) return { fatal: 'no GG class' };

    let node;
    try { node = window.LiteGraph.createNode(cls); } catch (e) { return { fatal: 'createNode ' + e }; }
    if (!node) return { fatal: 'null node' };
    app.graph.add(node);
    // 强制清掉半安装标记，重跑 installNode 并捕获真实异常
    const installErrors = [];
    node._ggPortListToggleInstalled = false;
    if (Array.isArray(app.extensions)) {
      for (const ext of app.extensions) {
        try { ext.nodeCreated?.(node); } catch (e) { installErrors.push((ext.name || '?') + ' => ' + (e && e.stack || e)); }
      }
    }
    // 保证有端口以触发 port 绘制路径
    if (!node.inputs || node.inputs.length === 0) node.inputs = [{ name: 'in', type: '*', label: 'in' }];
    if (!node.outputs || node.outputs.length === 0) node.outputs = [{ name: 'out', type: '*', label: 'out' }];
    node.pos = [200, 200];
    await sleep(200);

    // 打开三项功能
    try { window.__ggApplyPortListToggle?.(true); } catch (e) {}
    try { window.__ggApplyNodeCollapseButton?.(true); } catch (e) {}
    try { window.__ggApplyNodePinButton?.(true); } catch (e) {}
    await sleep(100);

    // 强制标题栏按钮进入「可见」状态再整图重绘，逐档验证不崩。
    const widths = [320, 260, 200, 150, 120];
    const tiers = {};
    for (const w of widths) {
      node.setSize([w, Math.max(node.size[1], 120)]);
      node._ggPortListNodeHovered = true;
      node._ggPortListCollapseButtonHovered = true;
      node._ggPortListPinButtonHovered = true;
      node._ggPortListButtonHovered = true;
      node.setDirtyCanvas?.(true, true);
      try { app.canvas.draw(true, true); } catch (e) { return { fatal: `draw@${w}: ${e}` }; }
      // 触发菜单 hook（<180 应补全三枚），传非空事件避免原生 hook 空引用
      let menu = [];
      try { menu = (node.getExtraMenuOptions?.({}, []) || []).filter(Boolean).map((o) => o.content); } catch (e) { return { fatal: `menu@${w}: ${e}` }; }
      tiers[w] = menu;
      await sleep(60);
    }

    // 折叠态
    node.flags = node.flags || {};
    node.flags.collapsed = true;
    node._ggPortListNodeHovered = true;
    node.setDirtyCanvas?.(true, true);
    try { app.canvas.draw(true, true); } catch (e) { return { fatal: `draw@collapsed: ${e}` }; }
    let menuCol = [];
    try { menuCol = (node.getExtraMenuOptions?.({}, []) || []).filter(Boolean).map((o) => o.content); } catch (e) { return { fatal: `menu@collapsed: ${e}` }; }

    return {
      cls,
      installed: node._ggPortListToggleInstalled === true,
      installErrors,
      menuType: typeof node.getExtraMenuOptions,
      drawWrapped: String(node.draw).includes('drawNodeWithPortButton'),
      mouseDownWrapped: String(node.onMouseDown).includes('getNodeButtonRects'),
      mouseLeaveWrapped: String(node.onMouseLeave).includes('_ggPortListButtonHovered'),
      menuSrcSample: String(node.getExtraMenuOptions).slice(0, 160),
      hasApplyFns: {
        port: typeof window.__ggApplyPortListToggle,
        collapse: typeof window.__ggApplyNodeCollapseButton,
        pin: typeof window.__ggApplyNodePinButton,
      },
      menuAt150: (() => {
        node.flags = node.flags || {}; node.flags.collapsed = false;
        node.setSize([150, Math.max(node.size[1], 120)]);
        try { return (node.getExtraMenuOptions?.({}, []) || []).filter(Boolean).map((o) => o.content); } catch (e) { return ['ERR:' + e]; }
      })(),
      tiers,
      menuCollapsed: menuCol,
      ok: true,
    };
  });

  await browser.close();

  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'title_tiers.json'), JSON.stringify(result, null, 1), 'utf8');

  console.log('=== 实时冒烟结果 ===');
  console.log(JSON.stringify(result, null, 1));
  console.log('=== 页面异常数:', errors.length, '===');
  for (const e of errors.slice(0, 12)) console.log('  !', e);
  if (result.fatal) { console.log('FATAL', result.fatal); process.exitCode = 1; }
})();
