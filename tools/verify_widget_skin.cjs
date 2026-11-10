// 画布控件「皮肤层」回归：
//   ① 相邻两列的胶囊形状不重叠，中间留足 colGap 空白（绘制区间 = 列矩形内缩 SIDE）；
//   ② 每个胶囊都带投影（fill 时 shadowBlur > 0 且 shadowColor 非透明）；
//   ③ 参数名「提示区」有独立底色块（labelBg 填充），与右侧实际取值区分；
//   ④ 皮肤同步到所有节点：没登记行布局的 GG 节点 / 第三方节点也吃到同一套；
//   ⑤ 换肤不动尺寸、不动命中区、不误伤 DOM 面板与多行文本；
//   ⑥ 控件底色跟随节点自定义颜色（深色节点深底浅字、浅色节点浅底深字）。
// 运行：NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
//       node tools/verify_widget_skin.cjs
//
// 背景：曾经 drawSkinned 直接拿整个列矩形 roundRect，列矩形两侧各多带 SIDE=15 的
// 内衬，相邻两格必叠 (SIDE*2 - colGap) = 22px；而命中区一直按内缩后的形状算，
// 绘制与命中对不上。后来又发现这套皮肤只挂在行布局的 drawWidgets 补丁里，
// 57 个 GG 节点有 20 个没登记、完全吃不到。这里用真机画布逐项量，别靠肉眼看截图。

const { chromium } = require("playwright-core");

const SIDE = 15;
const COL_GAP = 8;
// 已登记行布局、用来量两列间距的
const LAYOUT_CLASSES = ["GGFaceSkinSmoothing", "GG色彩校正", "GGImageStyleReference"];
// 没登记行布局的 GG 节点 + 第三方节点，验证「同步到所有节点」
const SKIN_CLASSES = [
    "GGImageComparer4",
    "GGWebAIReverseText",
    "GG提示词优化",
    "GGCLIPText",
    "GGPromptOptimizer",
    "KSampler",
    "EmptySD3LatentImage",
    "CLIPTextEncode",
];

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
    if (ok) {
        passed += 1;
        console.log(`PASS  ${name}`);
    } else {
        failed += 1;
        console.log(`FAIL  ${name}  ${detail}`);
    }
}

