// 回归：DOM widget 定位层修复验证
//   1. 所有 div.dom-widget 的 computed position 必须是 fixed（首帧 relative 会导致流式累加）
//   2. 定位层自身高度必须收为 0，否则透明层会挡住画布事件
//   3. GGWebAIReverseText 的多个多行文本框必须落在节点包围盒内，且两两不重叠
//
// 用法：node tools/verify_dom_widget_layout.cjs
// 前置：ComfyUI 已在 127.0.0.1:8188 运行
const { chromium } = require('playwright');

const URL = 'http://127.0.0.1:8188/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out/verify_dom_widget_layout.png';

const NODE_CLASS = 'GGWebAIReverseText';

const results = [];
function assert(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
}

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-vdwl-${Date.now()}`, {
    headless: true,
    executablePath: CHROME,
    viewport: { width: 1600, height: 1200 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const pageErrors = [];
  const consoleErrs = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // 环境噪音：外部扩展 gulips.bridge 启动报错、CSP report-only、资源 404
    if (/gulips\.bridge|io is not defined|CSP|report-only/.test(t)) return;
    if (/Failed to load resource/.test(t)) return;
    consoleErrs.push(t);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(4000);

  const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

  // ---- 断言 1/2：定位层语义 ----
  const layer = await page.evaluate(() => {
    const iso = document.querySelector('div[data-testid="dom-widgets"]');
    const items = [...document.querySelectorAll('div.dom-widget')];
    return {
      hasIso: !!iso,
      isoHeight: iso ? iso.offsetHeight : -1,
      isoPE: iso ? getComputedStyle(iso).pointerEvents : null,
      total: items.length,
      notFixed: items.filter((el) => getComputedStyle(el).position !== 'fixed').map((el) => ({
        pos: getComputedStyle(el).position,
        style: (el.getAttribute('style') || '').slice(0, 90),
      })),
      peBad: items.filter((el) => getComputedStyle(el).pointerEvents !== 'auto').length,
      styleTag: !!document.getElementById('gg-dom-widget-layer-fix'),
    };
  });

  assert('定位层存在', layer.hasIso, layer.hasIso ? 'ok' : '未找到 div[data-testid="dom-widgets"]');
  assert('修正在位', layer.styleTag, layer.styleTag ? 'gg-dom-widget-layer-fix 已注入' : '样式未注入');
  assert(
    '所有 DOM widget 为 fixed',
    layer.notFixed.length === 0,
    layer.notFixed.length === 0 ? `${layer.total} 个全部 fixed` : `${layer.notFixed.length}/${layer.total} 仍是 ${JSON.stringify(layer.notFixed.slice(0, 3))}`
  );
  assert('定位层不接事件', layer.isoPE === 'none', `pointer-events=${layer.isoPE}`);
  assert('控件仍可交互', layer.peBad === 0, layer.peBad === 0 ? '全部 auto' : `${layer.peBad} 个非 auto`);
  assert('定位层高度收为 0', layer.isoHeight <= 2, `offsetHeight=${layer.isoHeight}`);

  // ---- 断言 3：多行文本框落位 ----
  const geo = await page.evaluate(async (cls) => {
    const app = window.app;
    app.graph.clear();
    const n = window.LiteGraph.createNode(cls);
    app.graph.add(n);
    n.pos = [120, 60];
    await new Promise((r) => setTimeout(r, 1600));
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    app.canvas.setDirty(true, true);
    app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 900));

    const gcc = document.querySelector('.graph-canvas-container').getBoundingClientRect();
    const ds = app.canvas.ds;
    const box = {
      x: gcc.left + (n.pos[0] + ds.offset[0]) * ds.scale,
      y: gcc.top + (n.pos[1] + ds.offset[1]) * ds.scale,
      w: n.size[0] * ds.scale,
      h: n.size[1] * ds.scale,
    };

    const texts = [...document.querySelectorAll('div.dom-widget')]
      .map((el) => {
        const ta = el.querySelector('textarea');
        if (!ta) return null;
        const r = el.getBoundingClientRect();
        return {
          text: (ta.value || '').replace(/\s+/g, ' ').slice(0, 10),
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
          pos: getComputedStyle(el).position,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.y - b.y);

    return { box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }, texts, nodeH: n.size[1] };
  }, NODE_CLASS);

  assert('多行文本框数量', geo.texts.length >= 3, `${geo.texts.length} 个 textarea`);

  const TOL = 3;
  const inside = geo.texts.filter(
    (t) =>
      t.y >= geo.box.y - TOL &&
      t.y + t.h <= geo.box.y + geo.box.h + TOL &&
      t.x >= geo.box.x - TOL &&
      t.x + t.w <= geo.box.x + geo.box.w + TOL
  );
  assert(
    '文本框全部落在节点内',
    inside.length === geo.texts.length,
    `${inside.length}/${geo.texts.length} 在盒内 box=${JSON.stringify(geo.box)} texts=${JSON.stringify(geo.texts.map((t) => [t.text, t.x, t.y, t.w, t.h]))}`
  );

  const overlaps = [];
  for (let i = 1; i < geo.texts.length; i++) {
    const a = geo.texts[i - 1];
    const b = geo.texts[i];
    if (b.y < a.y + a.h - TOL) overlaps.push(`#${i - 1}"${a.text}"(y${a.y}+${a.h}) 压住 #${i}"${b.text}"(y${b.y})`);
  }
  assert('文本框互不重叠', overlaps.length === 0, overlaps.length ? overlaps.join('; ') : `${geo.texts.length} 个纵向无交叠`);

  await page.screenshot({ path: SHOT, clip: { x: 0, y: 0, width: 1100, height: 1000 } });

  // ---- 脚本异常 ----
  const ourErrs = [...pageErrors, ...consoleErrs].filter((t) => /gg-dom-widget-layer|dom-widget|isolate/i.test(t));
  assert('无相关脚本异常', ourErrs.length === 0, ourErrs.slice(0, 3).join(' | ') || 'clean');

  // ---- 还原 ----
  try {
    await page.evaluate((b) => window.app.loadGraphData(JSON.parse(b)), backup);
  } catch (_) {}

  // ---- 输出 ----
  const pass = results.filter((r) => r.pass).length;
  console.log('');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  console.log(`\n${pass === results.length ? 'PASS' : 'FAIL'}  ${pass}/${results.length}`);
  if (pageErrors.length || consoleErrs.length) {
    console.log(`\n[环境噪音/其它] pageerror=${pageErrors.length} consoleError=${consoleErrs.length}`);
  }
  await ctx.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
