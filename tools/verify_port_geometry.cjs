// 回归：端口几何修复（gg-port-geometry-repair.js）
//   A. 输出被停在节点外（output.pos = [4000, 0]）→ 必须归位
//   B. 输出槽被清空（outputs = []）→ 必须按后端定义重建
//   C. 正常节点不得被误改
//
// 用法：node tools/verify_port_geometry.cjs
const { chromium } = require('playwright');

const URL = 'http://127.0.0.1:8188/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const results = [];
const assert = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-pg-${Date.now()}`, {
    headless: true,
    executablePath: CHROME,
    viewport: { width: 1400, height: 1000 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3500);

  const hasApi = await page.evaluate(() => typeof window.app.ggRepairPortGeometry === 'function');
  assert('修复入口已注册', hasApi, hasApi ? 'app.ggRepairPortGeometry 可用' : '未挂载，模块可能没加载');

  const out = await page.evaluate(async () => {
    const app = window.app;
    const repair = app.ggRepairPortGeometry;
    app.graph.clear();

    const mk = (cls) => {
      const n = window.LiteGraph.createNode(cls);
      app.graph.add(n);
      return n;
    };
    const settle = async (ms = 1200) => {
      app.canvas.setDirty(true, true);
      app.canvas.draw(true, true);
      await new Promise((r) => setTimeout(r, ms));
    };

    const node = mk('GGInpaintCrop');
    node.pos = [80, 80];
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    await settle(1800);

    const snapshot = (n) => ({
      size: [Math.round(n.size[0]), Math.round(n.size[1])],
      inputs: (n.inputs || []).map((o) => ({
        name: o.name,
        pos: Array.isArray(o.pos) ? [Math.round(o.pos[0]), Math.round(o.pos[1])] : null,
      })),
      outputs: (n.outputs || []).map((o) => ({
        name: o.name,
        type: o.type,
        pos: Array.isArray(o.pos) ? [Math.round(o.pos[0]), Math.round(o.pos[1])] : null,
      })),
    });

    const res = { initial: snapshot(node), steps: [] };

    // ---- A. 输出被停在节点外（输入同样停到负坐标）----
    for (const o of node.outputs) o.pos = [4000, 0];
    for (const i of node.inputs) i.pos = [-4000, 0];
    const injected = snapshot(node); // 同步快照：绘制发生在 rAF，此刻坏状态还在
    res.injected = injected;
    app.canvas.setDirty(true, true);
    await settle(400);
    res.steps.push({ name: 'A-before', state: snapshot(node) });
    const repairedA = repair(node);
    await settle(800);
    res.steps.push({ name: 'A-after', repaired: repairedA, state: snapshot(node) });

    // ---- B. 输出被清空 ----
    const keepNames = node.outputs.map((o) => o.name);
    node.outputs = [];
    app.canvas.setDirty(true, true);
    await settle(300);
    res.steps.push({ name: 'B-before', count: node.outputs.length });
    const repairedB = repair(node);
    await settle(1200);
    res.steps.push({
      name: 'B-after',
      repaired: repairedB,
      count: node.outputs.length,
      names: node.outputs.map((o) => o.name),
      keepNames,
      state: snapshot(node),
    });

    // ---- C. 正常节点不受影响 ----
    const ref = mk('GG图像缩放');
    ref.pos = [520, 80];
    await settle(1600);
    const refBefore = snapshot(ref);
    const repairedC = repair(ref);
    await settle(600);
    const refAfter = snapshot(ref);
    res.steps.push({ name: 'C', repaired: repairedC, before: refBefore, after: refAfter });

    return res;
  });

  // ---- 断言 ----
  assert('初始输出 3 个', out.initial.outputs.length === 3,
    `${out.initial.outputs.map((o) => o.name).join('/')}`);

  const aBefore = out.steps.find((s) => s.name === 'A-before');
  const aAfter = out.steps.find((s) => s.name === 'A-after');
  const injectedAll = out.injected.outputs.every((o) => o.pos && o.pos[0] > 3000);
  assert('坏状态构造成功（输出全停在 x=4000）', injectedAll,
    JSON.stringify(out.injected.outputs.map((o) => o.pos)));
  // 绘制期清扫在 settle(400) 里就该把 parked pos 清成 null（引擎待重算），
  // 也可能直接重算回右缘 —— 两种形态都算自动修复。
  const initialW = out.initial.size[0];
  const autoFixed = aBefore.state.outputs.every((o) => !o.pos || (o.pos[0] <= initialW + 2 && o.pos[1] >= -2));
  assert('A · 绘制期清扫自动把输出拉回节点', autoFixed,
    `w=${initialW} pos=${JSON.stringify(aBefore.state.outputs.map((o) => o.pos))}`);
  const w = aAfter.state.size[0];
  const backIn = aAfter.state.outputs.every((o) => !o.pos || (o.pos[0] <= w + 2 && o.pos[1] >= -2));
  assert('A · 修复后输出停在节点右缘', backIn,
    `size=${w} pos=${JSON.stringify(aAfter.state.outputs.map((o) => o.pos))}`);
  const inBack = aAfter.state.inputs.every((i) => !i.pos || (i.pos[0] >= -2 && i.pos[1] >= -2));
  assert('A · 停在负坐标的输入已归位', inBack,
    JSON.stringify(aAfter.state.inputs.filter((i) => i.pos).map((i) => [i.name, i.pos])));

  const bAfter = out.steps.find((s) => s.name === 'B-after');
  assert('B · 输出被清空后按后端定义重建', bAfter.count === 3 && bAfter.names.join('/') === bAfter.keepNames.join('/'),
    `${bAfter.count} 个: ${bAfter.names.join('/')}（期望 ${bAfter.keepNames.join('/')}）`);

  const c = out.steps.find((s) => s.name === 'C');
  const cSame = JSON.stringify(c.before) === JSON.stringify(c.after);
  assert('C · 正常节点不被误改', c.repaired === false && cSame,
    `repaired=${c.repaired} before=${JSON.stringify(c.before.outputs)} after=${JSON.stringify(c.after.outputs)}`);

  const ourErrs = errs.filter((t) => /port-geometry|ggRepair|repair/i.test(t));
  assert('无相关脚本异常', ourErrs.length === 0, ourErrs.slice(0, 2).join(' | ') || 'clean');

  const pass = results.filter((r) => r.pass).length;
  console.log('');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  console.log(`\n${pass === results.length ? 'PASS' : 'FAIL'}  ${pass}/${results.length}`);

  await ctx.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
