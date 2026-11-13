// 诊断：默认工作流下，强制 fixed 前后对比 DOM widget 位置
const { chromium } = require('playwright');
const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out';

const probeFn = () => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const iso = document.querySelector('div[data-testid="dom-widgets"]');
  return {
    scale: window.app.canvas.ds.scale,
    isolate: r(iso),
    nodes: window.app.graph._nodes.slice(0, 8).map((n) => ({
      title: n.title,
      pos: n.pos,
      size: [Math.round(n.size[0]), Math.round(n.size[1])],
    })),
    ws: [...document.querySelectorAll('div.dom-widget')].map((el) => {
      const ta = el.querySelector('textarea');
      return {
        txt: ta ? (ta.value || '').replace(/\n/g, '\\n').slice(0, 8) : null,
        pos: getComputedStyle(el).position,
        style: (el.getAttribute('style') || '').replace(/\s+/g, ' ').slice(0, 92),
        rect: r(el),
      };
    }),
  };
};

(async () => {
  const ctx = await chromium.launchPersistentContext('C:/Users/Admin/AppData/Local/Temp/gg-diag-rt9', {
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1600, height: 1200 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(5000);

  const before = await page.evaluate(probeFn);
  await page.screenshot({ path: `${SHOT}/rt9_before.png`, clip: { x: 0, y: 0, width: 1200, height: 1000 } });

  await page.evaluate(async () => {
    const s = document.createElement('style');
    s.textContent = `div[data-testid="dom-widgets"]>div{position:fixed!important;}`;
    document.head.appendChild(s);
    await new Promise((r) => setTimeout(r, 900));
  });

  const after = await page.evaluate(probeFn);
  await page.screenshot({ path: `${SHOT}/rt9_after.png`, clip: { x: 0, y: 0, width: 1200, height: 1000 } });

  console.log(JSON.stringify({ before, after }, null, 2));
  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
