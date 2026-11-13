// GG 提示词增强 · 已接线控件（seed / 输入提示词）的可视标记与行高回缩验收。
//
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       GG_COMFY_URL=http://127.0.0.1:8188/ node tools/verify_prompt_enhancer_wired_rows.cjs
//
// 背景：子图里把「编辑需求」「seed」提升成输入后，前端会把控件藏起来只留一个端口点。
// 原实现让多行文本区继续按 318px 占位（节点中间一大块空白），端口点也没有任何文字，
// 用户看不出线连在哪。现在：已接线且被隐藏的控件收成一行，并在该行画
// 「控件名 ← 上游输入」；断开后恢复多行文本区。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.GG_COMFY_URL || "http://127.0.0.1:8188/";
const NODE = "GGPromptEnhancer";
const ROW = 24;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !!window.app?.graph, null, { timeout: 90000 });
    await page.waitForTimeout(3500);

    const state = await page.evaluate(async ({ nodeName }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const backup = app.graph.serialize();
      const row = (node, name) => (node.widgets || []).find((w) => w.name === name) || null;
      const mirror = (node, name) => (node.inputs || []).find((i) => i?.widget?.name === name) || null;
      const metrics = (node) => {
        const pick = (name) => {
          const widget = row(node, name);
          return widget ? {
            hidden: !!widget.hidden,
            y: Math.round(Number(widget.y) || 0),
            h: Math.round(Number(widget.computedHeight) || 0),
          } : null;
        };
        return {
          seed: pick("seed"),
          prompt: pick("输入提示词"),
          transparent: pick("透明背景"),
          direction: pick("增强方向"),
        };
      };

      const node = LiteGraph.createNode(nodeName);
      app.graph.add(node);
      node.pos = [3000, 2000];
      app.graph.setDirtyCanvas(true, true);
      await sleep(1600);

      const seedSource = LiteGraph.createNode("GGSeedGenerator");
      app.graph.add(seedSource);
      seedSource.pos = [2620, 1960];
      const textSource = LiteGraph.createNode("GGTextConcat");
      app.graph.add(textSource);
      textSource.pos = [2620, 2320];
      await sleep(700);

      const before = metrics(node);

      const connect = (from, toName) => {
        const input = mirror(node, toName);
        const index = node.inputs.indexOf(input);
        from.connect(0, node, index);
        return { index, link: input?.link ?? null };
      };
      const seedLink = connect(seedSource, "seed");
      const promptLink = connect(textSource, "输入提示词");
      await sleep(1500);
      const wired = metrics(node);

      // 断开：控件应恢复成可编辑的多行文本区
      for (const name of ["seed", "输入提示词"]) {
        const input = mirror(node, name);
        if (input?.link != null) {
          try { app.graph.removeLink ? app.graph.removeLink(input.link) : node.disconnectInput(node.inputs.indexOf(input)); } catch { /* 忽略 */ }
        }
      }
      await sleep(1500);
      const restored = metrics(node);

      app.graph.clear();
      await app.loadGraphData(backup);
      await sleep(600);
      return { before, wired, restored, seedLink, promptLink };
    }, { nodeName: NODE });

    // ---- 接线后：两行都收成一行，端口点有归属 ----
    check("seed 接线成功", state.seedLink?.link != null, `link=${state.seedLink?.link}`);
    check("文本接线成功", state.promptLink?.link != null, `link=${state.promptLink?.link}`);
    check("接线后 seed 控件被前端隐藏", state.wired.seed?.hidden === true,
      JSON.stringify(state.wired.seed));
    check(`接线后 seed 行收成 ${ROW}px`, state.wired.seed?.h === ROW, `实际 ${state.wired.seed?.h}`);
    check("接线后文本控件被前端隐藏", state.wired.prompt?.hidden === true,
      JSON.stringify(state.wired.prompt));
    check(`接线后多行文本区收成 ${ROW}px（不再留 300+ 空白）`, state.wired.prompt?.h === ROW,
      `实际 ${state.wired.prompt?.h}`);
    check("文本行紧跟 seed 行，没有被大块空白隔开",
      state.wired.prompt?.y - state.wired.seed?.y <= ROW * 2 + 8,
      `seed.y=${state.wired.seed?.y} prompt.y=${state.wired.prompt?.y}`);
    check("下方参数行同步上移", state.wired.transparent?.y < 300,
      `透明背景 y=${state.wired.transparent?.y}`);

    // ---- 断开后：恢复原状 ----
    check("断开后 seed 控件恢复显示", state.restored.seed?.hidden === false,
      JSON.stringify(state.restored.seed));
    check("断开后文本区恢复多行高度", (state.restored.prompt?.h ?? 0) > 200,
      `实际 ${state.restored.prompt?.h}`);
    check("断开后下方参数行回到原位", state.restored.transparent?.y > 400,
      `透明背景 y=${state.restored.transparent?.y}`);

    check("全程无 pageerror", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  } catch (err) {
    check("脚本执行完成", false, String(err).slice(0, 240));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n总结: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log("失败项:");
    for (const f of failed) console.log(`  - ${f.name} :: ${f.detail}`);
    process.exit(1);
  }
})();
