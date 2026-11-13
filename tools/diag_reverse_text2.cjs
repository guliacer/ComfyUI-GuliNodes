// 诊断 2：看多行 textarea 的 DOM 实际尺寸与定位
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    await page.goto('http://127.0.0.1:8188/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 90000 });
    await page.waitForTimeout(2500);

    const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

    const out = await page.evaluate(async () => {
        const app = window.app;
        const L = window.LiteGraph;
        app.graph.clear();
        const node = L.createNode('GGWebAIReverseText');
        app.graph.add(node);
        node.pos = [200, 120];
        await new Promise((r) => setTimeout(r, 1200));

        const rows = (node.widgets ?? []).map((w) => {
            const el = w.element || w.inputEl || null;
            const r = el?.getBoundingClientRect?.() ?? null;
            const cs = el ? getComputedStyle(el) : null;
            return {
                name: w.name,
                type: w.type,
                y: w.y,
                h: w.computedHeight,
                hasEl: !!el,
                tag: el?.tagName ?? null,
                rect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
                css: cs ? {
                    height: cs.height,
                    overflow: cs.overflow,
                    position: cs.position,
                    zIndex: cs.zIndex,
                    lineHeight: cs.lineHeight,
                    padding: cs.padding,
                    marginTop: cs.marginTop,
                } : null,
                cls: el?.className ?? null,
                scrollH: el?.scrollHeight ?? null,
                clientH: el?.clientHeight ?? null,
                placeholder: el?.placeholder ?? null,
            };
        });

        // 节点 DOM 根
        const nodeEl = document.querySelector(`[data-node-id="${node.id}"]`)
            || [...document.querySelectorAll('.lg-node')].find((n) => n.textContent?.includes('文本反推'))
            || null;
        const nodeRect = nodeEl?.getBoundingClientRect?.() ?? null;

        return {
            nodeId: node.id,
            size: Array.from(node.size ?? []),
            nodeRect: nodeRect ? [Math.round(nodeRect.x), Math.round(nodeRect.y), Math.round(nodeRect.width), Math.round(nodeRect.height)] : null,
            nodeElClass: nodeEl?.className ?? null,
            nodeElHTML: nodeEl ? nodeEl.querySelector('.lg-node-widgets, div')?.innerHTML?.slice(0, 600) : null,
            widgets: rows,
        };
    });

    await page.screenshot({ path: 'C:/Users/Admin/gg_topbar/diag2.png' });
    await page.evaluate(async (d) => { try { await window.app.loadGraphData(JSON.parse(d)); } catch (e) {} }, backup);
    console.log(JSON.stringify(out, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
