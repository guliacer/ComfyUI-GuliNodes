// 回归：视频类节点的输出端口被老存档破坏后必须能自愈
//   A parked pos（output.pos = [4000,0]）→ 读档后归位
//   B outputs 数组被清空 → 读档后按后端定义重建
//   C 正常节点读档 → outputs 不多不少、pos 正常
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8188/';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(`C:/Users/Admin/AppData/Local/Temp/gg-vrep-${Date.now()}`, {
    headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1400, height: 900 }, args: ['--no-proxy-server'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(4000);
  const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

  const TYPES = ['GGVideoLoad', 'GGVideoLoadByPath', 'GGVideoCompress'];
  const EXPECT = { GGVideoLoad: ['视频', '路径'], GGVideoLoadByPath: ['视频', '路径'], GGVideoCompress: ['视频'] };

  const makeGraph = (mutate) => page.evaluate(({ types, mutate }) => {
    const app = window.app;
    app.graph.clear();
    const nodes = types.map((t, i) => {
      const n = window.LiteGraph.createNode(t);
      app.graph.add(n);
      n.pos = [60 + i * 320, 40];
      if (mutate === 'parked') n.outputs.forEach((o) => { o.pos = [4000, 0]; });
      if (mutate === 'empty') { try { n.outputs.forEach(() => n.removeOutput(0)); } catch (_) { n.outputs = []; } }
      return n;
    });
    return app.graph.serialize();
  }, { types: TYPES, mutate });

  const loadAndProbe = async (label) => {
    const report = await page.evaluate(async (types) => {
      const app = window.app;
      await app.loadGraphData(window.__graph);
      await new Promise((r) => setTimeout(r, 1500));
      app.canvas.setDirty(true, true); app.canvas.draw(true, true);
      await new Promise((r) => setTimeout(r, 600));
      return (app.graph._nodes || []).filter((n) => types.includes(n.comfyClass)).map((n) => ({
        type: n.comfyClass,
        x: Math.round(n.pos[0]),
        y: Math.round(n.pos[1]),
        w: Math.round(n.size[0]),
        h: Math.round(n.size[1]),
        outs: (n.outputs || []).map((o) => ({ name: o.name, pos: o.pos ? [Math.round(o.pos[0]), Math.round(o.pos[1])] : null })),
        // 连接点坐标以引擎最终裁决为准：必须落在节点右缘附近，不能停在远处
        conn: (n.outputs || []).map((_, i) => {
          try {
            const p = n.getConnectionPos(false, i);
            return p ? [Math.round(p[0]), Math.round(p[1])] : null;
          } catch (_) { return null; }
        }),
      }));
    }, TYPES);
    return report;
  };

  // parked 修复的判据：pos 要么被删成 null（引擎首帧重算），要么回到节点右缘。
  // getConnectionPos 返回图坐标，先换算成节点局部再对右缘。
  const connOnEdge = (row, i) => {
    const p = row.conn?.[i];
    if (!p) return false;
    const lx = p[0] - row.x;
    const ly = p[1] - row.y;
    return lx > row.w - 30 && lx < row.w + 30 && ly >= 0 && ly <= row.h + 60;
  };
  const namesOk = (row) => row.outs.length === EXPECT[row.type].length
    && row.outs.every((o, i) => o.name === EXPECT[row.type][i]);

  // ---- A：parked pos ----
  await page.evaluate(async ({ types, mutate }) => {
    const app = window.app;
    window.__graph = null;
    app.graph.clear();
    const nodes = types.map((t, i) => {
      const n = window.LiteGraph.createNode(t);
      app.graph.add(n); n.pos = [60 + i * 320, 40];
      n.outputs.forEach((o) => { o.pos = [4000, 0]; });
      return n;
    });
    window.__graph = app.graph.serialize();
  }, { types: TYPES, mutate: 'parked' });
  const a = await loadAndProbe('parked');
  for (const row of a) {
    const parked = row.outs.some((o) => o.pos && (o.pos[0] > row.w + 200 || o.pos[0] < -50 || o.pos[1] < -50 || o.pos[1] > row.h + 200));
    const connOk = row.outs.every((_, i) => connOnEdge(row, i));
    check(`A ${row.type} parked pos 清除 + 连接点在节点右缘`, namesOk(row) && !parked && connOk,
      `outs=${JSON.stringify(row.outs)} conn=${JSON.stringify(row.conn)} w=${row.w}`);
  }

  // ---- B：outputs 清空 ----
  await page.evaluate(async (types) => {
    const app = window.app;
    app.graph.clear();
    for (let i = 0; i < types.length; i++) {
      const n = window.LiteGraph.createNode(types[i]);
      app.graph.add(n); n.pos = [60 + i * 320, 40];
      try { while (n.outputs.length) n.removeOutput(0); } catch (_) { n.outputs = []; }
    }
    window.__graph = app.graph.serialize();
  }, TYPES);
  const b = await loadAndProbe('empty');
  for (const row of b) {
    const ok = row.outs.length === EXPECT[row.type].length
      && row.outs.every((o, i) => o.name === EXPECT[row.type][i]);
    check(`B ${row.type} 输出重建`, ok, JSON.stringify(row.outs));
  }

  // ---- C：正常读档不破坏 ----
  await page.evaluate(async (types) => {
    const app = window.app;
    app.graph.clear();
    for (let i = 0; i < types.length; i++) {
      const n = window.LiteGraph.createNode(types[i]);
      app.graph.add(n); n.pos = [60 + i * 320, 40];
    }
    window.__graph = app.graph.serialize();
  }, TYPES);
  const c = await loadAndProbe('normal');
  for (const row of c) {
    const ok = row.outs.length === EXPECT[row.type].length
      && row.outs.every((o, i) => o.name === EXPECT[row.type][i]);
    check(`C ${row.type} 正常读档保持`, ok, JSON.stringify(row.outs));
  }

  check('D 无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'none');
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果：${pass}/${results.length} 通过`);
  try { await page.evaluate((s) => window.app.loadGraphData(JSON.parse(s)), backup); } catch (_) {}
  await ctx.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
