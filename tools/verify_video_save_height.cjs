// GG 视频保存 · 高度保持专项验收。
//
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       GG_COMFY_URL=http://127.0.0.1:8188/ node tools/verify_video_save_height.cjs
//
// 背景：这个节点的预览贴合原来在所有路径上都「按内容精确设置高度」，包括读档、
// 执行回包、预览元数据加载，于是用户拉高 / 工作流里存的高度每次都会被收回最小高度。
// 现在只有新建节点收一次，其余路径只增不减（用户自己往下拖仍然可以变小）。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.GG_COMFY_URL || "http://127.0.0.1:8188/";
const NODE = "GGVideoSave";
const TALL = 820;

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
  const near = (a, b, tol = 2) => Math.abs(Number(a) - Number(b)) <= tol;

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !!window.app?.graph, null, { timeout: 90000 });
    await page.waitForTimeout(3500);

    const state = await page.evaluate(async ({ nodeName, tall }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const backup = app.graph.serialize();
      const height = (n) => Math.round(Number(n?.size?.[1]) || 0);
      const userResize = async (node, h) => {
        app.canvas.resizing_node = node;
        try {
          node.setSize([Math.max(360, Math.round(Number(node.size?.[0]) || 360)), h]);
        } finally {
          app.canvas.resizing_node = null;
        }
        node.setDirtyCanvas?.(true, true);
        app.graph.setDirtyCanvas?.(true, true);
        await sleep(900);
        return height(node);
      };

      const node = LiteGraph.createNode(nodeName);
      if (!node) return { missing: true };
      app.graph.add(node);
      node.pos = [160, 160];
      app.graph.setDirtyCanvas(true, true);
      await sleep(1600);

      const initial = height(node);
      const manual = await userResize(node, tall);

      // 执行回包（没有视频路径时也会走一次预览贴合）
      node.onExecuted?.({});
      await sleep(900);
      const afterExecuted = height(node);

      // 预览元数据加载（真实路径：videoEl 的 loadedmetadata 监听里会再贴合一次）
      node.ggVideoPreviewWidget?.videoEl?.dispatchEvent(new Event("loadedmetadata"));
      await sleep(600);
      const afterMetadata = height(node);

      // 读档：工作流里存的是 820，加载回来必须还是 820
      const serialized = app.graph.serialize();
      app.graph.clear();
      await app.loadGraphData(serialized);
      const reloaded = (app.graph._nodes || []).find(
        (n) => n.comfyClass === nodeName || n.type === nodeName,
      );
      await sleep(1800);
      const afterReload = height(reloaded);

      // 反向检查：用户自己往下拖仍然能变小（只增不减不是「锁死」）
      const shrunk = reloaded ? await userResize(reloaded, 300) : -1;

      app.graph.clear();
      await app.loadGraphData(backup);
      await sleep(600);

      return { initial, manual, afterExecuted, afterMetadata, afterReload, shrunk };
    }, { nodeName: NODE, tall: TALL });

    if (state.missing) {
      check(`画布上能创建 ${NODE}`, false, "LiteGraph.createNode 返回空");
    } else {
      check("新建节点按内容收一次（不保留大段空白）", state.initial > 0 && state.initial < 500,
        `实际 ${state.initial}`);
      check(`手动拉高到 ${TALL} 生效`, near(state.manual, TALL), `实际 ${state.manual}`);
      check("执行回包后保持手动高度", near(state.afterExecuted, TALL), `实际 ${state.afterExecuted}`);
      check("预览元数据加载后保持手动高度", near(state.afterMetadata, TALL),
        `实际 ${state.afterMetadata}`);
      check(`读档后保留存档高度 ${TALL}`, near(state.afterReload, TALL), `实际 ${state.afterReload}`);
      check("用户仍可自己把节点拖矮", state.shrunk > 0 && state.shrunk < TALL - 100,
        `实际 ${state.shrunk}`);
    }

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