(async () => {
    const browser = await chromium.launch({
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error.message)));

    // 在任何页面脚本之前挂钩 canvas，记录每次 fill 的投影与填充色。
    await page.addInitScript(() => {
        window.__ggSkinFills = [];
        window.__ggSkinTexts = [];
        const proto = CanvasRenderingContext2D.prototype;
        const originalText = proto.fillText;
        proto.fillText = function (...args) {
            try {
                window.__ggSkinTexts.push(String(this.fillStyle || "").toLowerCase());
            } catch {
                // 探针本身不能影响绘制
            }
            return originalText.apply(this, args);
        };
        const original = proto.fill;
        proto.fill = function (...args) {
            try {
                const blur = Number(this.shadowBlur) || 0;
                const shadow = String(this.shadowColor || "");
                const opaqueShadow = shadow !== "" && shadow !== "transparent"
                    && !/,\s*0\)$/.test(shadow);
                window.__ggSkinFills.push({
                    blur,
                    shadowDrop: blur > 0 && opaqueShadow,
                    fillStyle: String(this.fillStyle || "").toLowerCase(),
                });
            } catch {
                // 探针本身不能影响绘制
            }
            return original.apply(this, args);
        };
    });

    await page.goto("http://127.0.0.1:8188/?gg=" + Date.now(), { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForFunction(() => window.app?.canvas?.ds, null, { timeout: 120000 });
    await page.waitForTimeout(1300);

    // Full-coverage regression explicitly enables all; installation defaults stay own.
    const skinScopeBefore = await page.evaluate(() => window.app.ui.settings.getSettingValue("GuliNodes.widgetSkin.scope", "own"));
    await page.evaluate(() => window.app.ui.settings.setSettingValue("GuliNodes.widgetSkin.scope", "all"));

    // 会话保护：清空画布核对前先存档，收尾原样装回。
    const saved = await page.evaluate(() => window.app.graph.serialize());

    const report = await page.evaluate(async ({ layoutClasses, skinClasses }) => {
        const app = window.app;
        app.graph.clear();
        const all = [...layoutClasses, ...skinClasses];
        const built = [];
        for (let index = 0; index < all.length; index += 1) {
            let node = null;
            try {
                node = window.LiteGraph.createNode(all[index]);
            } catch {
                node = null;
            }
            if (!node) continue;
            app.graph.add(node);
            // 必须留在视口内：LiteGraph 会 cull 视口外节点，那样 widget.last_y
            // 不会被 drawWidgets 写入，官方 getWidgetOnPos 会返回 undefined（假失败）。
            node.pos = [40 + (index % 4) * 330, 40 + Math.floor(index / 4) * 280];
            built.push({ wanted: all[index], node });
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const sizeBefore = new Map(built.map(({ node }) => [
            String(node.type || node.comfyClass || ""),
            [Math.round(node.size?.[0] || 0), Math.round(node.size?.[1] || 0)],
        ]));

        window.__ggSkinFills = [];
        app.canvas.draw(true, true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const fills = window.__ggSkinFills.slice();

        const data = built.map(({ wanted, node }) => {
            const type = String(node.type || node.comfyClass || "");
            const byRow = new Map();
            for (const widget of node.widgets || []) {
                if (widget.hidden || !widget._ggCol) continue;
                const key = Math.round(widget.y || 0);
                if (!byRow.has(key)) byRow.set(key, []);
                byRow.get(key).push({
                    name: widget.name,
                    col: { x: widget._ggCol.x, w: widget._ggCol.w },
                });
            }
            const visible = (node.widgets || []).filter((widget) => !widget.hidden);
            return {
                wanted,
                type,
                layout: !!node._ggRowLayout,
                skinApplied: !!node._ggWidgetSkinApplied,
                visible: visible.length,
                patched: (node.widgets || []).filter((widget) => !!widget._ggWidgetSkinPatched).length,
                domPatched: visible.filter((widget) =>
                    (widget.element || widget.inputEl) && widget._ggWidgetSkinPatched).length,
                sizeBefore: sizeBefore.get(type),
                sizeAfter: [Math.round(node.size?.[0] || 0), Math.round(node.size?.[1] || 0)],
                rows: [...byRow.values()],
            };
        });

        // 官方命中区没被换肤影响：KSampler 的 sampler_name 中间点应命中它自己。
        const sampler = built.find(({ wanted }) => wanted === "KSampler")?.node;
        let hitName = null;
        if (sampler) {
            const widget = (sampler.widgets || []).find((item) => item.name === "sampler_name");
            if (widget) {
                const x = sampler.pos[0] + sampler.size[0] * 0.55;
                const y = sampler.pos[1] + widget.y + 10;
                hitName = sampler.getWidgetOnPos(x, y)?.name ?? null;
            }
        }
        return { data, fills, hitName };
    }, { layoutClasses: LAYOUT_CLASSES, skinClasses: SKIN_CLASSES });

    const byWanted = new Map(report.data.map((item) => [item.wanted, item]));

    let overlapCount = 0;
    let multiRowCount = 0;
    const worst = [];
    for (const cls of LAYOUT_CLASSES) {
        const node = byWanted.get(cls);
        for (const row of node?.rows ?? []) {
            if (row.length < 2) continue;
            multiRowCount += 1;
            const shapes = row.map(({ name, col }) => ({
                name,
                left: col.x + SIDE,
                right: col.x + col.w - SIDE,
            }));
            for (let i = 0; i + 1 < shapes.length; i += 1) {
                const gap = shapes[i + 1].left - shapes[i].right;
                if (gap < COL_GAP - 1) {
                    overlapCount += 1;
                    worst.push(`${cls}/${shapes[i].name}→${shapes[i + 1].name} gap=${gap}`);
                }
            }
        }
    }

    const shadowDrops = report.fills.filter((fill) => fill.shadowDrop).length;
    // labelBg 取 --gg-btn：浅色 #eef2f8 / 深色 #283244。
    const chips = report.fills.filter((fill) => /eef2f8|283244/.test(fill.fillStyle)).length;

    const skinNodes = SKIN_CLASSES.map((cls) => byWanted.get(cls)).filter(Boolean);
    const notApplied = skinNodes.filter((node) => !node.skinApplied).map((node) => node.wanted);
    const noPatch = skinNodes
        .filter((node) => node.wanted !== "CLIPTextEncode" && node.patched === 0)
        .map((node) => node.wanted);
    const domMistakes = skinNodes.filter((node) => node.domPatched > 0).map((node) => node.wanted);
    const sizeChanged = skinNodes
        .filter((node) => JSON.stringify(node.sizeBefore) !== JSON.stringify(node.sizeAfter))
        .map((node) => `${node.wanted} ${JSON.stringify(node.sizeBefore)}→${JSON.stringify(node.sizeAfter)}`);

    check("三个两列节点都建起来了", LAYOUT_CLASSES.every((cls) => byWanted.has(cls)), `built=${report.data.length}`);
    check("存在多控件行（真的量到了列）", multiRowCount >= 3, `rows=${multiRowCount}`);
    check("相邻胶囊形状不重叠且留足空白", overlapCount === 0, worst.join(" | "));
    check("每个胶囊绘制时带投影", shadowDrops >= 4, `shadowFills=${shadowDrops}`);
    check("参数名提示区有独立底色块", chips >= 4, `chipFills=${chips}`);
    check("所有未登记节点都套上了皮肤", notApplied.length === 0, notApplied.join(" | "));
    check("未登记节点的单行控件被换肤", noPatch.length === 0, noPatch.join(" | "));
    check("第三方节点也吃到皮肤（KSampler / EmptySD3LatentImage）",
        ["KSampler", "EmptySD3LatentImage"].every((cls) => (byWanted.get(cls)?.patched ?? 0) > 0),
        `KSampler=${byWanted.get("KSampler")?.patched} Empty=${byWanted.get("EmptySD3LatentImage")?.patched}`);
    check("DOM 面板 / 多行文本没有被误接管", domMistakes.length === 0, domMistakes.join(" | "));
    check("换肤不改任何节点尺寸", sizeChanged.length === 0, sizeChanged.join(" | "));
    check("官方命中区仍返回正确控件", report.hitName === "sampler_name", `hit=${report.hitName}`);
    check("无页面异常", pageErrors.length === 0, JSON.stringify(pageErrors));

    // 节点自定义颜色：控件底要跟着节点「实际渲染出来的颜色」走，而不是固定深蓝。
    // 浅色主题会先把节点色按 nodeLightness 调亮再画（#353 → hsla(120,25%,76.7%)），
    // 探针必须同时覆盖浅色 / 深色两种 nodeLightness，才能抓住「控件像蒙了一层黑」。
    const colorSkin = await page.evaluate(async () => {
        const app = window.app;
        const node = (app.graph._nodes ?? []).find((item) => item?.comfyClass === "GGPromptOptimizer")
            ?? (app.graph._nodes ?? []).find((item) => item?.comfyClass === "KSampler");
        if (!node) return null;
        const originalLightness = window.LiteGraph?.nodeLightness;
        const toRgb = (color) => {
            const ctx = document.createElement("canvas").getContext("2d");
            ctx.fillStyle = color;
            const normalized = String(ctx.fillStyle);
            if (normalized.startsWith("#")) {
                return [1, 3, 5].map((index) => parseInt(normalized.slice(index, index + 2), 16));
            }
            const match = normalized.match(/rgba?\(([^)]+)\)/);
            if (match) {
                return match[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number);
            }
            return [0, 0, 0];
        };
        const sample = async (color) => {
            node.bgcolor = color;
            node.color = color;
            window.__ggSkinFills = [];
            window.__ggSkinTexts = [];
            app.canvas.draw(true, true);
            await new Promise((resolve) => setTimeout(resolve, 120));
            return {
                rendered: toRgb(node.renderingBgColor),
                fields: [...new Set(window.__ggSkinFills
                    .filter((fill) => fill.shadowDrop && fill.blur >= 6)
                    .map((fill) => fill.fillStyle)
                    .filter((value) => /^#[0-9a-f]{6}$/.test(value)))],
                texts: [...new Set(window.__ggSkinTexts
                    .filter((value) => /^#[0-9a-f]{6}$/.test(value)))],
            };
        };
        const light = {
            brown: await sample("#6b3f3f"),
            teal: await sample("#2f5d6b"),
            cream: await sample("#e8d9b0"),
        };
        if (window.LiteGraph) window.LiteGraph.nodeLightness = 0;
        const dark = {
            brown: await sample("#6b3f3f"),
            teal: await sample("#2f5d6b"),
        };
        if (window.LiteGraph) window.LiteGraph.nodeLightness = originalLightness;
        return { light, dark, originalLightness };
    });
    const hexRgb = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
    const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const isBrownHue = ([r, g, b]) => r >= g + 4 && r >= b + 4;
    const isTealHue = ([r, g, b]) => b >= r + 4 && g >= r + 3;
    const lighterThanNode = (sample, hueTest) => sample.fields
        .map(hexRgb)
        .some((rgb) => hueTest(rgb) && lum(rgb) > lum(sample.rendered) + 0.05);
    const darkerThanNode = (sample, hueTest) => sample.fields
        .map(hexRgb)
        .some((rgb) => hueTest(rgb) && lum(rgb) < lum(sample.rendered) - 0.03);
    check("浅色节点的控件底是更浅的同色相（不再像蒙了一层黑）",
        colorSkin?.light?.brown && lighterThanNode(colorSkin.light.brown, isBrownHue)
          && lighterThanNode(colorSkin.light.teal, isTealHue),
        `brown=${JSON.stringify(colorSkin?.light?.brown?.rendered)} fields=${(colorSkin?.light?.brown?.fields ?? []).slice(0, 6)}`);
    check("深色节点的控件底是更深的同色相（保留节点色相）",
        colorSkin?.dark?.brown && darkerThanNode(colorSkin.dark.brown, isBrownHue)
          && darkerThanNode(colorSkin.dark.teal, isTealHue),
        `brown=${JSON.stringify(colorSkin?.dark?.brown?.rendered)} fields=${(colorSkin?.dark?.brown?.fields ?? []).slice(0, 6)}`);
    check("浅色节点文字自动转深色保证可读",
        colorSkin?.light?.cream?.texts.some((hex) => lum(hexRgb(hex)) < 0.35),
        `texts=${(colorSkin?.light?.cream?.texts ?? []).slice(0, 8)}`);

    await page.evaluate((graph) => {
        window.app.graph.clear();
        window.app.loadGraphData(graph);
    }, saved);
    await page.evaluate((previous) => {
        const settings = window.app.ui.settings;
        if (previous !== "all" && settings.getSettingValue("GuliNodes.widgetSkin.scope") === "all") {
            settings.setSettingValue("GuliNodes.widgetSkin.scope", previous);
        }
    }, skinScopeBefore);
    await browser.close();

    console.log(`\n${passed}/${passed + failed} 通过`);
    process.exit(failed ? 1 : 0);
})().catch((error) => {
    console.error("ERR", error.message);
    process.exit(1);
});
