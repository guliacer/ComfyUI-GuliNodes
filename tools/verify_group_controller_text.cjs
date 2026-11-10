// GG 单组控制 文本重叠 / 主题可读性回归：
//   端口标签压成空格、自绘文字让开端口圆点、两行文字分行、浅色主题不再用 #ddd 亮字。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_group_controller_text.cjs
// 可用 GG_COMFY_URL 覆盖默认地址（本机 ComfyUI 端口变更时）。
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NODE_TX = 120; // 固定造景：pos=[60,90] × deviceScaleFactor 2，scale=1、offset=[0,0]
const NODE_TY = 180;
const ENV_NOISE = [
    /Error calling extension 'gulips[.]bridge' method 'setup'/,
    /report-only Content Security Policy/,
    /Framing .* violates the following report-only/,
    /upgrade-insecure-requests' is ignored when delivered in a report-only policy/,
    /Failed to load resource/,
    // 外部扩展 ComfyUI-GuliPS 的动态 chunk 预加载失败：与被测模块无关的环境噪音。
    /\[vite:preloadError\].*ComfyUI-GuliPS/,
];

(async () => {
    // 本机 ComfyUI 端口会变（8188 / 8402 都出现过），逐个探活；也可用 GG_COMFY_URL 指定。
    const candidates = [
        process.env.GG_COMFY_URL,
        'http://127.0.0.1:8188/',
        'http://127.0.0.1:8402/',
    ].filter(Boolean);
    let URL = candidates[0];
    for (const candidate of candidates) {
        try {
            const res = await fetch(candidate, { signal: AbortSignal.timeout(2000) });
            if (res.ok) { URL = candidate; break; }
        } catch (_) { /* 端口没开就试下一个 */ }
    }
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (!ENV_NOISE.some((re) => re.test(text))) errors.push('console: ' + text);
    });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
    await page.waitForTimeout(1500);

    const report = await page.evaluate(async ({ NODE_TX, NODE_TY }) => {
        const app = window.app;
        const backup = app.graph.serialize();
        const origFill = CanvasRenderingContext2D.prototype.fillText;
        const records = [];
        CanvasRenderingContext2D.prototype.fillText = function (t, x, y, ...rest) {
            try {
                const m = this.getTransform?.();
                records.push({
                    t: String(t), x: Math.round(x), y: Math.round(y),
                    tx: m ? Math.round(m.e) : null, ty: m ? Math.round(m.f) : null,
                    fill: String(this.fillStyle),
                });
            } catch (_) { /* 探针不影响绘制 */ }
            return origFill.call(this, t, x, y, ...rest);
        };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        try {
            app.graph.clear();
            app.canvas.ds.scale = 1;
            app.canvas.ds.offset = [0, 0];
            const G = window.LiteGraph?.LGraphGroup;
            const group = G ? new G() : {};
            group.title = '亮度调整';
            group.color = '#3f789e';
            group._bounding = [500, 400, 320, 220];
            group._children = new Set();
            group.nodes = [];
            group.graph = app.graph;
            if (!G) {
                group.serialize = () => ({});
                group.configure = () => {};
                group.recomputeInsideNodes = () => {};
            }
            app.graph._groups.push(group);
            const dummy = window.LiteGraph.createNode('GGGroupControllerM');
            app.graph.add(dummy);
            dummy.pos = [520, 420]; dummy.size = [120, 100]; dummy.mode = 4;
            const node = window.LiteGraph.createNode('GGGroupControllerS');
            app.graph.add(node);
            node.pos = [60, 90];
            node.properties.selectedGroup = '亮度调整';
            await sleep(600);

            const capture = async (theme, bodyColor) => {
                document.body.style.backgroundColor = bodyColor;
                // detectHostTheme 自带 1 秒缓存，等过缓存窗口再取绘制结果。
                await sleep(1200);
                records.length = 0;
                app.canvas.setDirty?.(true, true);
                app.graph.setDirtyCanvas?.(true, true);
                await sleep(320);
                const texts = records.filter((r) => r.tx === NODE_TX && r.ty === NODE_TY && r.t);
                // 一次 setDirty 可能连画两帧，按「文本+坐标+颜色」去重，
                // 否则行数断言会把同一行算成两遍（探针假 FAIL）。
                const unique = [...new Map(texts.map((r) => [
                    `${r.t}|${r.x}|${r.y}|${r.fill}`, r,
                ])).values()];
                const widget = node.widgets.find((w) => w.name === '启用');
                const input = node.inputs.find((s) => s.widget?.name === '启用');
                return {
                    theme,
                    texts: unique.map((r) => ({ t: r.t, x: r.x, y: r.y, fill: r.fill })),
                    widgetLabel: widget?.label ?? null,
                    widgetHidden: !!widget?.hidden,
                    inputLabel: input?.label ?? null,
                    inputName: input?.name ?? null,
                    inputPos: input?.pos ? [...input.pos] : null,
                    size: [Math.round(node.size[0]), Math.round(node.size[1])],
                    hitDropdown: node._hitDropdown ? { ...node._hitDropdown } : null,
                    hitToggle: node._hitToggleS ? { ...node._hitToggleS } : null,
                };
            };

            const light = await capture('light', '#f8fafc');
            const dark = await capture('dark', '#101014');
            return { light, dark, backupNodes: backup.nodes?.length ?? 0 };
        } finally {
            CanvasRenderingContext2D.prototype.fillText = origFill;
            document.body.style.backgroundColor = '';
            try { await app.loadGraphData(backup); } catch (_) { /* 交回页面 */ }
        }
    }, { NODE_TX, NODE_TY });

    const findText = (snap, text) => snap.texts.find((t) => t.t === text) ?? null;
    const row1 = (snap) => snap.texts.filter((t) => t.y <= 30 && t.t !== 'GG 单组控制');
    const row2 = (snap) => snap.texts.filter((t) => t.y >= 40);
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

    const L = report.light;
    const D = report.dark;
    check('端口与控件标签都是空格（不再画「启用」二字）',
        L.widgetLabel === ' ' && L.inputLabel === ' ',
        `widget=${JSON.stringify(L.widgetLabel)} input=${JSON.stringify(L.inputLabel)}`);
    check('端口 name 仍是「启用」，连线与读档不受影响',
        L.inputName === '启用' && L.widgetHidden === true,
        `name=${JSON.stringify(L.inputName)} hidden=${L.widgetHidden}`);
    check('输入端口仍固定到启停按钮行',
        Array.isArray(L.inputPos) && L.inputPos[1] === 58,
        JSON.stringify(L.inputPos));

    const arrowL = findText(L, '▼');
    const titleL1 = L.texts.find((t) => t.t === '亮度调整' && t.y <= 30);
    const titleCount = L.texts.filter((t) => t.t === '亮度调整').length;
    const row2Any = L.texts.find((t) => t.y >= 40);
    const countL = findText(L, '1');
    const statusL = findText(L, '已跳过');
    check('第一行「▼」让开左侧端口圆点（x>=30）',
        !!arrowL && arrowL.x >= 30, JSON.stringify(arrowL));
    check('第一行组名在 ▼ 右侧且不重叠（x>=46，间距>=12）',
        !!arrowL && !!titleL1 && titleL1.x >= 46 && titleL1.x - arrowL.x >= 12,
        JSON.stringify({ arrowL, titleL1 }));
    check('组名只出现一次（第二行不再重复画组名）',
        titleCount === 1, `组名条数=${titleCount} 全部文本=${JSON.stringify(L.texts)}`);
    check('两行文字分属不同行（纵向间距>=28，不重叠）',
        !!titleL1 && !!row2Any && row2Any.y - titleL1.y >= 28,
        JSON.stringify({ y1: titleL1?.y, y2: row2Any?.y }));
    check('第一行只有一组文字（无端口标签挤进来）',
        row1(L).length === 2, JSON.stringify(row1(L)));
    check('第二行只保留数量与状态两处文字',
        row2(L).length === 2 && !!countL && !!statusL, JSON.stringify(row2(L)));
    check('数量徽标在状态按钮左侧且不重叠',
        !!countL && !!statusL && statusL.x - countL.x >= 40,
        JSON.stringify({ countL, statusL }));

    check('浅色主题第一行组名改用深色字（不是 #ddd）',
        !!titleL1 && titleL1.fill === '#1f2937', JSON.stringify(titleL1));
    check('浅色主题占位箭头改用中深灰（不是 #888）',
        !!arrowL && arrowL.fill === '#64748b', JSON.stringify(arrowL));
    const titleD = D.texts.find((t) => t.t === '亮度调整' && t.y <= 30);
    // canvas 会把 #ddd 规范化成 #dddddd，两种写法都算同一套深色配色。
    check('深色主题仍用亮字 #ddd（主题切换双向生效）',
        !!titleD && (titleD.fill === '#ddd' || titleD.fill === '#dddddd'), JSON.stringify(titleD));

    check('节点尺寸不变 [270,82]',
        L.size[0] === 270 && L.size[1] === 82, JSON.stringify(L.size));
    check('下拉框与按钮命中区不变',
        !!L.hitDropdown && L.hitDropdown.x === 10 && L.hitDropdown.w === 250
        && !!L.hitToggle && L.hitToggle.w === 72,
        JSON.stringify({ dd: L.hitDropdown, tg: L.hitToggle }));
    check('无页面异常', errors.length === 0, JSON.stringify(errors));

    // 反向破坏验证：把关键值改回旧版，新增断言必须真的 FAIL，避免整批空跑。
    const broken = JSON.parse(JSON.stringify(report));
    broken.light.widgetLabel = '启用';
    broken.light.inputLabel = '启用';
    broken.light.inputName = '启用开关';
    broken.light.inputPos = [10, 22];
    for (const t of broken.light.texts) {
        if (t.t === '▼') { t.x = 18; t.fill = '#888'; }
        if (t.t === '亮度调整' && t.y <= 30) { t.x = 34; t.fill = '#ddd'; }
        if (t.t === '1') { t.x = 260; t.y = 24; }
        if (t.t === '已跳过') { t.y = 24; }
    }
    // 把旧版「第二行重复组名」与「端口标签」加回来，破坏去重与行数断言。
    broken.light.texts.push({ t: '亮度调整', x: 14, y: 24, fill: '#777777' });
    broken.light.texts.push({ t: '启用', x: 24, y: 22, fill: '#888' });
    // 第二行整体清空：被测版本不同时第二行条目数也不同，只挪固定两条会在旧版
    // （多一条重复组名）下残留 y>=40 的文本，让「两行文字分属不同行」破坏后仍 PASS，
    // 反向验证自己反而假 FAIL。这里按 y 统一搬走，与被测版本无关。
    for (const t of broken.light.texts) {
        if (t.y >= 40) t.y = 24;
    }
    broken.dark.texts.forEach((t) => { if (t.t === '亮度调整' && t.y <= 30) t.fill = '#1f2937'; });
    const brokenArrow = broken.light.texts.find((t) => t.t === '▼');
    const brokenT1 = broken.light.texts.find((t) => t.t === '亮度调整' && t.y <= 30);
    const brokenTitleCount = broken.light.texts.filter((t) => t.t === '亮度调整').length;
    const brokenRow2Any = broken.light.texts.find((t) => t.y >= 40);
    const brokenCount = broken.light.texts.find((t) => t.t === '1');
    const brokenStatus = broken.light.texts.find((t) => t.t === '已跳过');
    const brokenTitleD = broken.dark.texts.find((t) => t.t === '亮度调整' && t.y <= 30);
    const negative = [
        ['端口与控件标签都是空格（不再画「启用」二字）', broken.light.widgetLabel === ' ' && broken.light.inputLabel === ' '],
        ['端口 name 仍是「启用」，连线与读档不受影响', broken.light.inputName === '启用' && broken.light.widgetHidden === true],
        ['输入端口仍固定到启停按钮行', Array.isArray(broken.light.inputPos) && broken.light.inputPos[1] === 58],
        ['第一行「▼」让开左侧端口圆点（x>=30）', !!brokenArrow && brokenArrow.x >= 30],
        ['第一行组名在 ▼ 右侧且不重叠（x>=46，间距>=12）', !!brokenArrow && !!brokenT1 && brokenT1.x >= 46 && brokenT1.x - brokenArrow.x >= 12],
        ['组名只出现一次（第二行不再重复画组名）', brokenTitleCount === 1],
        ['两行文字分属不同行（纵向间距>=28，不重叠）', !!brokenT1 && !!brokenRow2Any && brokenRow2Any.y - brokenT1.y >= 28],
        ['第一行只有一组文字（无端口标签挤进来）', broken.light.texts.filter((t) => t.y <= 30 && t.t !== 'GG 单组控制').length === 2],
        ['第二行只保留数量与状态两处文字', broken.light.texts.filter((t) => t.y >= 40).length === 2 && !!brokenCount && !!brokenStatus],
        ['数量徽标在状态按钮左侧且不重叠', !!brokenCount && !!brokenStatus && brokenStatus.x - brokenCount.x >= 40],
        ['浅色主题第一行组名改用深色字（不是 #ddd）', !!brokenT1 && brokenT1.fill === '#1f2937'],
        ['浅色主题占位箭头改用中深灰（不是 #888）', !!brokenArrow && brokenArrow.fill === '#64748b'],
        ['深色主题仍用亮字 #ddd（主题切换双向生效）', !!brokenTitleD && brokenTitleD.fill === '#ddd'],
    ];
    const missed = negative.filter(([, ok]) => ok).map(([name]) => name);
    checks.push({
        name: `反向破坏验证：${negative.length} 条断言全部能 FAIL`,
        ok: missed.length === 0,
        detail: `破坏后仍 PASS 的断言=${JSON.stringify(missed)}`,
    });

    const passed = checks.filter((c) => c.ok).length;
    for (const c of checks) {
        console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  << ' + c.detail}`);
    }
    console.log(`\n${passed}/${checks.length} 通过`);
    await browser.close();
    process.exit(passed === checks.length ? 0 : 1);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
