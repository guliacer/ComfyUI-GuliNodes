// 诊断：对比 position relative / absolute / fixed 三种覆盖下 DOM widget 的实际落位
const { chromium } = require('playwright');

const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out';

(async () => {
  const ctx = await chromium.launchPersistentContext('C:/Users/Admin/AppData/Local/Temp/gg-diag-rt6', {
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1600, height: 1200 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3000);

  // 清空画布，只留一个目标节点，排除其它节点的 dom-widget 干扰
  await page.evaluate(async () => {
    window.app.graph.clear();
    const n = window.LiteGraph.createNode('GGWebAIReverseText');
    window.app.graph.add(n);
    n.pos = [120, 60];
    window.__target = n;
    await new Promise((r) => setTimeout(r, 1500));
    window.app.canvas.ds.offset = [0, 0];
    window.app.canvas.ds.scale = 1;
    window.app.canvas.setDirty(true, true);
    await new Promise((r) => setTimeout(r, 600));
  });

  const probe = async () =>
    page.evaluate(() => {
      const isolate = document.querySelector('div[data-testid="dom-widgets"]');
      const gcc = document.querySelector('.graph-canvas-container');
      const r = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const widgets = [...document.querySelectorAll('div.dom-widget')].map((el) => {
        const ta = el.querySelector('textarea');
        return {
          txt: ta ? (ta.value || '').replace(/\n/g, '\\n').slice(0, 10) : null,
          style: (el.getAttribute('style') || '').replace(/\s+/g, ' ').slice(0, 120),
          pos: getComputedStyle(el).position,
          rect: r(el),
        };
      });
      return {
        isolateRect: r(isolate),
        gccRect: r(gcc),
        gccPos: gcc ? getComputedStyle(gcc).position : null,
        widgets,
      };
    });

  const inject = async (css) =>
    page.evaluate((c) => {
      let s = document.getElementById('probe-css');
      if (!s) {
        s = document.createElement('style');
        s.id = 'probe-css';
        document.head.appendChild(s);
      }
      s.textContent = c;
      return new Promise((res) => setTimeout(() => res(true), 500));
    }, css);

  const results = {};

  results.A_baseline = await probe();
  await page.screenshot({ path: `${SHOT}/rt6_A.png`, clip: { x: 0, y: 0, width: 1000, height: 900 } });

  await inject(`div[data-testid="dom-widgets"]>div{position:absolute!important;}`);
  results.B_absolute = await probe();
  await page.screenshot({ path: `${SHOT}/rt6_B.png`, clip: { x: 0, y: 0, width: 1000, height: 900 } });

  await inject(`div[data-testid="dom-widgets"]>div{position:fixed!important;}`);
  results.C_fixed = await probe();
  await page.screenshot({ path: `${SHOT}/rt6_C.png`, clip: { x: 0, y: 0, width: 1000, height: 900 } });

  // D: absolute + 让定位层本身成为定位基准
  await inject(`div[data-testid="dom-widgets"]{position:absolute!important;inset:0!important;}
div[data-testid="dom-widgets"]>div{position:absolute!important;}`);
  results.D_abs_container = await probe();
  await page.screenshot({ path: `${SHOT}/rt6_D.png`, clip: { x: 0, y: 0, width: 1000, height: 900 } });

  console.log(JSON.stringify(results, null, 2));
  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
