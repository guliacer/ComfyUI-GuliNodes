// GG LoRA组加载 实机回归。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_lora_group_loader.cjs
//
// 覆盖：节点结构 / 新增组 / 组数据隔离 / 悬浮删除按钮 / 删除组 / 左右滑动 /
//       新增 LoRA / 上下拖拽重排 / 强度 ±step / serialize→loadGraphData 读档 /
//       节点高度锁死贴合内容（不残留空白、拖高不持久化）/ 节点尺寸 / 无脚本异常。
//       坐标一律读 node._ggGroupGeometry 与 widget._ggCol，
//       与前端绘制、命中检测共用同一份几何，不另写一套公式。
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NODE_CLASS = 'GGLoRAGroupLoader';

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 造景中途抛错也要把已跑过的断言打出来，别只剩一句 TypeError。
function dumpAndExit(error) {
  console.error('SCRIPT ERROR', error);
  checks.forEach((c) => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`));
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} passed (中断)`);
  process.exit(1);
}
process.on('uncaughtException', dumpAndExit);
process.on('unhandledRejection', dumpAndExit);

// 外部扩展 gulips.bridge 启动会 console.error `io is not defined`，内嵌网页还会刷
// CSP report-only 报告；只放行与本模块无关的，并反向验证过滤器没写宽（防假 PASS）。
const OWN_MODULE = /gg-lora-group-loader|gg-lora-group|gg-widget-rows|lora_tools|GGLoRAGroupLoader/i;
const isOwnModuleError = (text) => OWN_MODULE.test(String(text));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const missing = [];
  const externalNoise = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });
  page.on('console', (m) => {
    if (m.type() !== 'error' || /Failed to load resource/.test(m.text())) return;
    const text = m.text();
    if (!isOwnModuleError(text)) { externalNoise.push('console: ' + text); return; }
    errors.push('console: ' + text);
  });

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1500);

  await page.evaluate(async (NODE_CLASS) => {
    const app = window.app;
    window.__ggSavedGraph = app.graph.serialize();
    app.graph.clear();
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    const node = window.LiteGraph.createNode(NODE_CLASS);
    app.graph.add(node);
    node.pos = [60, 60];
    await new Promise((r) => setTimeout(r, 1200));
    app.canvas.draw(true, true);
  }, NODE_CLASS);

  const readState = () => page.evaluate((NODE_CLASS) => {
    const app = window.app;
    const node = (app.graph._nodes ?? []).find((n) => n?.comfyClass === NODE_CLASS);
    window.__ggNode = node;
    if (!node) return null;
    app.canvas.draw(true, true);
    const widget = (name) => node.widgets?.find((w) => w?.name === name) ?? null;
    const groups = (() => {
      try { return JSON.parse(node.properties?.ggLoraGroups ?? '[]'); }
      catch { return []; }
    })();
    const rows = (node._ggRowLayout?.rows ?? []).map((row) => row.map((w) => ({
      name: w.name,
      y: w.y ?? null,
      col: w._ggCol ? [w._ggCol.x, w._ggCol.w] : null,
      value: typeof w.value === 'object' ? null : w.value,
    })));
    const geometry = node._ggGroupGeometry;
    const loraValues = [];
    for (let i = 1; i <= 3; i += 1) {
      loraValues.push({
        enable: widget(`LoRA${i}启用`)?.value,
        name: widget(`LoRA${i}名称`)?.value,
        strength: widget(`LoRA${i}强度`)?.value,
      });
    }
    const enableGeometries = {};
    for (const w of node.widgets ?? []) {
      if (w?._ggEnableGeometry) enableGeometries[w.name] = {
        shape: w._ggEnableGeometry.shape,
        handle: w._ggEnableGeometry.handle,
        toggle: w._ggEnableGeometry.toggle,
        gap: w._ggEnableGeometry.gap,
      };
    }
    return {
      size: [...node.size],
      index: Number(node.properties?.ggLoraGroupIndex),
      currentGroupWidget: widget('当前组')?.value,
      visibleCount: widget('LoRA数量')?.value,
      groupCount: groups.length,
      groupNames: groups.map((g) => g.name),
      groupLoraCounts: groups.map((g) => (g.loras ?? []).length),
      groups,
      rows,
      loraValues,
      hint: !!widget('gg_lora_group_hint') && !widget('gg_lora_group_hint').hidden,
      tabs: !!widget('gg_lora_group_tabs') && !widget('gg_lora_group_tabs').hidden,
      addLora: !!widget('新增LoRA'),
      enableGeometries,
      nameScroll: Number(widget('LoRA1名称')?._ggNameScroll) || 0,
      manualHeightFlag: node._ggRowLayoutManualHeight ?? null,
      flexHeight: node._ggRowLayout?.flexible ?? null,
      lockHeight: node._ggRowLayout?.config?.lockHeightToContent === true,
      userSize: Array.isArray(node.properties?._ggRowUserSize)
        ? [...node.properties._ggRowUserSize] : null,
      geometry: geometry ? {
        top: geometry.top, height: geometry.height,
        left: geometry.left, right: geometry.right,
        bar: geometry.bar,
        addVisible: geometry.addVisible, addGlyph: geometry.addGlyph,
        viewportL: geometry.viewportL, viewportR: geometry.viewportR,
        maxScroll: geometry.maxScroll, scroll: geometry.scroll,
        arrowL: geometry.arrowL, arrowR: geometry.arrowR, addGroup: geometry.addGroup,
        tabs: geometry.tabs.map((t) => ({
          index: t.index, x: t.x, y: t.y, w: t.w, h: t.h, deleteRect: t.deleteRect,
        })),
      } : null,
    };
  }, NODE_CLASS);

  const toScreen = (local) => page.evaluate(([lx, ly]) => {
    const app = window.app;
    const node = window.__ggNode;
    const rect = app.canvas.canvas.getBoundingClientRect();
    return [
      rect.left + (node.pos[0] + lx) * app.canvas.ds.scale + app.canvas.ds.offset[0],
      rect.top + (node.pos[1] + ly) * app.canvas.ds.scale + app.canvas.ds.offset[1],
    ];
  }, local);

  async function clickLocal(lx, ly) {
    const [x, y] = await toScreen([lx, ly]);
    await page.mouse.click(x, y);
    await sleep(220);
  }

  async function hoverLocal(lx, ly) {
    const [x, y] = await toScreen([lx, ly]);
    await page.mouse.move(x, y);
    await sleep(160);
  }

  async function wheelLocal(lx, ly, dx, dy) {
    const [x, y] = await toScreen([lx, ly]);
    await page.mouse.move(x, y);
    await page.mouse.wheel(dx, dy);
    await sleep(220);
  }

  async function dragLocal(from, to) {
    const [x1, y1] = await toScreen(from);
    const [x2, y2] = await toScreen(to);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 12 });
    await page.mouse.up();
    await sleep(260);
  }

  const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];

  // 造景：properties 与 widgets_values 必须**一起**改。前端 setup 会以
  // widgets_values（用户实际看到的控件值）为准回写当前组，只改 properties
  // 会被当成「用户没切组就保存」而覆盖掉造的数据。
  async function seedGroups(groups) {
    await page.evaluate(async (groups) => {
      const app = window.app;
      const node = window.__ggNode;
      node.properties.ggLoraGroups = JSON.stringify(groups);
      node.properties.ggLoraGroupIndex = 0;
      const set = (name, value) => {
        const widget = node.widgets.find((w) => w.name === name);
        if (widget) widget.value = value;
      };
      const loras = groups[0]?.loras ?? [];
      set('LoRA数量', loras.length);
      set('当前组', 1);
      for (let i = 1; i <= 20; i += 1) {
        const slot = loras[i - 1];
        set(`LoRA${i}名称`, slot?.name ?? 'None');
        set(`LoRA${i}强度`, slot ? slot.strength : 1);
        set(`LoRA${i}启用`, slot ? slot.enable : true);
      }
      await app.loadGraphData(app.graph.serialize());
      await new Promise((r) => setTimeout(r, 800));
      app.canvas.ds.scale = 1;
      app.canvas.ds.offset = [0, 0];
      app.canvas.draw(true, true);
    }, groups);
    await sleep(400);
  }

  // ---------------------------------------------------------------- A 初始结构
  const initial = await readState();
  check('新节点已创建且行布局生效', !!initial && !!initial.geometry
    && initial.rows.length === 3, initial && { rows: initial.rows.length, size: initial.size });
  check('默认 1 个组、当前组索引 0、1 行 LoRA',
    initial.groupCount === 1 && initial.index === 0 && Number(initial.visibleCount) === 1,
    { groupCount: initial.groupCount, index: initial.index, visibleCount: initial.visibleCount });
  check('「当前生效」提示条已删掉，组标签条与新增LoRA 按钮仍在',
    !initial.hint && initial.tabs && initial.addLora,
    { hint: initial.hint, tabs: initial.tabs, addLora: initial.addLora });
  check('行顺序为 标签条 / 三列LoRA / 居中新增按钮',
    initial.rows[0][0].name === 'gg_lora_group_tabs'
      && initial.rows[1].length === 3
      && initial.rows[1].map((w) => w.name).join(',') === 'LoRA1启用,LoRA1名称,LoRA1强度'
      && initial.rows[2][0].name === '新增LoRA',
    initial.rows.map((r) => r.map((w) => w.name)));
  const addRow = initial.rows[2][0];
  check('「新增LoRA」按钮水平居中',
    Math.abs((addRow.col[0] + addRow.col[1] / 2) - initial.size[0] / 2) <= 2,
    { col: addRow.col, nodeWidth: initial.size[0] });
  check('默认节点宽度 460、高度贴合 3 行内容',
    initial.size[0] === 460 && initial.size[1] > 100 && initial.size[1] < 200,
    initial.size);
  check('properties 里已经写入组配置 JSON',
    initial.groupNames[0] === 'LoRA组1' && initial.groupLoraCounts[0] === 1,
    { names: initial.groupNames, counts: initial.groupLoraCounts });

  // 默认宽度下：拖拽手柄 / 启用勾选 / 强度三处必须完整显示，名称才允许省略。
  const eg = initial.enableGeometries['LoRA1启用'];
  const initialStrengthShape = {
    x: initial.rows[1][2].col[0] + 15,
    w: initial.rows[1][2].col[1] - 30,
  };
  const initialNameShape = {
    x: initial.rows[1][1].col[0] + 15,
    w: initial.rows[1][1].col[1] - 30,
  };
  check('默认宽度下手柄胶囊 / 空白 / 勾选胶囊是三段独立几何',
    !!eg && eg.handle.w >= 18 && eg.toggle.w >= 22 && eg.gap >= 5
      && Math.abs(eg.handle.x + eg.handle.w + eg.gap - eg.toggle.x) <= 1
      && eg.toggle.x + eg.toggle.w <= eg.shape.x + eg.shape.w + 1,
    eg);
  check('默认宽度下强度格与名称格都不被挤没（强度≥30px、名称最宽）',
    initialStrengthShape.w >= 30 && initialNameShape.w > initialStrengthShape.w * 3,
    { strengthShape: initialStrengthShape, nameShape: initialNameShape });
  check('「新增组」已改成 ➕ 且默认不常驻',
    initial.geometry.addGlyph === '➕' && initial.geometry.addVisible === false
      && initial.geometry.addGroup.w <= 30,
    { glyph: initial.geometry.addGlyph, addVisible: initial.geometry.addVisible,
      addGroup: initial.geometry.addGroup });

  // ---------------------------------------------------------------- B 新增组
  await hoverLocal(...center(initial.geometry.bar));
  const hoverBar = await readState();
  check('悬浮组标签条时 ➕ 才出现（不悬浮时 addVisible=false）',
    initial.geometry.addVisible === false && hoverBar.geometry.addVisible === true,
    { before: initial.geometry.addVisible, after: hoverBar.geometry.addVisible });
  await clickLocal(...center(initial.geometry.addGroup));
  const added = await readState();
  check('点「➕」后变成 2 组并自动切到新组',
    added.groupCount === 2 && added.index === 1 && Number(added.visibleCount) === 1,
    { groupCount: added.groupCount, index: added.index, visibleCount: added.visibleCount });
  check('新组名不重复，「当前组」控件值同步为 2',
    added.groupNames.join(',') === 'LoRA组1,LoRA组2'
      && Number(added.currentGroupWidget) === 2,
    { names: added.groupNames, widget: added.currentGroupWidget });

  // ---------------------------------------------------------------- C 组数据隔离
  // 在当前组（组2）造 2 行 LoRA：真实点新增按钮 + 直接写控件值（等价于用户选完）。
  let state = await readState();
  await clickLocal(...center(state.rows[2][0].col ? {
    x: state.rows[2][0].col[0], y: state.rows[2][0].y,
    w: state.rows[2][0].col[1], h: 24,
  } : { x: 200, y: 120, w: 100, h: 24 }));
  await page.evaluate(() => {
    const n = window.__ggNode;
    const set = (name, value) => {
      const w = n.widgets.find((x) => x.name === name);
      if (w) w.value = value;
    };
    set('LoRA1名称', 'GROUP2_A.safetensors');
    set('LoRA1强度', 0.42);
    set('LoRA1启用', false);
    set('LoRA2名称', 'GROUP2_B.safetensors');
    set('LoRA2强度', 1.35);
  });
  await sleep(200);
  const group2Filled = await readState();
  check('组2 里新增 LoRA 后可见行数变 2',
    Number(group2Filled.visibleCount) === 2
      && group2Filled.rows.filter((r) => r.length === 3).length === 2,
    { count: group2Filled.visibleCount, rows: group2Filled.rows.length });

  // 点组1 标签 → 组1 应该还是默认值，组2 的内容不串过来
  state = await readState();
  const tab1 = state.geometry.tabs.find((t) => t.index === 0);
  await clickLocal(tab1.x + tab1.w / 2, tab1.y + tab1.h / 2);
  const backTo1 = await readState();
  check('切回组1 后当前组索引/控件值正确',
    backTo1.index === 0 && Number(backTo1.currentGroupWidget) === 1,
    { index: backTo1.index, widget: backTo1.currentGroupWidget });
  check('切回组1 后是组1 自己的 1 行默认值，没有串到组2',
    Number(backTo1.visibleCount) === 1
      && backTo1.loraValues[0].name === 'None'
      && Number(backTo1.loraValues[0].strength) === 1
      && backTo1.loraValues[0].enable === true,
    backTo1.loraValues);
  check('组2 的 2 行数据仍保存在配置里',
    backTo1.groupLoraCounts[1] === 2
      && backTo1.groups[1].loras[0].name === 'GROUP2_A.safetensors'
      && Number(backTo1.groups[1].loras[0].strength) === 0.42,
    { counts: backTo1.groupLoraCounts, g2: backTo1.groups[1]?.loras });

  // 再切回组2，值必须原样回来
  state = await readState();
  const tab2 = state.geometry.tabs.find((t) => t.index === 1);
  await clickLocal(tab2.x + tab2.w / 2, tab2.y + tab2.h / 2);
  const backTo2 = await readState();
  check('再切回组2 时 2 行 LoRA 的 启用/名称/强度 全部还原',
    Number(backTo2.visibleCount) === 2
      && backTo2.loraValues[0].name === 'GROUP2_A.safetensors'
      && backTo2.loraValues[0].enable === false
      && Number(backTo2.loraValues[0].strength) === 0.42
      && backTo2.loraValues[1].name === 'GROUP2_B.safetensors'
      && Number(backTo2.loraValues[1].strength) === 1.35,
    backTo2.loraValues);

  // ---------------------------------------------------------------- D 悬浮删除按钮
  await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype;
    if (!proto.__ggArcHooked) {
      const original = proto.arc;
      proto.arc = function (...args) {
        if (args[2] >= 6) window.__ggBigArcs = (window.__ggBigArcs ?? 0) + 1;
        return original.apply(this, args);
      };
      proto.__ggArcHooked = true;
    }
    window.__ggBigArcs = 0;
  });
  // 先移到画布空白处清掉 hover
  await hoverLocal(700, 700);
  await page.evaluate(() => {
    window.__ggBigArcs = 0;
    window.app.canvas.draw(true, true);
  });
  const arcsNoHover = await page.evaluate(() => window.__ggBigArcs);
  state = await readState();
  const hoverTab = state.geometry.tabs.find((t) => t.index === 1);
  await hoverLocal(hoverTab.x + hoverTab.w / 2, hoverTab.y + hoverTab.h / 2);
  await page.evaluate(() => {
    window.__ggBigArcs = 0;
    window.app.canvas.draw(true, true);
  });
  const arcsHover = await page.evaluate(() => window.__ggBigArcs);
  check('悬浮在组按钮上时，组后面出现圆形删除按钮（无悬浮时不出现）',
    arcsNoHover === 0 && arcsHover >= 1,
    { arcsNoHover, arcsHover, hover: 1 });

  // ---------------------------------------------------------------- E 删除组
  state = await readState();
  const del = state.geometry.tabs.find((t) => t.index === 1)?.deleteRect;
  await clickLocal(del.x + del.w / 2, del.y + del.h / 2);
  const deleted = await readState();
  check('点删除按钮后该组被删掉，只剩组1 且切到组1',
    deleted.groupCount === 1 && deleted.index === 0
      && deleted.groupNames[0] === 'LoRA组1',
    { groupCount: deleted.groupCount, index: deleted.index, names: deleted.groupNames });
  check('被删组的内容不再生效（当前组回到 1 行默认 LoRA）',
    Number(deleted.visibleCount) === 1 && deleted.loraValues[0].name === 'None',
    { count: deleted.visibleCount, first: deleted.loraValues[0] });

  // ---------------------------------------------------------------- F 左右滑动
  // 造 12 组走一次真实读档路径（顺带验证 properties 随工作流序列化）。
  const manyGroups = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    name: `LoRA组${i + 1}`,
    loras: [{ enable: true, name: 'None', strength: 1 }],
  }));
  await seedGroups(manyGroups);
  const many = await readState();
  check('读档后 12 个组全部恢复（组配置随工作流 properties 保存）',
    many.groupCount === 12 && many.groupNames.length === 12
      && many.groupNames[11] === 'LoRA组12',
    { groupCount: many.groupCount, last: many.groupNames.at(-1) });
  check('组多到溢出时标签条出现可滚动区间',
    many.geometry.maxScroll > 0 && many.geometry.tabs.length < 12,
    { maxScroll: many.geometry.maxScroll, visibleTabs: many.geometry.tabs.length });

  const wheelTarget = [many.geometry.viewportL + 40,
    many.geometry.top + many.geometry.height / 2];
  await wheelLocal(...wheelTarget, 0, 240);
  const afterWheel = await readState();
  check('标签条上滚轮可以向右滑动查看后面的组',
    afterWheel.geometry.scroll > many.geometry.scroll,
    { before: many.geometry.scroll, after: afterWheel.geometry.scroll });

  await wheelLocal(...wheelTarget, 160, 0);
  const afterWheelX = await readState();
  check('横向滚轮（trackpad 左右滑）同样生效',
    afterWheelX.geometry.scroll > afterWheel.geometry.scroll,
    { before: afterWheel.geometry.scroll, after: afterWheelX.geometry.scroll });

  state = await readState();
  await clickLocal(...center(state.geometry.arrowL));
  const afterLeft = await readState();
  check('左箭头翻页把滚动位置往回收',
    afterLeft.geometry.scroll < afterWheelX.geometry.scroll,
    { before: afterWheelX.geometry.scroll, after: afterLeft.geometry.scroll });

  state = await readState();
  await clickLocal(...center(state.geometry.arrowR));
  const afterRight = await readState();
  check('右箭头翻页把滚动位置往后推',
    afterRight.geometry.scroll > afterLeft.geometry.scroll,
    { before: afterLeft.geometry.scroll, after: afterRight.geometry.scroll });

  // 滑动后点一个可见组标签，仍应切到正确的组（滚动偏移不能算错）
  state = await readState();
  const g = state.geometry;
  // 只点「完全落在可滚动视口内」的组标签：被裁掉一半的标签，其中心可能
  // 已经跑到右侧「＋ 新增组」按钮上（点错会新增一组而不是切组）。
  const fullyVisible = g.tabs.filter((t) => t.x >= g.viewportL
    && t.x + t.w <= g.viewportR);
  const pick = fullyVisible.find((t) => t.index >= 6) ?? fullyVisible.at(-1);
  if (pick) {
    await clickLocal(pick.x + pick.w / 2, pick.y + pick.h / 2);
    const picked = await readState();
    check('滑动后点击靠后的组标签能选中对应组（命中与绘制一致）',
      picked.index === pick.index && Number(picked.currentGroupWidget) === pick.index + 1,
      { expected: pick.index, index: picked.index, widget: picked.currentGroupWidget,
        fullyVisible: fullyVisible.map((t) => t.index) });
  } else {
    check('滑动后点击靠后的组标签能选中对应组（命中与绘制一致）', false,
      { reason: 'no fully visible tab', tabs: g.tabs.map((t) => t.index) });
  }

  // ---------------------------------------------------------------- G 拖拽重排 + 强度编辑
  await seedGroups([{
    id: 1, name: 'LoRA组1', loras: [
      { enable: true, name: 'AAA.safetensors', strength: 0.11 },
      { enable: true, name: 'BBB.safetensors', strength: 0.22 },
      { enable: true, name: 'CCC.safetensors', strength: 0.33 },
    ],
  }]);
  const three = await readState();
  const loraRows = three.rows.filter((r) => r.length === 3);
  check('读档恢复 3 行 LoRA 且三列顺序正确',
    loraRows.length === 3 && Number(three.visibleCount) === 3,
    { rows: loraRows.length, count: three.visibleCount });

  const firstEnable = loraRows[0][0];
  const thirdEnable = loraRows[2][0];
  // 拖拽手柄的坐标直接读前端挂出的同一份几何，不另写公式。
  const firstGeo = three.enableGeometries['LoRA1启用'];
  const thirdGeo = three.enableGeometries['LoRA3启用'];
  const handle = [firstGeo.handle.x + firstGeo.handle.w / 2, firstEnable.y + 12];
  const target = [thirdGeo.handle.x + thirdGeo.handle.w / 2, thirdEnable.y + 12];
  await dragLocal(handle, target);
  const reordered = await readState();
  check('上下拖拽后三行 LoRA 的 启用/名称/强度 整组换序',
    reordered.loraValues[2].name === 'AAA.safetensors'
      && reordered.loraValues[0].name === 'BBB.safetensors',
    reordered.loraValues.map((v) => v.name));

  state = await readState();
  const strengthCol = state.rows.filter((r) => r.length === 3)[0][2].col;
  const strengthY = state.rows.filter((r) => r.length === 3)[0][2].y;
  const strengthShape = {
    x: strengthCol[0] + 15, y: strengthY,
    w: strengthCol[1] - 30, h: 24,
  };
  const beforeStrength = Number(state.loraValues[0].strength);
  await clickLocal(strengthShape.x + strengthShape.w * 0.9, strengthShape.y + 12);
  const afterPlus = await readState();
  check('点强度格右侧 1/4 会加一个 step',
    Number(afterPlus.loraValues[0].strength) > beforeStrength,
    { before: beforeStrength, after: Number(afterPlus.loraValues[0].strength) });
  await clickLocal(strengthShape.x + strengthShape.w * 0.1, strengthShape.y + 12);
  const afterMinus = await readState();
  check('点强度格左侧 1/4 会减一个 step',
    Number(afterMinus.loraValues[0].strength) < Number(afterPlus.loraValues[0].strength),
    { before: Number(afterPlus.loraValues[0].strength), after: Number(afterMinus.loraValues[0].strength) });

  // ---------------------------------------------------------------- H 读档保持
  const beforeReload = await readState();
  await page.evaluate(async () => {
    const app = window.app;
    await app.loadGraphData(app.graph.serialize());
    await new Promise((r) => setTimeout(r, 900));
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    app.canvas.draw(true, true);
  });
  await sleep(350);
  const afterReload = await readState();
  check('serialize → loadGraphData 后组配置/当前组/3 行数据都保留',
    afterReload.groupCount === 1 && afterReload.index === 0
      && Number(afterReload.visibleCount) === 3,
    { groups: afterReload.groupCount, index: afterReload.index, count: afterReload.visibleCount });
  check('读档后拖拽重排的顺序与强度编辑结果都不丢',
    afterReload.loraValues.map((v) => v.name).join(',')
      === beforeReload.loraValues.map((v) => v.name).join(',')
      && Number(afterReload.loraValues[0].strength)
        === Number(beforeReload.loraValues[0].strength),
    { before: beforeReload.loraValues, after: afterReload.loraValues });
  check('读档后节点高度仍贴合内容（没有被引擎撑出空白或压掉行）',
    afterReload.size[1] > 150 && afterReload.size[1] < 260,
    afterReload.size);

  // 老存档里节点被存成高 260 的冗余高度（用户拖过 / 旧版本留下的底部空白），读档必须
  // 锁回内容高度；宽度交给 effectiveMinWidth 与手动宽度处理（不在本次高度修复范围）。
  await page.evaluate(async () => {
    const app = window.app;
    const n = window.__ggNode;
    n.setSize([n.size[0], 260]);
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [0, 0];
    const graph = app.graph.serialize();
    await app.loadGraphData(graph);
    await new Promise((r) => setTimeout(r, 900));
    app.canvas.draw(true, true);
  });
  await sleep(350);
  const afterOversizedReload = await readState();
  check('读档时老存档冗余高度（260）被锁回内容高度、空白不残留',
    afterOversizedReload.lockHeight === true
      && afterOversizedReload.size[1] < 260
      && afterOversizedReload.size[1] > 100,
    afterOversizedReload.size);

  // ---------------------------------------------------------------- J 视觉与开关专项
  // 回到 1 行默认 LoRA，方便精确量「按钮 ↔ 最后一行 ↔ 节点底边」。
  await seedGroups([{
    id: 1, name: 'LoRA组1', loras: [{ enable: true, name: 'None', strength: 1 }],
  }]);
  await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype;
    if (!proto.__ggTextHooked) {
      const originalText = proto.fillText;
      proto.fillText = function (...args) {
        (window.__ggTexts ??= []).push(String(args[0]));
        return originalText.apply(this, args);
      };
      proto.__ggTextHooked = true;
    }
    if (!proto.__ggRectHooked) {
      const originalRect = proto.roundRect;
      proto.roundRect = function (...args) {
        const radii = args[4];
        const r = Array.isArray(radii) ? Math.max(...radii.map(Number)) : Number(radii);
        if (r >= 12) (window.__ggBigRadius ??= []).push(r);
        return originalRect.apply(this, args);
      };
      proto.__ggRectHooked = true;
    }
  });
  const snapshotDraw = () => page.evaluate(() => {
    window.__ggTexts = [];
    window.__ggBigRadius = [];
    window.app.canvas.draw(true, true);
    return { texts: window.__ggTexts.slice(), bigRadius: window.__ggBigRadius.length };
  });

  await hoverLocal(700, 700);
  const plainDraw = await snapshotDraw();
  check('绘制里彻底没有「当前生效 / ＋ 新增组」这类提示文字',
    !plainDraw.texts.some((t) => /当前生效|新增组|组选择/.test(t)),
    plainDraw.texts.filter((t) => /组|生效/.test(t)).slice(0, 10));
  check('默认宽度下强度值 1.00 完整画出来了',
    plainDraw.texts.some((t) => /^1\.00$/.test(t)),
    plainDraw.texts.filter((t) => /\d/.test(t)).slice(0, 12));
  check('无后缀的短名称 None 原样显示，不会被误裁',
    plainDraw.texts.includes('None'),
    plainDraw.texts.filter((t) => /None|…/.test(t)).slice(0, 6));
  check('不悬浮时没有 ➕ 圆形按钮（半径≥12 的 roundRect 为 0）',
    plainDraw.bigRadius === 0, { bigRadius: plainDraw.bigRadius });

  state = await readState();
  await hoverLocal(...center(state.geometry.bar));
  const hoverDraw = await snapshotDraw();
  check('悬浮组条时 ➕ 圆形按钮真的被画出来',
    hoverDraw.bigRadius >= 1, { bigRadius: hoverDraw.bigRadius });

  const buttonGap = (s) => {
    const lora = s.rows.filter((r) => r.length === 3).at(-1);
    const add = s.rows.at(-1)[0];
    const lastBottom = Number(lora[0].y) + 24;
    const belowLast = Number(add.y) - lastBottom;       // 按钮上沿到末行下沿
    const gapBelow = s.size[1] - (Number(add.y) + 24);  // 按钮下沿到节点底边
    return { y: Number(add.y), belowLast, gapBelow, lastBottom, nodeBottom: s.size[1] };
  };
  await hoverLocal(700, 700);
  const flat = await readState();
  const flatGap = buttonGap(flat);
  // 高度锁死贴合内容：按钮紧贴最后一行、节点底边只有正常底边距，没有任何大空白。
  check('默认高度下新增LoRA 按钮紧贴最后一行、底边只有正常底边距（无大空白）',
    flat.lockHeight === true
      && flatGap.belowLast >= 0 && flatGap.belowLast <= 16
      && flatGap.gapBelow >= 0 && flatGap.gapBelow <= 16,
    flatGap);
  // 复现用户真实拖高路径：ComfyUI 拖动节点边时会把 canvas.resizing_node 设为该
  // 节点并调 setSize，触发 onResize 的 lock 分支。这里确定性地走同一条路径：
  // 高度锁必须①立即把尺寸收回内容高度（不留在 250）②清掉手动高度标记
  // ③properties 里高度分量归 0（只持久化宽度），按钮位置不动。
  const beforeH = flat.size[1];
  await page.evaluate(async () => {
    const n = window.__ggNode;
    const canvas = window.app.canvas;
    canvas.resizing_node = n;
    n.setSize([n.size[0], 250]);
    canvas.resizing_node = null;
    await new Promise((r) => setTimeout(r, 250));
    window.app.canvas.draw(true, true);
  });
  await sleep(300);
  const tall = await readState();
  const tallGap = buttonGap(tall);
  check('拖高后高度锁立即收回贴合内容：尺寸不留在高位、不留空白',
    tall.lockHeight === true
      && tall.size[1] === beforeH
      && tallGap.belowLast <= 16 && tallGap.gapBelow <= 16,
    { flatSize: flat.size, tallSize: tall.size, flatGap, tallGap });
  check('拖高动作不写手动高度标记、不持久化额外高度（只留宽度）',
    tall.manualHeightFlag == null
      && Array.isArray(tall.userSize)
      && Number(tall.userSize[0]) === flat.size[0]
      && Number(tall.userSize[1]) === 0,
    { manualHeightFlag: tall.manualHeightFlag, userSize: tall.userSize });

  // 复现用户真实踩坑：外部动作（折叠 / 读档 / 第三方插件）直接 setSize 把高度顶成
  // 260，但控件没变（布局签名不变），没有触发 onResize 的拖拽分支。高度锁必须靠
  // 「每帧 applyHeight」在下一帧把尺寸收回到内容高度，否则节点会永久停在高处留空白。
  await page.evaluate(async () => {
    const n = window.__ggNode;
    n.setSize([n.size[0], 260]); // 故意不设 canvas.resizing_node，模拟非拖拽的外部顶高
    window.app.canvas.draw(true, true);
  });
  await sleep(2500);
  const stuck = await readState();
  const stuckGap = buttonGap(stuck);
  check('外部 setSize 把高度顶高（非拖拽）后，下一帧高度锁自行收回贴合内容、不残留空白',
    stuck.lockHeight === true
      && stuck.size[1] === flat.size[1]
      && stuckGap.belowLast <= 16 && stuckGap.gapBelow <= 16,
    { flatSize: flat.size, stuckSize: stuck.size, flatGap, stuckGap });

  // 名称列：默认左右各留一段省略，滚轮可左右平移看全文。
  const LONG_NAME = 'anime_very_long_style_name_for_scrolling_test_v123_character_edition.safetensors';
  const VISIBLE_NAME = LONG_NAME.replace(/\.safetensors$/i, '');
  await page.evaluate((LONG_NAME) => {
    const n = window.__ggNode;
    const w = n.widgets.find((x) => x.name === 'LoRA1名称');
    w.value = LONG_NAME;
    w._ggNameScroll = 0;
    window.app.canvas.draw(true, true);
  }, LONG_NAME);
  const ellipsisDraw = await snapshotDraw();
  check('名称格省掉 .safetensors 后缀，腾出的宽度给文件名主体',
    !ellipsisDraw.texts.some((t) => /safetensors/i.test(t)),
    ellipsisDraw.texts.filter((t) => /safetensors/i.test(t)).slice(0, 5));
  check('去后缀后仍用「左右各保留一段」的中间省略（头尾都在）',
    ellipsisDraw.texts.some((t) => t.includes('…')
      && t.startsWith('anime_very_long')
      && t.includes('character_edition')),
    ellipsisDraw.texts.filter((t) => t.includes('…')).slice(0, 5));
  const rawName = await page.evaluate(() => {
    const n = window.__ggNode;
    return { value: n.widgets.find((x) => x.name === 'LoRA1名称')?.value };
  });
  check('只改展示，控件真实值仍是带后缀的原名（提交后端不变）',
    rawName.value === LONG_NAME, rawName);
  state = await readState();
  const nameWidgetRow = state.rows.filter((r) => r.length === 3)[0];
  const nameRect = {
    x: nameWidgetRow[1].col[0] + 15, y: nameWidgetRow[1].y,
    w: nameWidgetRow[1].col[1] - 30, h: 24,
  };
  await wheelLocal(nameRect.x + nameRect.w / 2, nameRect.y + 12, 160, 0);
  const scrolled = await readState();
  check('名称格上左右滚轮能平移查看被省略的部分',
    scrolled.nameScroll > state.nameScroll,
    { before: state.nameScroll, after: scrolled.nameScroll });
  const scrollDraw = await snapshotDraw();
  check('平移后画的是去后缀的完整文件名，而不是省略串',
    scrollDraw.texts.some((t) => t === VISIBLE_NAME)
      && !scrollDraw.texts.some((t) => /safetensors/i.test(t)),
    scrollDraw.texts.filter((t) => t.includes('anime_very_long')).slice(0, 4));

  // 启用 / 关闭：真的点得到、真的会翻转、真的会进序列化的控件值。
  state = await readState();
  const toggleRect = state.enableGeometries['LoRA1启用'].toggle;
  const toggleCenter = [toggleRect.x + toggleRect.w / 2,
    toggleRect.y + toggleRect.h / 2];
  await hoverLocal(700, 700);
  await clickLocal(...toggleCenter);
  const offState = await readState();
  check('点启用胶囊能把 LoRA1 从启用切成关闭（自绘列不吞点击）',
    offState.loraValues[0].enable === false,
    { before: state.loraValues[0].enable, after: offState.loraValues[0].enable });
  const serializedEnable = await page.evaluate(() => {
    const n = window.__ggNode;
    const data = window.app.graph.serialize();
    const all = data?.nodes ?? [];
    const saved = all.find((x) => String(x.id) === String(n.id)) ?? null;
    const w = n.widgets.find((x) => x.name === 'LoRA1启用');
    const index = n.widgets.findIndex((x) => x.name === 'LoRA1启用');
    // 节点 id 在内存里是字符串、序列化后是数字，必须按字符串比较，
    // 否则 saved 会是 null，看起来像「widgets_values 没写进去」。
    const values = saved?.widgets_values ?? null;
    return {
      live: w?.value, index, atIndex: Array.isArray(values) ? values[index] : null,
      hasFalse: Array.isArray(values) && values.some((v) => v === false),
      valuesLength: Array.isArray(values) ? values.length : 0,
    };
  });
  check('关闭状态会随工作流序列化（提交给后端的就是 false）',
    serializedEnable.live === false
      && serializedEnable.hasFalse
      && serializedEnable.atIndex === false,
    serializedEnable);
  await clickLocal(...toggleCenter);
  const onState = await readState();
  check('再点一次能切回启用', onState.loraValues[0].enable === true,
    onState.loraValues[0]);

  // ---------------------------------------------------------------- H 空槽自动收回 / 组改名
  // 与「GG LoRA自定义加载」一致：名称选 None 的空槽自动收掉，后面的槽位前移。
  await seedGroups([{
    id: 1, name: 'LoRA组1',
    loras: [
      { enable: true, name: 'COMPACT_A.safetensors', strength: 0.8 },
      { enable: false, name: 'COMPACT_B.safetensors', strength: 1.2 },
    ],
  }]);
  // loadGraphData 会重建节点实例；readState 负责把 window.__ggNode 指向
  // 真正挂在图上的那一个，否则后面会操作到已经脱离画布的旧对象（假 FAIL）。
  state = await readState();
  await page.evaluate(() => {
    const n = window.__ggNode;
    const w = n.widgets.find((x) => x.name === 'LoRA1名称');
    if (!w) return;
    w.value = 'None';
    // 真实下拉选中后会走控件 callback，这里按同一入口触发。
    w.callback?.('None', w, n);
    window.app.canvas.draw(true, true);
  });
  await sleep(320);
  const compacted = await readState();
  check('选到 None 后空槽自动收回（2 行变 1 行，后一行前移）',
    Number(compacted.visibleCount) === 1
      && compacted.loraValues[0].name === 'COMPACT_B.safetensors'
      && Number(compacted.loraValues[0].strength) === 1.2
      && compacted.loraValues[0].enable === false
      && compacted.loraValues[1].name === 'None',
    compacted.loraValues);
  check('收回后的组数据同步写进 properties（切组 / 读档不会带回空槽）',
    compacted.groups[0]?.loras?.length === 1
      && compacted.groups[0].loras[0].name === 'COMPACT_B.safetensors',
    compacted.groups[0]?.loras);
  check('收回空槽后节点高度同步贴合，不残留一行空白',
    compacted.size[1] < state.size[1],
    { before: state.size, after: compacted.size });

  // 右键组标签改名：覆盖 canvas.prompt，模拟用户输入后回车。
  await page.evaluate(() => {
    window.__ggPromptCalls = [];
    window.app.canvas.prompt = (title, value, callback) => {
      window.__ggPromptCalls.push([title, value]);
      callback('风景组');
    };
  });
  state = await readState();
  const renameTab = state.geometry.tabs[0];
  const [renameX, renameY] = await toScreen(
    [renameTab.x + renameTab.w / 2, renameTab.y + renameTab.h / 2]);
  await page.mouse.click(renameX, renameY, { button: 'right' });
  await sleep(300);
  const renamed = await readState();
  const promptCalls = await page.evaluate(() => window.__ggPromptCalls);
  check('右键组标签弹出「组名称」并用输入值改写 properties',
    promptCalls.length === 1 && promptCalls[0][0] === '组名称'
      && promptCalls[0][1] === 'LoRA组1'
      && renamed.groupNames[0] === '风景组',
    { promptCalls, names: renamed.groupNames });
  const contextMenuShown = await page.evaluate(() => {
    const el = document.querySelector('.litecontextmenu');
    return !!el && el.offsetParent !== null;
  });
  check('右键组标签不会同时弹出画布 / 节点的原生右键菜单',
    contextMenuShown === false, { contextMenuShown });

  // ---------------------------------------------------------------- I 异常与资源
  check('全程无页面脚本异常（外部扩展启动噪音单独归类）',
    errors.length === 0, errors.slice(0, 6));
  check('异常过滤器有效，不会把本模块错误当噪音吞掉',
    isOwnModuleError('Uncaught TypeError in gg-lora-group-loader.js')
      && !isOwnModuleError("Error calling extension 'gulips.bridge' method 'setup': io is not defined")
      && !externalNoise.some((s) => isOwnModuleError(s)),
    { externalNoise: externalNoise.length, sample: externalNoise.slice(0, 2) });
  const ourMissing = missing.filter((u) => /gg-lora-group-loader|gg-widget-rows|lora_tools/.test(u));
  check('404 只来自本机缺预览资源，本模块前端文件无缺失',
    ourMissing.length === 0, { total: missing.length, ourMissing });

  await page.evaluate(() => window.app.loadGraphData(window.__ggSavedGraph));
  await browser.close();

  const pass = checks.filter((c) => c.ok).length;
  checks.forEach((c) => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`));
  console.log(`\n${pass}/${checks.length} passed`);
  if (pass !== checks.length) process.exitCode = 1;
})();
