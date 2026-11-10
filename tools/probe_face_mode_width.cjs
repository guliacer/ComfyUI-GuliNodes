// 一次性探针：GGFaceSmartBeauty 切模式后 content minWidth 是否跟上
const { chromium } = require('playwright-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
  await page.waitForTimeout(1000);
  const out = await page.evaluate(async () => {
    const app = window.app;
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    app.graph.clear();
    const node = window.LiteGraph.createNode('GGFaceSmartBeauty');
    app.graph.add(node);
    await tick(); await tick();
    const snap = () => {
      const st = node._ggRowLayout ?? {};
      const w = node.widgets.find((x) => x.name === '人脸识别方式');
      return {
        mode: w?.value,
        display: w?._displayValue,
        size0: Math.round(node.size[0]),
        stateMinWidth: Math.round(st.minWidth ?? -1),
        configMin: st.config?.minWidth,
      };
    };
    const steps = [snap()];
    const combo = node.widgets.find((x) => x.name === '人脸识别方式');
    for (const v of ['内置检测', '外部遮罩', 'SAM3']) {
      combo.setValue?.(v, { e: null, node, canvas: app.canvas });
      await tick(); await tick();
      await new Promise((r) => setTimeout(r, 200));
      await tick(); await tick();
      steps.push({ ...snap(), after: 'wait' });
      // 手动触发一次重排，看 content 分支本身算多少
      node._arrangeWidgets?.();
      await tick(); await tick();
      steps.push({ ...snap(), after: 'arrange' });
    }
    return steps;
  });
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})();
