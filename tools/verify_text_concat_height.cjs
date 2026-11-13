// GG 文本拼接 · 高度基线专项验收。
//
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       GG_COMFY_URL=http://127.0.0.1:8188/ node tools/verify_text_concat_height.cjs
//
// 背景：这个节点的槽位是「按内容自动长出来」的，高度如果每次改字都跟着重新贴合，
// 用户拉高之后的尺寸会被一路收回到最小高度（用户实测报的缺陷）。现在的策略是
// 「只增不减」：手动拉过的高度锁成基线，清空 / 重填 / 换文本都不许把它收回去；
// 读档时以工作流里存的高度为基线，settle 结束后再锁死。
//
// 判据要点：
//  1. 首帧不能把 20 个槽位全算进 computeSize（实测会报 1100+），所以初始高度必须接近最小高度。
//  2. 手动拉到 620 之后，清空、重填、再等 2 秒都不能掉下去。
//  3. 读档（loadGraphData）后必须保留存档的 500，且 settle 全过程不允许低于它。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.GG_COMFY_URL || "http://127.0.0.1:8188/";
const NODE = "GGTextConcat";
const STORED_HEIGHT = 500;
const MANUAL_HEIGHT = 620;

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

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const near = (a, b, tol = 2) => Math.abs(Number(a) - Number(b)) <= tol;

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !!window.app?.graph, null, { timeout: 90000 });
    await page.waitForTimeout(3500);

    const state = await page.evaluate(async ({ nodeName, storedHeight, manualHeight }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const savedBackup = app.graph.serialize();

      const n = LiteGraph.createNode(nodeName);
      app.graph.add(n);
      n.pos = [200, 200];
      app.graph.setDirtyCanvas(true, true);
      // 等 setupNode 的 120 / 320 / 800ms 三轮 settle 结束
      await sleep(1600);

      const height = () => Math.round(Number(n.size?.[1]) || 0);
      const slot = (index) => n.widgets.find((w) => w.name === `文本${index}`) ?? null;
      const setSlot = async (index, text) => {
        const w = slot(index);
        if (!w) return false;
        w.value = text;
        try {
          w.callback?.(text);
        } catch {
          // 回调只是触发源之一，onDrawForeground 每帧还会补一次
        }
        n.setDirtyCanvas?.(true, true);
        app.graph.setDirtyCanvas?.(true, true);
        await sleep(1000);
        return true;
      };
      // 模拟用户握着节点下边拖动：只有 canvas.resizing_node === node 才算用户改尺寸
      const userResizeTo = async (h) => {
        app.canvas.resizing_node = n;
        try {
          n.setSize([Number(n.size?.[0]) || 340, h]);
        } finally {
          app.canvas.resizing_node = null;
        }
        n.setDirtyCanvas?.(true, true);
        app.graph.setDirtyCanvas?.(true, true);
        await sleep(1000);
      };

      const initial = height();
      const grewText1 = await setSlot(1, "第一段很长的提示词，用来撑开文本框并触发槽位增长。".repeat(3));
      const grown = height();
      const grewText2 = await setSlot(2, "第二段提示词，再长出一格。".repeat(3));
      const grown2 = height();

      await userResizeTo(manualHeight);
      const manual = height();

      // 清空：内容变少也不许把节点收回去
      await setSlot(1, "");
      await setSlot(2, "");
      const afterClear = height();
      await sleep(1500);
      const afterClearIdle = height();

      // 重填：换输入文本同样保持
      await setSlot(1, "换了一段全新的输入文本，高度必须原地不动。".repeat(2));
      const afterRetext = height();
      await sleep(1500);
      const afterRetextIdle = height();

      // 读档：把高度改成存档值后序列化，再整图加载回来
      await userResizeTo(storedHeight);
      const serialized = app.graph.serialize();
      app.graph.clear();
      await app.loadGraphData(serialized);
      const loaded = () => (app.graph._nodes ?? []).find((x) => x.comfyClass === nodeName || x.type === nodeName) ?? null;
      const samples = [];
      for (const delay of [80, 200, 400, 900, 1600]) {
        await sleep(delay === 80 ? 80 : delay - samples.at(-1).at);
        const node = loaded();
        samples.push({ at: delay, h: node ? Math.round(Number(node.size?.[1]) || 0) : -1 });
      }

      app.graph.clear();
      if (savedBackup) app.loadGraphData(savedBackup);

      return {
        initial,
        grown,
        grown2,
        grewText1,
        grewText2,
        manual,
        afterClear,
        afterClearIdle,
        afterRetext,
        afterRetextIdle,
        samples,
      };
    }, { nodeName: NODE, storedHeight: STORED_HEIGHT, manualHeight: MANUAL_HEIGHT });

    // ---- 1. 首帧不能把 20 个隐藏槽位算进高度 ----
    check("初始高度接近最小高度（未把 20 个槽位全算入）", state.initial > 0 && state.initial < 200,
      `实际 ${state.initial}`);

    // ---- 2. 内容增长时只增不减 ----
    check("文本1 有字后长出文本2 并把节点撑高", state.grewText1 && state.grown > state.initial + 20,
      `${state.initial} → ${state.grown}`);
    check("文本2 有字后继续撑高", state.grewText2 && state.grown2 > state.grown + 20,
      `${state.grown} → ${state.grown2}`);

    // ---- 3. 手动高度锁成基线 ----
    check(`手动拖动到 ${MANUAL_HEIGHT} 生效`, near(state.manual, MANUAL_HEIGHT),
      `实际 ${state.manual}`);
    check("清空全部文本后保持手动高度", near(state.afterClear, MANUAL_HEIGHT),
      `实际 ${state.afterClear}`);
    check("清空后静置 1.5s 仍不缩回", near(state.afterClearIdle, MANUAL_HEIGHT),
      `实际 ${state.afterClearIdle}`);
    check("重新填入文本后保持手动高度", near(state.afterRetext, MANUAL_HEIGHT),
      `实际 ${state.afterRetext}`);
    check("重填后静置 1.5s 仍不缩回", near(state.afterRetextIdle, MANUAL_HEIGHT),
      `实际 ${state.afterRetextIdle}`);

    // ---- 4. 读档保留存档高度，settle 全程不许低于它 ----
    const finalSample = state.samples.at(-1);
    check(`读档后保留存档高度 ${STORED_HEIGHT}`, finalSample && near(finalSample.h, STORED_HEIGHT),
      `实际 ${finalSample?.h}`);
    const dips = state.samples.filter((s) => s.h >= 0 && s.h < STORED_HEIGHT - 2);
    check("读档 settle 全过程不低于存档高度", dips.length === 0,
      dips.map((s) => `${s.at}ms=${s.h}`).join(", ") || "无回落");

    check("全程无 pageerror", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
    check("无本模块 console error", !consoleErrors.some((e) => /text-concat/i.test(e)),
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
