// 回归：节点级「一次性按钮」不能因一次失败就永久消失
//
// 背景：GGImageLoad 的快捷按钮丢失，根因之一是「先把 _xxxInstalled 置为 true，
// 再执行可能抛错的创建」。同样的写法在另外两个节点上也存在，一并改成
// 「先创建成功，再置位；判据看控件是否真的在」。本脚本钉住这两处。
//
// 断言：
//   A GGTextFileLoad 的「选择文件上传」按钮存在，且读档后不重复堆叠
//   B GGVideoLoadByPath 的「选择视频文件」按钮存在，且读档后不重复堆叠
//   C addWidget 抛错时不留下「已装」标记，恢复后同一节点能装成功
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8188/';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
}

const TXT_BUTTON = '选择文件上传';
const VIDEO_BUTTON = '选择视频文件';

(async () => {
  const ctx = await chromium.launchPersistentContext(
    `C:/Users/Admin/AppData/Local/Temp/gg-dynmount-${Date.now()}`,
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
    if (/gulips\.bridge|io is not defined|report-only|Content Security Policy/i.test(t)) return;
    if (/模拟 addWidget 不可用/.test(t)) return;
    consoleErrors.push(t);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3500);

  const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

  // ---------- A / B：创建 + 读档幂等 ----------
  const ab = await page.evaluate(async (names) => {
    const app = window.app;
    app.graph.clear();
    const made = {};
    for (const [key, type] of Object.entries(names)) {
      const n = window.LiteGraph.createNode(type);
      if (!n) { made[key] = { missing: true }; continue; }
      app.graph.add(n);
      n.pos = [60 + 320 * Object.keys(made).length, 40];
      made[key] = n;
    }
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    app.canvas.setDirty(true, true);
    app.canvas.draw(true, true);
    await new Promise((r) => setTimeout(r, 1800));

    const count = (node, name) => (node?.widgets || []).filter((w) => w.name === name).length;
    const before = {
      txt: count(made.txt, '选择文件上传'),
      video: count(made.video, '选择视频文件'),
      txtMissing: !!made.txt?.missing,
      videoMissing: !!made.video?.missing,
    };

    // 读档一次，loadedGraphNode 会再驱动一遍 setup
    const snapshot = app.graph.serialize();
    await app.loadGraphData(snapshot);
    await new Promise((r) => setTimeout(r, 1800));

    const nodes = app.graph._nodes || [];
    const txtNode = nodes.find((n) => (n.comfyClass || n.type) === 'GGTextFileLoad');
    const videoNode = nodes.find((n) => (n.comfyClass || n.type) === 'GGVideoLoadByPath');
    return {
      before,
      after: {
        txt: count(txtNode, '选择文件上传'),
        video: count(videoNode, '选择视频文件'),
      },
    };
  }, { txt: 'GGTextFileLoad', video: 'GGVideoLoadByPath' });

  check('A1 GGTextFileLoad 存在「选择文件上传」按钮',
    ab.before.txt === 1, `count=${ab.before.txt}${ab.before.txtMissing ? ' (节点类型不存在)' : ''}`);
  check('A2 读档后按钮不重复堆叠', ab.after.txt === 1, `count=${ab.after.txt}`);
  check('B1 GGVideoLoadByPath 存在「选择视频文件」按钮',
    ab.before.video === 1, `count=${ab.before.video}${ab.before.videoMissing ? ' (节点类型不存在)' : ''}`);
  check('B2 读档后按钮不重复堆叠', ab.after.video === 1, `count=${ab.after.video}`);

  // ---------- C：创建期抛错不许留标记 ----------
  const c = await page.evaluate(async () => {
    const app = window.app;
    app.graph.clear();
    const n = window.LiteGraph.createNode('GGVideoLoadByPath');
    app.graph.add(n);
    n.pos = [60, 40];
    // 清掉 nodeCreated 可能已经加上的按钮，回到「什么都没装」的状态
    n.widgets = n.widgets.filter((w) => w.name !== '选择视频文件');
    n.ggVideoPathPickerInstalled = false;

    const proto = Object.getPrototypeOf(n);
    const original = proto.addWidget;
    proto.addWidget = function () { throw new Error('模拟 addWidget 不可用'); };

    // 用读档链路触发 setupNode（真实入口，不依赖内部函数名）
    await app.loadGraphData({ nodes: [{ id: 99, type: 'GGVideoLoadByPath', pos: [60, 40], size: [320, 200], flags: {}, order: 0, mode: 0, inputs: [], outputs: [], properties: {}, widgets_values: [] }], links: [], groups: [], config: {}, extra: {}, version: 0.4 });
    await new Promise((r) => setTimeout(r, 1200));

    const failed = (app.graph._nodes || []).find((x) => (x.comfyClass || x.type) === 'GGVideoLoadByPath');
    const failedState = {
      installed: !!failed?.ggVideoPathPickerInstalled,
      hasButton: (failed?.widgets || []).some((w) => w.name === '选择视频文件'),
    };

    proto.addWidget = original;
    await app.loadGraphData({ nodes: [{ id: 100, type: 'GGVideoLoadByPath', pos: [60, 40], size: [320, 200], flags: {}, order: 0, mode: 0, inputs: [], outputs: [], properties: {}, widgets_values: [] }], links: [], groups: [], config: {}, extra: {}, version: 0.4 });
    await new Promise((r) => setTimeout(r, 1200));
    const okNode = (app.graph._nodes || []).find((x) => (x.comfyClass || x.type) === 'GGVideoLoadByPath');
    return {
      failedState,
      retryState: {
        installed: !!okNode?.ggVideoPathPickerInstalled,
        count: (okNode?.widgets || []).filter((w) => w.name === '选择视频文件').length,
      },
    };
  });

  check('C1 addWidget 抛错后不留「已装」标记', c.failedState.installed === false && c.failedState.hasButton === false,
    `installed=${c.failedState.installed} button=${c.failedState.hasButton}`);
  check('C2 下一次读档能把按钮装回来', c.retryState.count === 1, `count=${c.retryState.count}`);

  // ---------- D：异常 ----------
  const ownErrors = consoleErrors.filter((t) => /GGTxtLoad|GGVideoLoadByPath|gg-txt-load|gg-video-save-preview/i.test(t));
  check('D1 无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'none');
  check('D2 无相关 console error', ownErrors.length === 0, ownErrors.slice(0, 3).join(' | ') || 'none');

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果：${pass}/${results.length} 通过`);

  try { await page.evaluate((s) => window.app.loadGraphData(JSON.parse(s)), backup); } catch (_) {}
  await ctx.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
