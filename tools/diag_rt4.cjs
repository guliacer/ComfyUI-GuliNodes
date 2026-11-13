// 诊断：dump GGWebAIReverseText 节点 DOM 完整子树，判断多重文本框重叠根因
const { chromium } = require('playwright');

(async () => {
  const ctx = await chromium.launchPersistentContext('C:/Users/Admin/AppData/Local/Temp/gg-diag-rt4b', {
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1600, height: 1200 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.app && window.app.graph, null, { timeout: 90000 });
  await page.waitForTimeout(2500);

  const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

  const out = await page.evaluate(async () => {
    const app = window.app;
    const node = window.LiteGraph.createNode('GGWebAIReverseText');
    app.graph.add(node);
    node.pos = [80, 80];
    await new Promise((r) => setTimeout(r, 1200));
    app.canvas.setDirty(true, true);
    await new Promise((r) => setTimeout(r, 800));

    const res = { widgets: [], isolates: [], subtree: null };

    res.widgets = node.widgets.map((w) => {
      const el = w.element || w.inputEl;
      const r = el ? el.getBoundingClientRect() : null;
      const dw = el ? el.closest('.dom-widget') : null;
      return {
        name: w.name,
        type: w.type,
        y: Math.round(w.y ?? -1),
        computedHeight: w.computedHeight,
        _ggCol: w._ggCol,
        hidden: !!w.hidden,
        elCls: el ? (el.className || '').toString().slice(0, 50) : null,
        domWidgetStyle: dw ? (dw.getAttribute('style') || '').slice(0, 180) : null,
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        scrollH: el && el.scrollHeight ? el.scrollHeight : null,
        clientH: el && el.clientHeight ? el.clientHeight : null,
      };
    });

    const iso = [...document.querySelectorAll('div.isolate')];
    res.isolates = iso.map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        i,
        style: (el.getAttribute('style') || '').slice(0, 140),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        children: [...el.children].map((c) => {
          const cr = c.getBoundingClientRect();
          const ta = c.querySelector('textarea');
          return {
            tag: c.tagName,
            cls: (c.className || '').toString().slice(0, 70),
            style: (c.getAttribute('style') || '').slice(0, 150),
            rect: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
            taVal: ta ? (ta.value || '').replace(/\n/g, '\\n').slice(0, 12) : null,
          };
        }),
      };
    });

    // 从节点内第一个 textarea 向上爬 7 层
    const ta0 = [...document.querySelectorAll('textarea.comfy-multiline-input')][0];
    if (ta0) {
      const chain = [];
      let cur = ta0;
      for (let lv = 0; lv < 7 && cur; lv++) {
        const r = cur.getBoundingClientRect();
        const cs = getComputedStyle(cur);
        chain.push({
          lv,
          tag: cur.tagName,
          cls: (cur.className || '').toString().slice(0, 70),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          pos: cs.position,
          top: cs.top,
          left: cs.left,
          transform: cs.transform === 'none' ? null : cs.transform,
          childCount: cur.children.length,
        });
        cur = cur.parentElement;
      }
      res.subtree = chain;
    }

    res.nodeSize = { w: node.size[0], h: node.size[1] };
    res.canvas = { scale: app.canvas?.ds?.scale, offset: app.canvas?.ds?.offset };
    return res;
  });

  console.log(JSON.stringify(out, null, 2));
  if (errs.length) console.log('PAGEERROR:', errs.join('\n'));

  await page.screenshot({
    path: 'W:/AIphotograph/ComfyUI_windows_portable/ComfyUI/custom_nodes/ComfyUI-GuliNodes/tools/out/diag_rt4.png',
    clip: { x: 0, y: 0, width: 1200, height: 1100 },
  });

  await page.evaluate((b) => window.app.loadGraphData(JSON.parse(b)), backup);
  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
