// 诊断：缩放下复现 + 抓 position 写入栈 + 验证 fixed!important 能否归位
const { chromium } = require('playwright');
const SHOT = 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out';

(async () => {
  const ctx = await chromium.launchPersistentContext('C:/Users/Admin/AppData/Local/Temp/gg-diag-rt7', {
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1600, height: 1200 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3000);

  await page.evaluate(async () => {
    // hook position 写入
    window.__posSets = [];
    const proto = CSSStyleDeclaration.prototype;
    const origSet = proto.setProperty;
    proto.setProperty = function (p, v, pri) {
      if (p === 'position' && (v === 'relative' || v === 'fixed')) {
        window.__posSets.push({ how: 'setProperty', v, css: this.cssText.slice(0, 90), stack: new Error().stack.split('\n').slice(1, 12).join('\n') });
      }
      return origSet.call(this, p, v, pri);
    };
    const d = Object.getOwnPropertyDescriptor(proto, 'position');
    if (d && d.set) {
      Object.defineProperty(proto, 'position', {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set(v) {
          if (v === 'relative' || v === 'fixed') {
            window.__posSets.push({ how: 'prop', v, css: this.cssText.slice(0, 90), stack: new Error().stack.split('\n').slice(1, 12).join('\n') });
          }
          return d.set.call(this, v);
        },
      });
    }

    window.app.graph.clear();
    const n = window.LiteGraph.createNode('GGWebAIReverseText');
    window.app.graph.add(n);
    n.pos = [120, 60];
    window.__target = n;
    await new Promise((r) => setTimeout(r, 1500));
  });

  const setZoom = async (z) => {
    await page.evaluate(async (zz) => {
      const c = window.app.canvas;
      c.ds.scale = zz;
      c.ds.offset = [0, 0];
      c.setDirty(true, true);
      window.__posSets.length = 0;
      await new Promise((r) => setTimeout(r, 700));
      // 触发一次重绘
      c.draw(true, true);
      await new Promise((r) => setTimeout(r, 700));
    }, z);
  };

  const probe = async () =>
    page.evaluate(() => {
      const r = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const iso = document.querySelector('div[data-testid="dom-widgets"]');
      return {
        scale: window.app.canvas.ds.scale,
        isolate: r(iso),
        ws: [...document.querySelectorAll('div.dom-widget')].map((el) => {
          const ta = el.querySelector('textarea');
          return {
            txt: ta ? (ta.value || '').replace(/\n/g, '\\n').slice(0, 8) : null,
            pos: getComputedStyle(el).position,
            style: (el.getAttribute('style') || '').replace(/\s+/g, ' ').slice(0, 100),
            rect: r(el),
          };
        }),
        posSets: window.__posSets.slice(0, 3),
      };
    });

  const out = {};
  await setZoom(1);
  out.scale1 = await probe();
  await page.screenshot({ path: `${SHOT}/rt7_scale1.png`, clip: { x: 0, y: 0, width: 1000, height: 900 } });

  await setZoom(0.9);
  out.scale09 = await probe();
  await page.screenshot({ path: `${SHOT}/rt7_scale09.png`, clip: { x: 0, y: 0, width: 1000, height: 900 } });

  // 强制 fixed
  await page.evaluate(async () => {
    const s = document.createElement('style');
    s.id = 'fix-probe';
    s.textContent = `div[data-testid="dom-widgets"]>div{position:fixed!important;}`;
    document.head.appendChild(s);
    await new Promise((r) => setTimeout(r, 800));
  });
  out.scale09_fixed = await probe();
  await page.screenshot({ path: `${SHOT}/rt7_scale09_fixed.png`, clip: { x: 0, y: 0, width: 1000, height: 900 } });

  console.log(JSON.stringify(out, null, 2));
  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
