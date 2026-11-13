// GG 提示词增强 · 控件输入（seed / 输入提示词）连线可见性探针。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       GG_COMFY_URL=http://127.0.0.1:8188/ node tools/probe_prompt_enhancer_ports.cjs
const path = require("path");
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.GG_COMFY_URL || "http://127.0.0.1:8188/";
const OUT = path.join(__dirname, "out", "prompt_enhancer_ports.png");

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200)));

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => !!window.app?.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3500);

  const report = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const backup = app.graph.serialize();
    const out = {};

    const node = LiteGraph.createNode("GGPromptEnhancer");
    app.graph.add(node);
    node.pos = [3000, 2000];
    app.graph.setDirtyCanvas(true, true);
    await sleep(1600);

    const source = LiteGraph.createNode("GGSeedGenerator");
    app.graph.add(source);
    source.pos = [2620, 1960];
    const textSource = LiteGraph.createNode("GGTextConcat");
    app.graph.add(textSource);
    textSource.pos = [2620, 2320];
    await sleep(600);

    const mirror = (name) => (node.inputs || []).find((i) => i?.widget?.name === name);
    const seedIndex = node.inputs.indexOf(mirror("seed"));
    const promptIndex = node.inputs.indexOf(mirror("输入提示词"));

    const connect = (from, fromSlot, toIndex) => {
      try {
        const result = from.connect(fromSlot, node, toIndex);
        return result === undefined ? "void" : result;
      } catch (error) {
        return String(error).slice(0, 120);
      }
    };
    out.connectSeed = connect(source, 0, seedIndex);
    out.connectPrompt = connect(textSource, 0, promptIndex);
    out.seedIndex = seedIndex;
    out.promptIndex = promptIndex;
    await sleep(1500);

    const widgetRow = (name) => (node.widgets || []).find((w) => w.name === name);
    out.state = ["seed", "输入提示词", "最大生成token"].map((name) => {
      const input = mirror(name);
      const widget = widgetRow(name);
      return {
        name,
        widgetY: Math.round(Number(widget?.y) || 0),
        widgetHidden: !!widget?.hidden,
        widgetType: String(widget?.type),
        computedHeight: Math.round(Number(widget?.computedHeight) || 0),
        inputPos: Array.isArray(input?.pos) ? input.pos.map((v) => Math.round(v)) : null,
        inputLink: input?.link ?? null,
      };
    });
    out.rows = (node.widgets || [])
      .filter((w) => !w.hidden || mirror(w.name))
      .map((w) => ({
        name: w.name,
        y: Math.round(Number(w.y) || 0),
        h: Math.round(Number(w.computedHeight) || 0),
        hidden: !!w.hidden,
      }));
    out.computeSize = (() => {
      try {
        const size = node.computeSize();
        return Array.isArray(size) ? size.map((v) => Math.round(v)) : null;
      } catch { return null; }
    })();
    out.size = [Math.round(node.size[0]), Math.round(node.size[1])];
    out.canvasScale = app.canvas?.ds?.scale ?? null;
    out.nodePos = node.pos.map((v) => Math.round(v));

    // 把节点区域截进画布中央，方便肉眼核对
    app.canvas.ds.scale = 1.3;
    app.canvas.ds.offset = [-(node.pos[0] - 300), -(node.pos[1] - 120)];
    app.graph.setDirtyCanvas(true, true);
    await sleep(800);

    window.__probeNode = node;
    window.__probeBackup = backup;
    return out;
  });

  const box = await page.evaluate(() => {
    const n = window.__probeNode;
    const ds = app.canvas.ds;
    const canvas = app.canvas.canvas.getBoundingClientRect();
    const x = canvas.left + (n.pos[0] + ds.offset[0]) * ds.scale;
    const y = canvas.top + (n.pos[1] + ds.offset[1]) * ds.scale;
    return { x: Math.round(x), y: Math.round(y), width: Math.round(n.size[0] * ds.scale), height: Math.round(n.size[1] * ds.scale) };
  });
  await page.screenshot({ path: OUT, clip: { x: box.x - 30, y: box.y - 60, width: Math.min(900, box.width + 420), height: Math.min(1000, box.height + 120) } });

  console.log(JSON.stringify({ report, shot: OUT }, null, 2));
  await page.evaluate(async () => {
    app.graph.clear();
    await app.loadGraphData(window.__probeBackup);
  });
  await browser.close();
})();
