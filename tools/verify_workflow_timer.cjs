// NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules node tools/verify_workflow_timer.cjs
// Uses a private browser/settings fixture; only a tiny native image test is executed.
const { chromium } = require(process.env.GG_PLAYWRIGHT || "playwright-core");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const URL = process.env.GG_COMFY_URL || "http://127.0.0.1:8188/";
const CHROME = process.env.GG_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = resolve(__dirname, "out/workflow_timer");

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const checks = []; const artifacts = []; const noise = []; const errors = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: ok ? undefined : detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + JSON.stringify(detail)}`); };
  try {
    const context = await browser.newContext({ viewport: { width: 1700, height: 1050 }, deviceScaleFactor: 2 });
    const { installSurfaceSettingsFixture } = await import(pathToFileURL(resolve(__dirname, "../.workbuddy-ai/harness/surface-settings-fixture.mjs")).href);
    await installSurfaceSettingsFixture(context, URL);
    await context.route(/\/userdata(?:\/|\?)/, route => route.request().method() === "GET" ? route.continue() : route.fulfill({ json: { status: "ok" } }));
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    page.on("console", message => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/gg-workflow-timer|gg-title-node|gg-ui-design/.test(text)) errors.push(text);
      else noise.push(text.slice(0, 300));
    });
    const posted = [];
    page.on("request", request => { if (request.method() === "POST" && /\/prompt$/.test(new globalThis.URL(request.url()).pathname)) posted.push({ url: request.url(), prompt: request.postDataJSON()?.prompt }); });
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(() => window.app?.canvas?.ds && window.app?.api?._ggWorkflowTimerHooksInstalled && window.LiteGraph?.registered_node_types?.GGWorkflowTimer, null, { timeout: 120000 });
    const initialVueMode = await page.evaluate(() => !!(LiteGraph.vueNodesMode || app.canvas.vueNodesMode || app.vueNodesMode));
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      const settings = app.ui.settings;
      await settings.setSettingValue("GuliNodes.WorkflowTimer.Enabled", true);
      await settings.setSettingValue("GuliNodes.enableTapRelayNotification", false);
      await settings.setSettingValue("GuliNodes.enableSuyanButton", false);
      app.graph.clear(); app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0];
      const add = (type, title, pos) => { const node = LiteGraph.createNode(type); if (!node) throw Error(type); app.graph.add(node); node.pos = pos; if (title) node.title = title; return node; };
      const title = add("GGTitleNode", null, [70, 90]);
      const titleText = title.widgets.find(widget => widget.name === "标题文本"); titleText.value = "工作流耗时分析"; titleText.callback?.(titleText.value); title.setSize([480, 70]);
      add("GGWorkflowTimer", null, [70, 210]);
      const image = add("EmptyImage", "测试图像", [1000, 90]);
      for (const [name, value] of [["width", 64], ["height", 64], ["batch_size", 1], ["color", Date.now() % 0xffffff]]) {
        const widget = image.widgets.find(widget => widget.name === name); if (widget) { widget.value = value; widget.callback?.(value); }
      }
      const invert = add("ImageInvert", "测试反相", [1000, 360]);
      const scale = add("ImageScaleBy", "测试缩放", [1300, 360]);
      const preview = add("PreviewImage", "测试预览", [1300, 620]);
      image.connect(0, invert, 0); invert.connect(0, scale, 0); scale.connect(0, preview, 0);
      const data = app.graph.serialize(); await app.loadGraphData(data);
      app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0];
      window.__timerNode = () => app.graph._nodes.find(node => node.type === "GGWorkflowTimer");
      window.__timerEvents = [];
      for (const type of ["execution_start", "execution_success", "execution_cached", "progress_state"]) app.api.addEventListener(type, ({ detail }) => __timerEvents.push({ type, detail }));
      app.canvas.setDirty(true, true);
    });
    await page.waitForTimeout(500);
    const before = await page.evaluate(async () => {
      const node = __timerNode(); const prompt = await app.graphToPrompt();
      return { virtual: node.isVirtualNode, inputs: node.inputs?.filter(input => input.link != null).length, outputs: node.outputs?.length,
        widgets: node.widgets.length, apiHasTimer: Object.values(prompt.output).some(item => item.class_type === "GGWorkflowTimer"),
        workflowHasTimer: prompt.workflow.nodes.some(item => item.type === "GGWorkflowTimer"), size: Array.from(node.size) };
    });
    check("GG 耗时仍是无接线虚拟展示节点", before.virtual && !before.inputs && !before.outputs && !before.apiHasTimer && before.workflowHasTimer, before);
    check("14 个原有控件定义保持", before.widgets === 14, before);
    if (process.env.GG_TIMER_PROBE_ONLY) {
      const previous = JSON.parse(readFileSync(resolve(OUT, "verification.json"), "utf8")).firstSummary;
      await page.evaluate(summary => { __timerNode().properties._gg_workflow_timer_result = summary; }, previous);
      const snapshots = [];
      for (const vue of [false, true]) {
        await setMode(vue, "light");
        snapshots.push(await page.evaluate(vue => {
          const node = __timerNode(); const root = document.querySelector(`.lg-node[data-node-id="${node.id}"]`); const panel = root?.querySelector(".gg-timer-dashboard");
          return { vue, id: node.id, pos: Array.from(node.pos), size: Array.from(node.size), properties: node.properties,
            widgets: node.widgets.map(widget => ({ name: widget.name, value: widget.value })), ds: { scale: app.canvas.ds.scale, offset: Array.from(app.canvas.ds.offset) },
            root: root && { rect: root.getBoundingClientRect().toJSON(), style: root.getAttribute("style"), cls: root.className,
              handles: [...root.querySelectorAll("[data-corner]")].map(handle => ({ corner: handle.dataset.corner, rect: handle.getBoundingClientRect().toJSON(), title: handle.title })) },
            panel: panel && { rect: panel.getBoundingClientRect().toJSON(), style: panel.getAttribute("style"), background: getComputedStyle(panel).backgroundColor } };
        }, vue));
      }
      writeFileSync(resolve(OUT, "probe.json"), JSON.stringify(snapshots, null, 2)); console.log(JSON.stringify(snapshots)); return;
    }

    const response = await page.evaluate(async () => app.api.queuePrompt(0, await app.graphToPrompt()));
    await page.waitForFunction(id => __timerNode()?.properties?._gg_workflow_timer_result?.promptId === id && __timerNode().properties._gg_workflow_timer_result.status === "success", response.prompt_id, { timeout: 45000 });
    const actual = await page.evaluate(() => {
      const summary = __timerNode().properties._gg_workflow_timer_result;
      const start = __timerEvents.find(event => event.type === "execution_start" && event.detail.prompt_id === summary.promptId);
      const end = __timerEvents.find(event => event.type === "execution_success" && event.detail.prompt_id === summary.promptId);
      return { summary, expectedMs: end.detail.timestamp - start.detail.timestamp,
        sawRunning: __timerEvents.some(event => event.type === "progress_state" && Object.values(event.detail.nodes ?? {}).some(node => node.state === "running")) };
    });
    check("真实总用时等于原生开始/完成时间戳差", actual.summary.totalMs === actual.expectedMs, actual);
    check("无预览输出的原生节点也参与 Top3", actual.sawRunning && actual.summary.topNodes.length === 3, actual);
    check("Top3 按真实耗时降序且不重复节点", actual.summary.topNodes.every((node, index, nodes) => index === 0 || nodes[index - 1].ms >= node.ms)
      && new Set(actual.summary.topNodes.map(node => node.id)).size === 3, actual.summary);
    const firstSummary = actual.summary;

    async function drawState() {
      return page.evaluate(() => {
        const node = __timerNode(); const ctx = document.createElement("canvas").getContext("2d"); const fills = [];
        const original = ctx.fillText; ctx.fillText = function (text, ...args) { fills.push({ text: String(text), color: this.fillStyle }); return original.call(this, text, ...args); };
        app.canvas.drawNode(node, ctx);
        const dom = document.querySelector(`.lg-node[data-node-id="${node.id}"] .gg-timer-dashboard`);
        const rows = dom ? [...dom.querySelectorAll(".gg-timer-row")].map(row => ({ name: row.querySelector(".gg-timer-name")?.textContent,
          fullName: row.querySelector(".gg-timer-name")?.title, ratio: parseFloat(row.querySelector(".gg-timer-fill")?.style.width),
          track: row.querySelector(".gg-timer-track")?.getBoundingClientRect().toJSON(), fill: row.querySelector(".gg-timer-fill")?.getBoundingClientRect().toJSON(),
          nameRect: row.querySelector(".gg-timer-name")?.getBoundingClientRect().toJSON(), timeRect: row.querySelector(".gg-timer-node-time")?.getBoundingClientRect().toJSON() })) : [];
        return { fills, dom: dom ? { title: dom.querySelector(".gg-timer-title-text")?.textContent, text: dom.textContent, rows,
          background: getComputedStyle(dom).backgroundColor, color: getComputedStyle(dom).color, stacked: dom.dataset.stacked } : null, size: Array.from(node.size) };
      });
    }
    async function setMode(vue, palette) {
      await page.evaluate(async ({ vue, palette }) => {
        await app.ui.settings.setSettingValue("Comfy.ColorPalette", palette);
        app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0]; app.canvas.setDirty(true, true);
      }, { vue, palette });
      await page.waitForTimeout(1200);
      if (vue) await page.waitForSelector(".gg-timer-dashboard", { state: "visible", timeout: 15000 });
    }
    async function verifyNativeSearchPlacement(vue) {
      const originalGraph = await page.evaluate(() => app.graph.serialize());
      await page.evaluate(async ({ vue }) => {
        await app.ui.settings.setSettingValue("Comfy.ColorPalette", "light");
        app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0]; app.canvas.setDirty(true, true);
      }, { vue });
      await page.waitForTimeout(1200);
      await page.evaluate(() => app.graph.clear());
      const canvas = await page.locator("canvas").first().boundingBox();
      const searchPoint = [canvas.x + canvas.width / 2, canvas.y + canvas.height / 2];
      await page.keyboard.press("Escape");
      await page.mouse.dblclick(...searchPoint, { delay: 100 });
      const search = page.getByPlaceholder("添加节点...");
      await search.waitFor({ state: "visible" });
      await search.fill("GG 耗时");
      await page.locator('[data-testid="result-item"]').filter({ hasText: "GG 耗时" }).first().click();
      await page.waitForFunction(() => app.graph._nodes.filter(node => node.type === "GGWorkflowTimer").length === 1);
      await page.waitForTimeout(150);
      const toolbar = page.locator("#gg-title-floating-toolbar");
      const toolbarVisible = await toolbar.isVisible();
      const placed = await page.evaluate(() => {
        const node = app.graph._nodes.find(item => item.type === "GGWorkflowTimer");
        return { count: app.graph._nodes.filter(item => item.type === "GGWorkflowTimer").length, id: node?.id,
          pos: node ? Array.from(node.pos) : null, size: node ? Array.from(node.size) : null };
      });
      check(`${vue ? "Nodes2" : "Canvas"} 原生搜索放置后保留节点并打开配置`, placed.count === 1 && toolbarVisible, { ...placed, toolbarVisible });
      if (toolbarVisible) await toolbar.locator("[data-display-content]").selectOption("总用时");
      const configured = await page.evaluate(() => app.graph._nodes.find(node => node.type === "GGWorkflowTimer")?.widgets?.find(widget => widget.name === "展示内容")?.value);
      check(`${vue ? "Nodes2" : "Canvas"} 原生放置后配置条可操作`, toolbarVisible && configured === "总用时", { toolbarVisible, configured });
      await page.mouse.click(canvas.x + canvas.width * 0.86, canvas.y + canvas.height * 0.78);
      await page.waitForTimeout(200);
      const afterBlankClick = await page.evaluate(() => {
        const node = app.graph._nodes.find(item => item.type === "GGWorkflowTimer");
        return { count: app.graph._nodes.filter(item => item.type === "GGWorkflowTimer").length, pos: node ? Array.from(node.pos) : null };
      });
      check(`${vue ? "Nodes2" : "Canvas"} 空白处点击不再二次移动节点`, afterBlankClick.count === 1
        && afterBlankClick.pos.every((value, index) => Math.abs(value - placed.pos[index]) < 1), { placed, afterBlankClick });
      const saved = await page.evaluate(() => app.graph.serialize());
      await page.evaluate(data => app.loadGraphData(data), saved);
      await page.waitForTimeout(300);
      const reloaded = await page.evaluate(() => {
        const nodes = app.graph._nodes.filter(item => item.type === "GGWorkflowTimer");
        return { count: nodes.length, pos: nodes[0] ? Array.from(nodes[0].pos) : null };
      });
      check(`${vue ? "Nodes2" : "Canvas"} 原生放置保存重载保留`, reloaded.count === 1
        && reloaded.pos.every((value, index) => Math.abs(value - placed.pos[index]) < 1), { placed, reloaded });
      await page.evaluate(data => app.loadGraphData(data), originalGraph);
      await page.waitForTimeout(400);
    }
    async function shot(name) {
      await page.evaluate(() => { app.canvas.deselectAllNodes?.(); app.canvas.setDirty(true, true); }); await page.waitForTimeout(300);
      const box = await page.evaluate(() => {
        const node = __timerNode(); const rect = app.canvas.canvas.getBoundingClientRect(); const ds = app.canvas.ds;
        const dom = document.querySelector(`.lg-node[data-node-id="${node.id}"]`);
        if (LiteGraph.vueNodesMode && dom) { const bounds = dom.getBoundingClientRect(); return { x: Math.max(0, bounds.x - 12), y: Math.max(0, bounds.y - 12), width: bounds.width + 24, height: bounds.height + 24 }; }
        return { x: Math.max(0, rect.left + (node.pos[0] + ds.offset[0]) * ds.scale - 12), y: Math.max(0, rect.top + (node.pos[1] + ds.offset[1]) * ds.scale - 12),
          width: node.size[0] * ds.scale + 24, height: node.size[1] * ds.scale + 24 };
      });
      const path = resolve(OUT, name); await page.screenshot({ path, clip: box }); artifacts.push(path);
    }
    for (const vue of [initialVueMode]) await verifyNativeSearchPlacement(vue);
    for (const vue of [initialVueMode]) for (const palette of ["light", "dark"]) {
      await setMode(vue, palette); const state = await drawState(); const label = `${vue ? "Nodes2" : "Canvas"}/${palette}`;
      check(`${label} 仪表盘标题与真实总用时可见`, vue ? state.dom?.title === "GG 耗时" && state.dom.text.includes("总用时") : state.fills.some(fill => fill.text === "GG 耗时") && state.fills.some(fill => fill.text === "总用时"), state);
      if (vue) {
        check(`${label} 最长比例条为100%`, state.dom.rows.length === 3 && Math.abs(state.dom.rows[0].ratio - 100) < 0.01, state.dom);
        check(`${label} 名称与时间互不遮挡`, state.dom.rows.every(row => row.nameRect.right <= row.timeRect.left + 1), state.dom.rows);
        check(`${label} 其余条宽遵循真实比例`, state.dom.rows.every((row, index) => Math.abs(row.ratio - firstSummary.topNodes[index].ms / firstSummary.topNodes[0].ms * 100) < 0.02), state.dom.rows);
      } else check(`${label} 每次仅绘制一个标题`, state.fills.filter(fill => fill.text === "GG 耗时").length === 1, state.fills);
      if (palette === "light") await shot(vue ? "nodes2-light.png" : "canvas-light.png");
    }

    for (const vue of [initialVueMode]) {
      await setMode(vue, "light");
      await page.evaluate(() => { const node = __timerNode(); app.canvas.resizing_node = node; node.setSize([640, 320]); app.canvas.resizing_node = null; app.canvas.setDirty(true, true); });
      await page.waitForTimeout(250);
      await page.evaluate(() => { const node = __timerNode(); app.canvas.selectNode(node); node.onSelected?.(); });
      const toolbar = page.locator("#gg-title-floating-toolbar"); await toolbar.waitFor({ state: "visible" });
      check(`${vue ? "Nodes2" : "Canvas"} 复用工具栏且统计只读`, await toolbar.locator("textarea").evaluate(element => element.readOnly), null);
      for (const display of ["总用时", "耗时最长的三个节点", "全部"]) {
        await toolbar.locator("[data-display-content]").selectOption(display); await page.waitForTimeout(100);
        const state = await drawState();
        check(`${vue ? "Nodes2" : "Canvas"} 切换${display}保留尺寸`, state.size[0] === 640 && state.size[1] === 320, state.size);
      }
      await page.evaluate(() => app.canvas.deselectAllNodes?.()); await page.keyboard.press("Escape"); await page.waitForTimeout(150);
      const corner = await page.evaluate(vue => {
        const node = __timerNode();
        if (vue) {
          const element = document.querySelector(`.lg-node[data-node-id="${node.id}"]`);
          const handles = [...element.querySelectorAll("[data-corner]")];
          const handle = handles.find(handle => /^(bottom[-_]?right|se|southeast)$/i.test(handle.dataset.corner));
          if (!handle) throw Error("缺少右下角 resize handle");
          const rect = handle.getBoundingClientRect(); return [rect.x + rect.width / 2, rect.y + rect.height / 2];
        }
        const rect = app.canvas.canvas.getBoundingClientRect(); const ds = app.canvas.ds;
        return [rect.left + (node.pos[0] + node.size[0] - 3 + ds.offset[0]) * ds.scale, rect.top + (node.pos[1] + node.size[1] - 3 + ds.offset[1]) * ds.scale];
      }, vue);
      await page.mouse.move(...corner); await page.mouse.down(); await page.mouse.move(corner[0] - 100, corner[1] - 80, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(400);
      const smaller = await page.evaluate(() => Array.from(__timerNode().size));
      check(`${vue ? "Nodes2" : "Canvas"} 用户仍能实际拖小`, smaller[0] < 590 && smaller[1] < 280, smaller);
      const saved = await page.evaluate(() => app.graph.serialize());
      await page.evaluate(data => app.loadGraphData(data), saved); await page.waitForTimeout(600);
      const loaded = await page.evaluate(() => ({ size: Array.from(__timerNode().size), data: __timerNode().properties._gg_workflow_timer_result }));
      check(`${vue ? "Nodes2" : "Canvas"} 保存重载保留用户尺寸和既有数据`, loaded.size.every((value, index) => Math.abs(value - smaller[index]) <= 1) && JSON.stringify(loaded.data) === JSON.stringify(firstSummary), loaded);
      await page.evaluate(() => { const node = __timerNode(); const options = []; node.getExtraMenuOptions(app.canvas, options); options.find(option => option?.content === "按文字适配尺寸").callback(); });
      const fitted = await page.evaluate(() => ({ size: Array.from(__timerNode().size), data: app.graph.serialize() }));
      await page.evaluate(data => app.loadGraphData(data), fitted.data); await page.waitForTimeout(600);
      const afterFit = await page.evaluate(() => Array.from(__timerNode().size));
      check(`${vue ? "Nodes2" : "Canvas"} 显式适配后重载不回到旧尺寸`, afterFit.every((value, index) => Math.abs(value - fitted.size[index]) <= 1), { fitted: fitted.size, loaded: afterFit });
      if (vue) {
        await page.evaluate(() => { __timerNode().setSize([360, 280]); app.canvas.setDirty(true, true); }); await page.waitForTimeout(350);
        const narrow = await drawState();
        check("窄节点改为上下布局且不补虚假项", narrow.dom?.stacked === "true" && narrow.dom.rows.length === 3, narrow.dom);
        check("窄节点名称与时间不重叠", narrow.dom.rows.length === 3 && narrow.dom.rows.every(row => row.nameRect.right <= row.timeRect.left + 1), narrow.dom.rows);
      }
    }
    check("UI交互与绘制没有重复执行工作流", posted.length === 1, posted);
    const second = await page.evaluate(async () => app.api.queuePrompt(0, await app.graphToPrompt()));
    await page.waitForFunction(id => __timerNode()?.properties?._gg_workflow_timer_result?.promptId === id, second.prompt_id, { timeout: 45000 });
    const cached = await page.evaluate(() => __timerNode().properties._gg_workflow_timer_result);
    check("真实全缓存执行不制造Top3", cached.status === "success" && cached.cachedCount > 0 && cached.topNodes.length === 0, cached);
    check("当前前端无本功能脚本异常", errors.length === 0, errors);
    writeFileSync(resolve(OUT, "verification.json"), JSON.stringify({ checks, artifacts, firstSummary, cached, posted, errors, externalNoise: noise }, null, 2));
    console.log(`RESULT ${checks.filter(check => check.ok).length}/${checks.length}`);
    if (checks.some(check => !check.ok)) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
