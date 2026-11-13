// 诊断 GGWebAIReverseText 节点参数行重叠
// 用法：NODE_PATH=... node tools/diag_reverse_text.cjs
const { chromium } = require('playwright');

const URL = 'http://127.0.0.1:8188/';

(async () => {
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 90000 });
    await page.waitForTimeout(2500);

    // 记下当前画布，收尾要装回去
    const backup = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

    const info = await page.evaluate(async () => {
        const app = window.app;
        const L = window.LiteGraph;

        // 主题信息：新版前端用设置项控制配色
        const themeKeys = [];
        try {
            const s = app.ui?.settings;
            if (s) {
                for (const k of Object.keys(s.settings ?? {})) {
                    if (/color|theme|palette|dark|light/i.test(k)) themeKeys.push(k);
                }
            }
        } catch (e) { /* ignore */ }

        app.graph.clear();
        const node = L.createNode('GGWebAIReverseText');
        if (!node) return { error: 'createNode 失败' };
        app.graph.add(node);
        node.pos = [100, 100];
        await new Promise((r) => setTimeout(r, 900));
        if (typeof node.computeSize === 'function') {
            const [w, h] = node.computeSize();
            node.setSize([w, h]);
        }
        await new Promise((r) => setTimeout(r, 600));

        const rows = (node.widgets ?? []).map((w, i) => {
            let cs = null;
            try { cs = w.computeSize?.(node.size?.[0] ?? 400) ?? null; } catch (e) { cs = 'throw'; }
            return {
                i,
                name: w.name,
                label: w.label,
                displayName: w.displayName,
                type: w.type,
                y: w.y,
                last_y: w.last_y,
                width: w.width,
                computedHeight: w.computedHeight,
                computeSize: cs,
                col: w._ggCol ? { x: Math.round(w._ggCol.x), w: Math.round(w._ggCol.w) } : null,
                hasElement: !!w.element,
                hasInputEl: !!w.inputEl,
                multiline: w.options?.multiline === true,
                hidden: w.hidden === true,
                isDOM: !!(w.options?.dom || w.dom),
            };
        });

        return {
            comfyClass: node.comfyClass,
            type: node.type,
            size: Array.from(node.size ?? []),
            minSize: node.minSize ? Array.from(node.minSize) : null,
            hasRowState: !!node._ggRowLayout,
            rowLayout: node._ggRowLayout
                ? { height: node._ggRowLayout.height, rows: (node._ggRowLayout.rows ?? []).length }
                : null,
            themeKeys,
            bodyClass: document.body.className,
            widgets: rows,
        };
    });

    await page.screenshot({ path: 'C:/Users/Admin/gg_topbar/diag_rt_dark.png', fullPage: false });

    // 切浅色再看一次
    const light = await page.evaluate(async () => {
        const app = window.app;
        const tries = [];
        const s = app.ui?.settings;
        for (const key of ['Comfy.ColorPalette', 'Comfy.Theme', 'LiteGraph.Canvas.Theme', 'Comfy.Style']) {
            try {
                if (s?.getSettingValue && s.settings?.[key] !== undefined) {
                    s.setSettingValue(key, 'light');
                    tries.push([key, 'ok']);
                }
            } catch (e) { tries.push([key, String(e).slice(0, 60)]); }
        }
        document.body.classList.add('theme-light');
        document.documentElement.setAttribute('data-theme', 'light');
        await new Promise((r) => setTimeout(r, 700));
        return { tries, bodyClass: document.body.className };
    });
    await page.screenshot({ path: 'C:/Users/Admin/gg_topbar/diag_rt_light.png', fullPage: false });

    // 装回原画布
    await page.evaluate(async (data) => {
        try { await window.app.loadGraphData(JSON.parse(data)); } catch (e) { /* ignore */ }
    }, backup);

    console.log(JSON.stringify({ info, light, errors }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
