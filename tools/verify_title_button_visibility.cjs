// Verify the title-bar icons remain visible without hovering and follow width tiers.
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.GG_COMFY_URL || "http://127.0.0.1:8188/";

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => window.app?.canvas?.ctx && window.LiteGraph
      && window.__ggApplyPortListToggle && window.__ggApplyNodeCollapseButton && window.__ggApplyNodePinButton,
    null, { timeout: 90000 });
    await page.waitForTimeout(1200);

    const result = await page.evaluate(async () => {
      app.graph.clear();
      const node = LiteGraph.createNode("GGAspectRatioAdapter");
      if (!node) throw new Error("GGAspectRatioAdapter 创建失败");
      app.graph.add(node);
      node.pos = [200, 200];
      await new Promise((resolve) => setTimeout(resolve, 250));
      node._ggPortListNodeHovered = false;
      node._ggPortListCollapseButtonHovered = false;
      node._ggPortListPinButtonHovered = false;
      node.selected = false;

      const ctx = app.canvas.ctx;
      const originalLineTo = ctx.lineTo;
      const originalStroke = ctx.stroke;
      let lineToCalls = 0;
      let strokeCalls = 0;
      ctx.lineTo = function (...args) {
        lineToCalls += 1;
        return originalLineTo.apply(this, args);
      };
      ctx.stroke = function (...args) {
        strokeCalls += 1;
        return originalStroke.apply(this, args);
      };

      const capture = (width, enabled) => {
        window.__ggApplyPortListToggle(enabled);
        window.__ggApplyNodeCollapseButton(enabled);
        window.__ggApplyNodePinButton(enabled);
        node.size[0] = width;
        lineToCalls = 0;
        strokeCalls = 0;
        app.canvas.drawNode(node, ctx);
        return { width: node.size[0], lineTo: lineToCalls, stroke: strokeCalls };
      };

      try {
        const widths = [320, 260, 200, 180];
        const tiers = {};
        for (const width of widths) {
          const baseline = capture(width, false);
          const visible = capture(width, true);
          tiers[width] = {
            width: visible.width,
            extraLineTo: visible.lineTo - baseline.lineTo,
            extraStroke: visible.stroke - baseline.stroke,
          };
        }
        return tiers;
      } finally {
        ctx.lineTo = originalLineTo;
        ctx.stroke = originalStroke;
      }
    });

    const tier320 = result[320];
    const tier260 = result[260];
    const tier200 = result[200];
    const tier180 = result[180];
    const checks = [
      ["320px shows three default icons", tier320.extraLineTo >= 12 && tier320.extraStroke >= 3],
      ["260px hides pin but keeps port and collapse", tier260.extraLineTo >= 8 && tier260.extraStroke >= 2],
      ["200px keeps the collapse icon", tier200.extraLineTo >= 8 && tier200.extraStroke >= 1],
      ["180px narrow tier preserves the collapse icon", tier180.width === 180 && tier180.extraLineTo >= 8 && tier180.extraStroke >= 1],
      ["title icons render without hover or selection", tier320.extraLineTo > 0 && tier320.extraStroke > 0],
      ["no uncaught page errors", pageErrors.length === 0],
    ];
    for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
    console.log("DRAW_COUNTS", JSON.stringify(result));
    if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FATAL", error);
  process.exitCode = 1;
});
