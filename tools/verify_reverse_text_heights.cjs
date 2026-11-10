// GG 文本反推 · 长文本区高度策略专项验收（设计稿 04 落点规格表）。
//
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       GG_COMFY_URL=http://127.0.0.1:8188/ node tools/verify_reverse_text_heights.cjs
//
// 判据要点：
//  1. 本前端版本对多个 customtext 是「弹性平分节点剩余高度」，所以必须用
//     computeSize 的返回值 + 重排后的 widget.y 一起判，只看 DOM 高度会假 PASS。
//  2. 反向验证：把 computeSize 还原成官方原函数，四个区必须退回「等高弹性」，
//     证明扩展确实在起作用，而不是测了个本来就成立的常量。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.GG_COMFY_URL || "http://127.0.0.1:8188/";
const NODE = "GGWebAIReverseText";

// 与 web/gg-reverse-text-heights.js 的 SPEC 同源
const SPEC = {
  "小说内容": { rows: 6, max: 12, minPx: 54, group: "输入源" },
  "提取规则": { rows: 4, max: 12, minPx: 54, group: "提取规则" },
  "总结要求": { rows: 4, max: 10, minPx: 54, group: "提取规则" },
  "系统提示词": { rows: 3, max: 8, minPx: 40, group: "高级" },
};
const WIDGET_BASE = 47.5;
const ROW_PX = 20;
// 官方 DomWidget 固定把 computeSize()[1] 加 4px 写到 computedHeight。
// 判据必须用这个宿主开销，否则会误报「同步失败」。
const OFFICIAL_PADDING = 4;
const heightOf = (rows) => WIDGET_BASE + rows * ROW_PX;
const observedOf = (rows) => heightOf(rows) + OFFICIAL_PADDING;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/gulips\.bridge|report-only|vite:preloadError|Failed to load resource/i.test(t)) return;
    consoleErrors.push(t);
  });
  page.on("response", (r) => { if (r.status() === 404) { /* 本机缺预览素材，单独归类 */ } });

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !!window.app?.graph, null, { timeout: 90000 });
    await page.waitForTimeout(3500);

    const state = await page.evaluate(async (spec) => {
      const saved = app.graph.serialize();
      const n = LiteGraph.createNode("GGWebAIReverseText");
      app.graph.add(n);
      n.pos = [120, 120];
      app.graph.setDirtyCanvas(true, true);
      await new Promise((r) => setTimeout(r, 1400));

      const names = Object.keys(spec);
      const snapshot = () => names.map((name) => {
        const w = n.widgets.find((x) => x.name === name);
        const ta = w?.element?.tagName === "TEXTAREA" ? w.element : w?.element?.querySelector?.("textarea");
        let cs = null;
        if (w?.computeSize) { try { cs = w.computeSize(400); } catch {} }
        return {
          name,
          y: +Number(w?.y).toFixed(1),
          ch: +Number(w?.computedHeight).toFixed(1),
          declared: Array.isArray(cs) ? +Number(cs[1]).toFixed(1) : null,
          taH: ta ? +parseFloat(getComputedStyle(ta).height).toFixed(1) : null,
          overflowY: ta ? getComputedStyle(ta).overflowY : null,
          minHeight: ta ? getComputedStyle(ta).minHeight : null,
          scrollH: ta ? ta.scrollHeight : null,
          clientH: ta ? ta.clientHeight : null,
          expandBtn: ta ? !!ta.parentElement?.querySelector(":scope > .gg-rt-expand") : false,
          expandShown: ta ? (() => {
            const b = ta.parentElement?.querySelector(":scope > .gg-rt-expand");
            return b ? getComputedStyle(b).display !== "none" : false;
          })() : false,
        };
      });

      const installed = snapshot();
      const nodeSize = [...n.size];
      const computedSize = (() => { try { return [...n.computeSize()]; } catch { return null; } })();

      // 编辑态：聚焦第一个文本区应撑到上限，失焦回默认
      const first = n.widgets.find((w) => w.name === "小说内容");
      const taFirst = first?.element?.tagName === "TEXTAREA" ? first.element : first?.element?.querySelector?.("textarea");
      if (taFirst) taFirst.dispatchEvent(new FocusEvent("focus"));
      await new Promise((r) => setTimeout(r, 700));
      const focusRows = first?._ggRtRows;
      const focusH = +Number(first?.computedHeight).toFixed(1);
      if (taFirst) taFirst.dispatchEvent(new FocusEvent("blur"));
      await new Promise((r) => setTimeout(r, 700));
      const blurRows = first?._ggRtRows;
      const blurH = +Number(first?.computedHeight).toFixed(1);

      // 反向验证：还原官方 computeSize，确认旧行为（弹性等高）真的会回来
      for (const name of names) {
        const w = n.widgets.find((x) => x.name === name);
        if (w?._ggRtOriginalComputeSize) w.computeSize = w._ggRtOriginalComputeSize;
        else if (w?.computeSize && w.computeSize[Symbol.for("GuliNodes.reverseTextHeights.patched")]) {
          // 拿不到原函数时，用一个「官方默认」替身模拟未安装态
          w.computeSize = () => [400, 87.5];
        }
      }
      n.setSize([420, 560]);
      n.setDirtyCanvas(true, true);
      app.graph.setDirtyCanvas(true, true);
      await new Promise((r) => setTimeout(r, 1200));
      const reverted = snapshot();

      app.graph.clear();
      if (saved) app.loadGraphData(saved);
      return { installed, nodeSize, computedSize, focusRows, focusH, blurRows, blurH, reverted };
    }, SPEC);

    // ---- 1. 差异化默认行数 ----
    const paddings = [];
    for (const row of state.installed) {
      const want = heightOf(SPEC[row.name].rows);
      check(`${row.name} computeSize 声明 = ${want}`, Math.abs((row.declared ?? -1) - want) < 1.5,
        `实际 ${row.declared}`);
      check(`${row.name} 官方 computedHeight 同步 = ${observedOf(SPEC[row.name].rows)}`,
        Math.abs(row.ch - observedOf(SPEC[row.name].rows)) < 1.5, `实际 ${row.ch}`);
      paddings.push(+(row.ch - (row.declared ?? 0)).toFixed(1));
    }
    check("四区宿主开销一致（同步性没有漂移）",
      paddings.every((v) => Math.abs(v - OFFICIAL_PADDING) < 0.6),
      `实际偏移 ${paddings.join(" / ")}，期望恒为 ${OFFICIAL_PADDING}`);

    // ---- 2. 同组等高 / 自适应区比折叠区高 ----
    const a = state.installed.find((r) => r.name === "提取规则");
    const b = state.installed.find((r) => r.name === "总结要求");
    check("同组（提取规则 / 总结要求）默认高度一致", Math.abs(a.ch - b.ch) < 1.5, `${a.ch} vs ${b.ch}`);
    const novel = state.installed.find((r) => r.name === "小说内容");
    const system = state.installed.find((r) => r.name === "系统提示词");
    check("自适应区(6行) 高于 高级区(3行)", novel.ch > system.ch + 50, `${novel.ch} vs ${system.ch}`);

    // ---- 3. 重排后不重叠 ----
    const seq = [...state.installed].sort((x, y) => x.y - y.y);
    const overlaps = [];
    for (let i = 0; i < seq.length - 1; i += 1) {
      if (seq[i].y + seq[i].ch > seq[i + 1].y + 0.5) overlaps.push(`${seq[i].name}→${seq[i + 1].name}`);
    }
    check("四个文本区重排后零重叠", overlaps.length === 0, overlaps.join(", ") || "无重叠");
    check("节点高度由官方 computeSize 自动重算", state.computedSize && state.computedSize[1] > 600,
      `computeSize=${JSON.stringify(state.computedSize)} size=${JSON.stringify(state.nodeSize)}`);

    // ---- 4. DOM 层：被裁不用滚动条 + 最小高度 ----
    for (const row of state.installed) {
      check(`${row.name} 无滚动条（overflowY=hidden）`, row.overflowY === "hidden", `实际 ${row.overflowY}`);
      check(`${row.name} 最小高度 ${SPEC[row.name].minPx}px`, row.minHeight === `${SPEC[row.name].minPx}px`,
        `实际 ${row.minHeight}`);
      check(`${row.name} 右下角「展开」按钮已挂载`, row.expandBtn === true);
    }

    // ---- 5. 编辑态撑上限 / 失焦回默认 ----
    check("聚焦编辑态撑到 12 行上限", state.focusRows === 12, `_ggRtRows=${state.focusRows}`);
    check("聚焦时 computedHeight 同步变大", Math.abs(state.focusH - observedOf(12)) < 2,
      `实际 ${state.focusH}，期望 ${observedOf(12)}`);
    check("失焦回到默认 6 行", state.blurRows === 6, `_ggRtRows=${state.blurRows}`);
    check("失焦时 computedHeight 同步回落", Math.abs(state.blurH - observedOf(6)) < 2,
      `实际 ${state.blurH}，期望 ${observedOf(6)}`);

    // ---- 6. 反向验证：卸载后退回弹性等高 ----
    const revHeights = state.reverted.map((r) => r.ch);
    const revSame = revHeights.every((h) => Math.abs(h - revHeights[0]) < 1);
    check("反向验证：还原官方 computeSize 后四区退回等高弹性（旧行为确实存在）", revSame,
      `实际 ${revHeights.join(" / ")}`);

    check("全程无 pageerror", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
    check("无本模块 console error", !consoleErrors.some((e) => /reverse-text-heights/i.test(e)),
      consoleErrors.slice(0, 2).join(" | ") || "无");
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
