const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const p = await b.newPage({ viewport: { width: 1600, height: 1200 } });
  await p.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 90000 });
  await p.waitForTimeout(2500);
  const backup = await p.evaluate(() => JSON.stringify(window.app.graph.serialize()));
  const out = await p.evaluate(async () => {
    const app = window.app, L = window.LiteGraph;
    app.graph.clear();
    const node = L.createNode('GGWebAIReverseText');
    app.graph.add(node); node.pos = [200, 120];
    await new Promise(r => setTimeout(r, 1500));
    const w = node.widgets.find(x => x.name === '提取规则');
    const ta = w.element || w.inputEl;
    const chain = [];
    let el = ta;
    for (let i = 0; i < 6 && el; i++) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      chain.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 70),
        h: Math.round(r.height), y: Math.round(r.y),
        cssH: cs.height, pad: cs.padding, mar: cs.margin, disp: cs.display, pos: cs.position });
      el = el.parentElement;
    }
    return { widgetY: w.y, widgetH: w.computedHeight, chain,
      canvas: { scale: app.canvas?.ds?.scale, offset: app.canvas?.ds?.offset } };
  });
  await p.evaluate(async d => { try { await app.loadGraphData(JSON.parse(d)); } catch(e){} }, backup);
  console.log(JSON.stringify(out, null, 2));
  await b.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
