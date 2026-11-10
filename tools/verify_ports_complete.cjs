// 全量体检：每个 GG 节点的实际 inputs/outputs 是否与后端 /object_info 定义一致
// 缺失 = 后端有、前端没生成（"输出源漏了"）；多余 = 前端凭空多的槽
// 第二阶段：把全部节点注入 parked pos（output.pos=[4000,0] 老存档病灶）后读档，
// 断言修复模块把它们全部拉回节点边缘 —— 「端口数据在、却停在世界之外」这类
// 问题光比对数组是查不出来的，必须连连接点坐标一起验。
//
// 用法：node tools/verify_ports_complete.cjs
const { chromium } = require('playwright');

const URL = 'http://127.0.0.1:8188/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// 后端 input 规格 -> 前端是否做成 socket（而非画在节点里的 widget）
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
function isSocketSpec(spec, opts = {}) {
  if (!spec) return false;
  const t = Array.isArray(spec) ? spec[0] : spec.type;
  if (Array.isArray(t)) return false; // 下拉列表 -> combo widget
  if (typeof t !== 'string') return false;
  if (WIDGET_TYPES.has(t)) {
    // 有 default 且没强制 forceInput 的标量会被画成 widget
    if (opts.forceInput) return true;
    const hasDefault = Array.isArray(spec) && spec[1] && Object.prototype.hasOwnProperty.call(spec[1], 'default');
    if (t === 'COMBO') return false;
    return !hasDefault;
  }
  return true;
}

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-ports-${Date.now()}`, {
    headless: true,
    executablePath: CHROME,
    viewport: { width: 1400, height: 1000 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.LiteGraph, null, { timeout: 90000 });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(async () => {
    // 新版前端没有 window.api，直接同源取 object_info 更稳
    const defs = await (await fetch('/object_info')).json();
    const L = window.LiteGraph;

    const WIDGET = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
    function socketsOfSingle(arr) {
      if (!Array.isArray(arr)) return true;
      const t = arr[0];
      const opts = arr[1] || {};
      if (Array.isArray(t)) return false;
      if (typeof t === 'string' && WIDGET.has(t)) return opts.forceInput === true;
      return true;
    }
    function socketsOf(def) {
      const out = [];
      for (const bucket of ['required', 'optional']) {
        const spec = def.input?.[bucket] || {};
        for (const [name, arr] of Object.entries(spec)) {
          if (socketsOfSingle(arr)) out.push(name);
        }
      }
      return out;
    }

    const targets = Object.entries(defs)
      .filter(([cls, d]) => {
        const dn = d.display_name || '';
        return cls.startsWith('GG') || dn.startsWith('GG');
      })
      .map(([cls, d]) => ({ cls, d }));

    const report = [];
    for (const { cls, d } of targets) {
      let node = null;
      try {
        node = L.createNode(cls);
        if (!node) {
          report.push({ cls, name: d.display_name, fatal: 'createNode 返回空' });
          continue;
        }
        const gotIn = (node.inputs || []).map((x) => x?.name).filter(Boolean);
        const gotOut = (node.outputs || []).map((x) => x?.name).filter(Boolean);
        const wantIn = socketsOf(d);
        const wantOut = (d.output_name && d.output_name.length ? d.output_name : d.output || []).slice();
        // 输入只报「缺」：widget 型输入也会进 node.inputs，判「多」没有意义
        // AUTOGROW 输入组（COMFY_AUTOGROW_V3）在前端会展开成「图像.0 / 图像.1」，按前缀算命中
        const hasIn = (n) => gotIn.some((g) => g === n || g.startsWith(`${n}.`) || g.startsWith(`${n}[`));
        const missIn = wantIn.filter((n) => !hasIn(n));
        // 参数控件：后端每个 widget 型输入都该有对应 widget
        const gotW = (node.widgets || []).map((w) => w?.name).filter(Boolean);
        const missW = Object.entries({ ...(d.input?.required || {}), ...(d.input?.optional || {}) })
          .filter(([, arr]) => Array.isArray(arr) && !socketsOfSingle(arr))
          .map(([n]) => n)
          .filter((n) => !gotW.includes(n));
        // 输出双向都比：输出源丢失是最要紧的问题
        const missOut = wantOut.filter((n) => !gotOut.includes(n));
        const extraOut = gotOut.filter((n) => !wantOut.includes(n));
        if (missIn.length || missOut.length || extraOut.length || missW.length) {
          report.push({
            cls,
            name: d.display_name,
            gotIn, wantIn, missIn,
            gotOut, wantOut, missOut, extraOut,
            missW,
            outCount: gotOut.length,
            wantOutCount: wantOut.length,
          });
        }
      } catch (e) {
        report.push({ cls, name: d.display_name, fatal: String(e && e.message ? e.message : e) });
      } finally {
        try { node?.onRemoved?.(); } catch (_) {}
      }
    }
    return { total: targets.length, bad: report, classes: targets.map((t) => t.cls) };
  });

  console.log(`\nGG 节点总数: ${result.total}   端口不一致: ${result.bad.length}\n`);
  for (const r of result.bad) {
    if (r.fatal) {
      console.log(`FATAL ${r.cls} (${r.name}): ${r.fatal}`);
      continue;
    }
    console.log(`── ${r.cls}  ${r.name}`);
    if (r.missOut.length) console.log(`   [输出缺失] ${r.missOut.join(', ')}`);
    if (r.extraOut.length) console.log(`   [输出多余] ${r.extraOut.join(', ')}`);
    if (r.missIn.length) console.log(`   [输入缺失] ${r.missIn.join(', ')}`);
    if (r.missW.length) console.log(`   [参数缺失] ${r.missW.join(', ')}`);
    console.log(`   输出 ${r.outCount}/${r.wantOutCount}: got=${JSON.stringify(r.gotOut)}`);
  }

  // ---------- 阶段2：parked pos 注入 → 读档 → 连接点必须回到节点边缘 ----------
  const phase2 = await page.evaluate(async (clsList) => {
    const app = window.app;
    app.graph.clear();
    const made = [];
    let col = 0;
    for (const cls of clsList) {
      let n = null;
      try { n = window.LiteGraph.createNode(cls); } catch (_) { n = null; }
      if (!n) continue;
      app.graph.add(n);
      n.pos = [40 + (col % 8) * 300, 40 + Math.floor(col / 8) * 460];
      col += 1;
      made.push(n);
    }
    // 注入老存档病灶
    for (const n of made) {
      for (const o of n.outputs || []) o.pos = [4000, 0];
      for (const i of n.inputs || []) i.pos = [-4000, 0];
    }
    window.__ggPhase2 = app.graph.serialize();
    await app.loadGraphData(JSON.parse(JSON.stringify(window.__ggPhase2)));
    await new Promise((r) => setTimeout(r, 2500));
    // 逐个节点滚进视口触发绘制：onDrawBackground 只对可见节点跑，
    // 不滚动的话排在视口外的节点测不到绘制期清扫。
    app.canvas.ds.scale = 1;
    for (const n of app.graph._nodes || []) {
      if (!clsList.includes(n.comfyClass)) continue;
      app.canvas.ds.offset = [-n.pos[0] + 120, -n.pos[1] + 120];
      app.canvas.setDirty(true, true);
      app.canvas.draw(true, true);
      await new Promise((r) => setTimeout(r, 40));
    }
    app.canvas.ds.offset = [0, 0];
    app.canvas.setDirty(true, true); app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 800));

    const bad = [];
    // parked 的判定用绝对坐标（病灶注入值是 ±4000 量级）：不能用「y > 当前高度」
    // 判 —— AUTOGROW 节点在读档后收高前采样，y 会暂时大于 h，属于暂态。
    const isParked = (p) => !!p && (p[0] <= -200 || p[0] >= 2000 || p[1] <= -200 || p[1] >= 5000);
    for (const n of app.graph._nodes || []) {
      if (!clsList.includes(n.comfyClass)) continue;
      const w = Number(n.size?.[0]) || 0;
      const h = Number(n.size?.[1]) || 0;
      const parkedOut = (n.outputs || []).filter((o) => isParked(o.pos));
      const parkedIn = (n.inputs || []).filter((i) => isParked(i.pos));
      // 连接点坐标（图坐标）换算到节点局部后检查：
      //   输出 → 必须贴右缘 ±40；
      //   输入 → 落在节点盒内即可（widget 型输入投影在控件行上，x=10；
      //          自绘标题栏节点如 GGGroupControllerM 的输入嵌在标题条里）；
      //   AUTOGROW 动态槽（文本N / 表达式_N / 标签_X 等）引擎折叠排布，
      //   多个槽共用同一连接点，按「与前一槽 y 完全相同 → 引擎折叠」跳过。
      const inConn = (n.inputs || []).map((_, i) => {
        try { return n.getConnectionPos(true, i); } catch (_) { return null; }
      });
      const offEdge = [];
      (n.outputs || []).forEach((_, i) => {
        try {
          const p = n.getConnectionPos(false, i);
          const lx = p[0] - n.pos[0], ly = p[1] - n.pos[1];
          if (lx < w - 40 || lx > w + 40 || ly < -60 || ly > h + 80) offEdge.push(`out#${i}@${Math.round(lx)},${Math.round(ly)}`);
        } catch (_) { offEdge.push(`out#${i}@err`); }
      });
      let prevY = NaN;
      (n.inputs || []).forEach((slot, i) => {
        const p = inConn[i];
        if (!p) { offEdge.push(`in#${i}@err`); return; }
        const lx = p[0] - n.pos[0], ly = p[1] - n.pos[1];
        if (Number.isFinite(ly) && Math.abs(ly - prevY) < 0.5) { prevY = ly; return; } // 折叠布局
        prevY = ly;
        // 未连接的 AUTOGROW 槽位被引擎折叠、不画连接点，其坐标按序号外推，
        // 落在节点外是预期行为 —— 只有真正连了线的槽必须可见可点。
        if (slot?.link == null && (ly > h + 80 || ly < -60)) return;
        if (lx < -40 || lx > w || ly < -60 || ly > h + 80) offEdge.push(`in#${i}@${Math.round(lx)},${Math.round(ly)}`);
      });
      if (parkedOut.length || parkedIn.length || offEdge.length) {
        bad.push({
          cls: n.comfyClass,
          parkedOut: parkedOut.map((o) => o.name),
          parkedIn: parkedIn.map((i) => i.name),
          offEdge: offEdge.slice(0, 6),
        });
      }
    }
    return { checked: made.length, bad };
  }, result.classes || []);

  console.log(`\nParked 自愈体检: ${phase2.checked} 节点   异常: ${phase2.bad.length}`);
  for (const r of phase2.bad) {
    console.log(`── ${r.cls}`);
    if (r.parkedOut.length) console.log(`   [输出仍停在世界外] ${r.parkedOut.join(', ')}`);
    if (r.parkedIn.length) console.log(`   [输入仍停在世界外] ${r.parkedIn.join(', ')}`);
    if (r.offEdge.length) console.log(`   [连接点偏离边缘] ${r.offEdge.join(', ')}`);
  }

  if (errs.length) console.log('\nPAGEERROR:\n' + errs.slice(0, 5).join('\n'));
  const phase1Bad = result.bad.length;
  const phase2Bad = phase2.bad.length;
  console.log(`\n总结: 阶段1 端口定义 ${phase1Bad} 异常 / 阶段2 parked+连接点 ${phase2Bad} 异常`);
  await ctx.close();
  process.exit(phase1Bad === 0 && phase2Bad === 0 && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
