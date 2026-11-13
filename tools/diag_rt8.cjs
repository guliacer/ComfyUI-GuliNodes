// 诊断：addInitScript 提前 hook，抓出打开老工作流时 position 变 relative 的调用栈
const { chromium } = require('playwright');

const INIT = () => {
  window.__posSets = [];
  const proto = CSSStyleDeclaration.prototype;
  const origSet = proto.setProperty;
  proto.setProperty = function (p, v, pri) {
    if (p === 'position' && (v === 'relative' || v === 'fixed' || v === 'absolute')) {
      window.__posSets.push({ how: 'setProperty', v, css: (this.cssText || '').slice(0, 80), stack: new Error().stack });
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
        if (v === 'relative' || v === 'fixed' || v === 'absolute') {
          window.__posSets.push({ how: 'prop', v, css: (this.cssText || '').slice(0, 80), stack: new Error().stack });
        }
        return d.set.call(this, v);
      },
    });
  }
};

(async () => {
  const ctx = await chromium.launchPersistentContext('C:/Users/Admin/AppData/Local/Temp/gg-diag-rt8', {
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1600, height: 1200 },
    args: ['--no-proxy-server'],
  });
  await ctx.addInitScript(INIT);
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(5000);

  const out = await page.evaluate(() => {
    const rel = [...document.querySelectorAll('div.dom-widget')].filter(
      (el) => getComputedStyle(el).position === 'relative'
    );
    const relSets = window.__posSets.filter((s) => s.v === 'relative' && /dom-widget|transform-origin/.test(s.css));
    return {
      total: window.__posSets.length,
      relCount: rel.length,
      relSamples: rel.slice(0, 3).map((el) => (el.getAttribute('style') || '').slice(0, 120)),
      relSetCount: relSets.length,
      relStacks: relSets.slice(0, 3).map((s) => ({ css: s.css, stack: s.stack.split('\n').slice(0, 14).join('\n') })),
      fixedCount: [...document.querySelectorAll('div.dom-widget')].filter((el) => getComputedStyle(el).position === 'fixed').length,
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
