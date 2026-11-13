// 尺寸回缩排查探针（诊断用，不作回归断言）。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       GG_COMFY_URL=http://127.0.0.1:8188/ node tools/probe_size_shrink.cjs
//
// 做法：手动把节点拉高，再触发该节点自己的「重排 / 重新贴合」路径，
// 看节点高度是否被收回到内容高度。收回去的即与 `GG 文本拼接` 同类问题。
const { chromium } = require("playwright-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.GG_COMFY_URL || "http://127.0.0.1:8188/";
const TALL = 820;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200)));

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => !!window.app?.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3500);

  const report = await page.evaluate(async (tall) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const backup = app.graph.serialize();
    const height = (n) => Math.round(Number(n?.size?.[1]) || 0);
    const width = (n) => Math.round(Number(n?.size?.[0]) || 0);
    const make = async (cls) => {
      const node = LiteGraph.createNode(cls);
      if (!node) return null;
      app.graph.add(node);
      node.pos = [120, 120];
      app.graph.setDirtyCanvas(true, true);
      await sleep(1400);
      return node;
    };
    const userResize = async (node, h) => {
      app.canvas.resizing_node = node;
      try {
        node.setSize([Math.max(360, width(node)), h]);
      } finally {
        app.canvas.resizing_node = null;
      }
      node.setDirtyCanvas?.(true, true);
      app.graph.setDirtyCanvas?.(true, true);
      await sleep(900);
      return height(node);
    };
    const out = {};

    // 1) GG 视频保存：执行回包 / 预览元数据加载都会走 lockPreviewInsideNode(node, true)
    {
      const node = await make("GGVideoSave");
      if (node) {
        const before = await userResize(node, tall);
        node.onExecuted?.({});
        await sleep(900);
        const afterExecuted = height(node);
        // 再模拟一次读档
        const saved = app.graph.serialize();
        app.graph.clear();
        await app.loadGraphData(saved);
        const reloaded = (app.graph._nodes || []).find((n) => n.comfyClass === "GGVideoSave");
        await sleep(1800);
        out.videoSave = { before, afterExecuted, afterReload: height(reloaded) };
        app.graph.clear();
        await app.loadGraphData(backup);
        await sleep(600);
      } else {
        out.videoSave = { missing: true };
      }
    }

    // 2) GG 网页反推：切平台 / 执行回包都走 resizeNodeToPanel（精确高度）
    {
      const node = await make("GGWebAIReverseImage");
      if (node) {
        const before = await userResize(node, tall);
        const platform = node.widgets?.find((w) => w.name === "平台");
        if (platform) {
          const values = platform.options?.values ?? [];
          const next = values.find((v) => v !== platform.value) ?? platform.value;
          platform.value = next;
          platform.callback?.(next);
        }
        await sleep(1200);
        out.webAiReverse = { before, afterPlatform: height(node), platform: platform?.value };
        app.graph.remove(node);
        await sleep(200);
      } else {
        out.webAiReverse = { missing: true };
      }
    }

    // 3) GG 图像压缩保存：切格式（对照组，预期保留多余高度）
    {
      const node = await make("GGImageCompressSave");
      if (node) {
        const before = await userResize(node, tall);
        const format = node.widgets?.find((w) => w.name === "格式");
        if (format) {
          const values = format.options?.values ?? [];
          const next = values.find((v) => v !== format.value) ?? format.value;
          format.value = next;
          format.callback?.(next);
        }
        await sleep(900);
        out.compressSave = { before, afterFormat: height(node), format: format?.value };
        app.graph.remove(node);
        await sleep(200);
      } else {
        out.compressSave = { missing: true };
      }
    }

    // 4) GGLoRA自定义加载（已知按槽位精确贴合，作对照）
    {
      const node = await make("GGLoRACustomLoader");
      if (node) {
        const before = await userResize(node, tall);
        const count = node.widgets?.find((w) => w.name === "LoRA数量" || w.name === "LoRA 数量");
        if (count) {
          const values = count.options?.values ?? [];
          const next = values[0];
          if (next != null && next !== count.value) {
            count.value = next;
            count.callback?.(next);
          }
        }
        await sleep(1200);
        out.loraLoader = { before, afterCount: height(node), count: count?.value };
        app.graph.remove(node);
        await sleep(200);
      } else {
        out.loraLoader = { missing: true };
      }
    }

    return out;
  }, TALL);

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})();
