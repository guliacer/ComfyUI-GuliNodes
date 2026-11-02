// 验证「GG 网页AI图像反推」的平台下拉与 iframe 地址。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_web_ai_platform.cjs
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TARGET = 'https://fanyi.baidu.com/mtpe-individual/transText#/';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // iframe 里的百度页面会报各种跨域错误，这里只收顶层页面的。
  page.on('console', (m) => {
    if (m.type() === 'error' && m.location().url.includes('/extensions/')) errors.push(m.text());
  });

  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 120000 });
  await page.waitForTimeout(1200);

  const result = await page.evaluate(async (target) => {
    const app = window.app;
    const node = window.LiteGraph.createNode('GGWebAIReverseImage');
    if (!node) return { fatal: '节点类型未注册（后端需要重启才会加载新代码）' };
    app.graph.add(node);
    node.pos = [40, 40];
    await new Promise((r) => setTimeout(r, 600));

    const platformWidget = node.widgets?.find((w) => w.name === '平台');
    const options = Array.isArray(platformWidget?.options?.values) ? platformWidget.options.values : null;

    const readSrc = () => node.ggWebAIReversePanel?.iframe?.getAttribute('src') ?? null;

    const before = { platform: platformWidget?.value, src: readSrc() };

    // 直接改值并触发回调，等同于用户在下拉里选中。
    if (platformWidget) {
      platformWidget.value = '百度翻译';
      platformWidget.callback?.('百度翻译');
    }
    await new Promise((r) => setTimeout(r, 400));
    const after = { platform: platformWidget?.value, src: readSrc() };

    // 自定义网址输入框在非「自定义」平台下应保持隐藏
    const customWidget = node.widgets?.find((w) => w.name === '自定义网址');
    const customHidden = customWidget ? { hidden: !!customWidget.hidden, type: customWidget.type } : null;

    return {
      nodeClass: node.comfyClass,
      options,
      hasOption: Array.isArray(options) ? options.includes('百度翻译') : null,
      before,
      after,
      matchesTarget: after.src === target,
      customHidden,
      panelExists: !!node.ggWebAIReversePanel,
    };
  }, TARGET);

  await page.waitForTimeout(2500);
  const finalSrc = await page.evaluate(() => {
    const n = window.app.graph._nodes.find((x) => x.comfyClass === 'GGWebAIReverseImage');
    return n?.ggWebAIReversePanel?.iframe?.getAttribute('src') ?? null;
  });

  console.log(JSON.stringify({
    ...result,
    finalSrc,
    pageErrors: errors.filter((e) => !/favicon|404/i.test(e)),
  }, null, 2));
  await browser.close();
})();
