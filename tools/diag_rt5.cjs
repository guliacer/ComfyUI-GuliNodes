// 诊断：捕获是谁把 dom-widget 的 position 改成 relative
const { chromium } = require('playwright');

(async () => {
  const ctx = await chromium.launchPersistentContext('C:/Users/Admin/AppData/Local/Temp/gg-diag-rt5', {
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1600, height: 1200 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(3000);

  // 装监听：任何 div.dom-widget 的 style 里出现 relative 时记录堆栈
  await page.evaluate(() => {
    window.__traps = [];
    const seen = new WeakSet();
    const check = (el) => {
      if (!el || el.nodeType !== 1) return;
      if (!el.classList || !el.classList.contains('dom-widget')) return;
      const s = el.getAttribute('style') || '';
      if (!s.includes('relative')) return;
      if (seen.has(el)) return;
      seen.add(el);
      const err = new Error('TRAP');
      window.__traps.push({
        style: s.slice(0, 240),
        stack: (err.stack || '').split('\n').slice(1, 16).join('\n'),
      });
    };
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.attributeName === 'style') check(m.target);
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1) {
              check(n);
              if (n.querySelectorAll) n.querySelectorAll('div.dom-widget').forEach(check);
            }
          }
        }
      }
    });
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'], childList: true });
    window.__mo = mo;
    // 已有的也查
    document.querySelectorAll('div.dom-widget').forEach(check);
  });

  const out = await page.evaluate(async () => {
    const app = window.app;
    const node = window.LiteGraph.createNode('GGWebAIReverseText');
    app.graph.add(node);
    node.pos = [80, 80];
    await new Promise((r) => setTimeout(r, 1800));
    return { traps: window.__traps.slice(0, 6) };
  });

  console.log(JSON.stringify(out, null, 2));
  if (logs.length) console.log('--- console ---\n' + logs.slice(0, 20).join('\n'));
  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
