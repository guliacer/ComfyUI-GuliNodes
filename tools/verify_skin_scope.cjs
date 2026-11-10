// Live three-mode regression, with a private settings API fixture.
// Run: NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules node tools/verify_skin_scope.cjs
const { chromium } = require("playwright-core");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const URL = "http://127.0.0.1:8188/";
const SETTING = "GuliNodes.widgetSkin.scope";
const OUT = join(__dirname, "out");
mkdirSync(OUT, { recursive: true });
let passed = 0;
let failed = 0;
let browser;
const report = [];
function check(name, ok, detail = "") {
    if (ok) { passed += 1; console.log(`PASS  ${name}`); }
    else { failed += 1; console.log(`FAIL  ${name}  ${detail}`); }
}

(async () => {
    const originalSettings = await (await fetch(`${URL}settings`)).json();
    const state = { ...originalSettings };
    delete state[SETTING];
    browser = await chromium.launch({
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 2 });
    // These tests never overwrite the real user's skin or theme preference.
    await context.route(/\/settings(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
        const request = route.request();
        const path = new global.URL(request.url()).pathname;
        const key = decodeURIComponent(path.slice(path.lastIndexOf("/settings") + 9).replace(/^\/+/, ""));
        if (request.method() === "GET") {
            await route.fulfill({ json: key ? state[key] ?? null : state });
            return;
        }
        const data = request.postDataJSON();
        if (key) state[key] = data;
        else Object.assign(state, data);
        await route.fulfill({ json: { status: "ok" } });
    });
    const page = await context.newPage();
    const errors = [];
    const externalNoise = [];
    const isOurError = (text) => /gg-(skin-scope|widget-rows|widget-skin-settings|lora-(group|custom)-loader|ui-icons|toolbar)/i.test(text);
    const knownExternal = (text) => /gulips\.bridge|\[Report Only\]|report-only|Failed to load resource.*404|vite:preloadError.*ComfyUI-GuliPS|\[Jobs API\] Error fetching jobs: ZodError/i.test(text);
    page.on("pageerror", (error) => {
        const text = String(error.stack || error.message);
        if (!isOurError(text) && /ComfyUI-GuliPS\//.test(text)) externalNoise.push(text);
        else errors.push(text);
    });
    page.on("console", (message) => {
        if (message.type() === "warning" && /皮肤范围更新失败/.test(message.text())) console.log("SCOPE WARNING", message.text());
        if (message.type() !== "error") return;
        const text = message.text();
        if (!isOurError(text) && knownExternal(text)) externalNoise.push(text);
        else errors.push(text);
    });
    await page.addInitScript(() => {
        window.__ggScopeDrawing = null;
        const proto = CanvasRenderingContext2D.prototype;
        const round = proto.roundRect;
        const fill = proto.fill;
        const text = proto.fillText;
        proto.roundRect = function (x, y, w, h, ...args) {
            this.__ggScopeRect = { x, y, w, h };
            return round.call(this, x, y, w, h, ...args);
        };
        proto.fill = function (...args) {
            if (window.__ggScopeDrawing && this.__ggScopeRect) {
                window.__ggScopeDrawing.fills.push({ ...this.__ggScopeRect,
                    blur: this.shadowBlur, color: String(this.fillStyle).toLowerCase() });
            }
            return fill.apply(this, args);
        };
        proto.fillText = function (value, ...args) {
            if (window.__ggScopeDrawing) window.__ggScopeDrawing.texts.push(String(value));
            return text.call(this, value, ...args);
        };
    });
    const loaded = async () => {
        try {
            await page.waitForFunction(() => (window.app ?? window.comfyAPI?.app?.app)?.canvas?.ds && window.LiteGraph,
                null, { timeout: 30000 });
        } catch (error) {
            console.log("INIT", JSON.stringify(await page.evaluate(() => ({
                app: typeof window.app, publicApp: !!window.comfyAPI?.app?.app,
                canvas: !!window.comfyAPI?.app?.app?.canvas, liteGraph: !!window.LiteGraph,
                body: document.body.innerText.slice(0, 1200),
            }))));
            console.log("INIT ERRORS", JSON.stringify(errors));
            throw error;
        }
        await page.evaluate(() => { window.app ??= window.comfyAPI.app.app; });
        await page.waitForTimeout(1500);
    };
    await page.goto(`${URL}?gg_skin_scope=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await loaded();
    const saved = await page.evaluate(() => window.app.graph.serialize());

    const build = async () => {
        return page.evaluate(async () => {
            const app = window.app;
            app.graph.clear();
            const name = "GGForeignSkinScopeFixture";
            if (!window.LiteGraph.registered_node_types[name]) {
                class Foreign extends window.LGraphNode {
                    constructor() {
                        super("第三方范围测试");
                        this.comfyClass = name;
                        this.addWidget("number", "第三方参数", 3, () => {}, { precision: 2 });
                        this.serialize_widgets = true;
                    }
                }
                Foreign.nodeData = { name, python_module: "custom_nodes.ComfyUI-GuliNodes-Other", category: "GuliNodes/同前缀反例" };
                Foreign.category = Foreign.nodeData.category;
                window.LiteGraph.registerNodeType(name, Foreign);
            }
            const types = ["GG纯色图像", "GGFaceSkinSmoothing", "KSampler", name, "GGLoRACustomLoader", "GGLoRAGroupLoader"];
            window.__ggScopeNodes = types.map((type, index) => {
                const node = window.LiteGraph.createNode(type);
                node.pos = [40 + (index % 3) * 500, 100 + Math.floor(index / 3) * 430];
                app.graph.add(node);
                return node;
            });
            const foreign = window.__ggScopeNodes[3];
            foreign.size = [320, 100];
            // Match the real extension hook for a frontend-only foreign fixture.
            const extensionUrl = performance.getEntriesByType("resource").map((entry) => entry.name)
                .find((url) => /\/gg-widget-rows\.js(?:\?|$)/.test(url));
            const rows = await import(extensionUrl);
            const scope = await import(new window.URL("./gg-skin-scope.js", extensionUrl).href);
            rows.applyWidgetSkin(foreign);
            window.__ggScopeRows = rows;
            window.__ggScopeScope = scope;
            app.canvas.ds.scale = 0.85;
            app.canvas.ds.offset = [0, 0];
            app.canvas.draw(true, true);
            const fixture = document.createElement("div");
            document.getElementById("gg-scope-dom-fixture")?.remove();
            fixture.id = "gg-scope-dom-fixture";
            fixture.style.cssText = "position:fixed;left:10px;bottom:10px;width:240px;visibility:hidden";
            fixture.innerHTML = '<div class="comfy-setting-row" data-id="Foreign.scope">第三方设置行</div><div class="comfy-setting-row" data-id="GuliNodes.fixture">本插件设置行</div>';
            document.body.appendChild(fixture);
            return types;
        });
    };
    const types = await build();
    await page.waitForTimeout(700);

    const sample = async () => {
        // ComfyUI can finish loading its startup workflow after canvas creation.
        // Never measure detached nodes from the graph replaced by that late load.
        const attached = await page.evaluate(() => window.__ggScopeNodes?.every((node) => window.app.graph._nodes.includes(node)));
        if (!attached) {
            await build();
            await page.waitForTimeout(500);
        }
        return page.evaluate(() => {
        const app = window.app;
        app.canvas.draw(true, true);
        const nodes = window.__ggScopeNodes.map((node) => {
            const canvas = document.createElement("canvas");
            canvas.width = 1600; canvas.height = 1400;
            const ctx = canvas.getContext("2d");
            const drawing = { fills: [], texts: [] };
            window.__ggScopeDrawing = drawing;
            try { node.drawWidgets(ctx, { lowQuality: false, editorAlpha: 1 }); }
            finally { window.__ggScopeDrawing = null; }
            return { type: node.comfyClass || node.type, size: [...node.size],
                skinApplied: !!node._ggWidgetSkinApplied,
                patched: node.widgets.filter((widget) => widget._ggWidgetSkinPatched).length,
                method: String(node.widgets[0]?.drawWidget ?? node.widgets[0]?.draw).slice(0, 100),
                enabled: window.__ggScopeScope.isWidgetSkinEnabled(node),
                inGraph: app.graph._nodes.includes(node),
                values: node.widgets.map((widget) => widget.value),
                capsules: drawing.fills.filter((fill) => fill.h === 24 && fill.blur === 7).length,
                shadow: drawing.fills.filter((fill) => fill.blur > 0).length,
                texts: drawing.texts };
        });
        const field = document.querySelector('#gg-scope-dom-fixture [data-id="Foreign.scope"]');
        const style = field && getComputedStyle(field);
        return { mode: document.documentElement.getAttribute("data-gg-skin-scope"), nodes,
            internalMode: window.__ggScopeScope.getWidgetSkinScope(),
            graphCount: app.graph._nodes.length,
            buttons: [...document.querySelectorAll('#gg-widget-skin-buttons .gg-seg > button')]
                .map((button) => ({ text: button.textContent, checked: button.getAttribute("aria-pressed") })),
            foreignDom: style ? { border: style.borderBottomWidth, padding: style.padding,
                inlineBorder: field.style.borderBottom, inlinePadding: field.style.padding } : null };
        });
    };
    const first = await sample();
    check("全新安装默认只我们插件", first.mode === "own", first.mode);
    check("本插件和配套依赖包默认换肤", first.nodes[0].capsules > 0 && first.nodes[1].capsules > 0, JSON.stringify(first.nodes));
    check("官方与同前缀第三方默认保持原样", first.nodes[2].capsules === 0 && first.nodes[3].capsules === 0);
    const scopeButtons = page.locator("#gg-widget-skin-buttons .gg-seg > button");
    const installed = await scopeButtons.count() === 3;
    check("工具菜单已接入皮肤范围分段控件", installed);
    check("选择器只有三个固定模式按钮", JSON.stringify(first.buttons.map((button) => button.text))
        === JSON.stringify(["适配第三方", "只我们插件", "所有都关闭"]), JSON.stringify(first.buttons));
    check("三个模式互斥且默认选 own", first.buttons.filter((button) => button.checked === "true").length === 1
        && first.buttons[1]?.checked === "true");

    const open = async () => {
        if (!installed) return;
        // 开关现在直接长在工具菜单行内，只需打开菜单，不再有第二层面板
        if (await page.locator("#gg-top-tools-menu").count()
            && await page.locator("#gg-top-tools-menu").getAttribute("data-open") !== "true") {
            await page.locator("#gg-top-tools-button").click();
        }
    };
    const choose = async (value) => {
        if (installed) {
            await open();
            await page.locator(`#gg-widget-skin-buttons button[data-scope="${value}"]`).click();
        } else {
            await page.evaluate(({ key, value }) => window.app.ui.settings.setSettingValue(key, value), { key: SETTING, value });
        }
        await page.waitForFunction((value) => document.documentElement.getAttribute("data-gg-skin-scope") === value, value);
        await page.waitForTimeout(250);
    };

    if (process.argv.includes("--probe")) {
        await choose("all");
        const before = await sample();
        const forced = await page.evaluate(() => ({
            sameApp: window.app === window.comfyAPI.app.app,
            graphsSame: window.app.graph === window.comfyAPI.app.app.graph,
            nodes: window.__ggScopeNodes.slice(2, 4).map((node) => ({
                name: node.comfyClass, inGraph: window.comfyAPI.app.app.graph._nodes.includes(node),
                layout: !!node._ggRowLayout, registeredLayout: window.__ggScopeRows.hasRowLayout(node.comfyClass),
                count: window.__ggScopeRows.applyWidgetSkin(node),
            })),
        }));
        console.log("SCOPE PROBE", JSON.stringify({ before: before.nodes.slice(2, 4),
            forced, after: (await sample()).nodes.slice(2, 4) }, null, 2));
        await browser.close();
        return;
    }

    for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => window.app.ui.settings.setSettingValue("Comfy.ColorPalette", value), theme);
        await page.waitForTimeout(2400);
        for (const value of ["all", "own", "off", "all"]) {
            await choose(value);
            const current = await sample();
            report.push({ theme, ...current });
            check(`${theme}/${value} 造景节点均属于当前图`, current.nodes.every((node) => node.inGraph));
            const ours = current.nodes.filter((node) => !["KSampler", "GGForeignSkinScopeFixture"].includes(node.type));
            const others = current.nodes.filter((node) => ["KSampler", "GGForeignSkinScopeFixture"].includes(node.type));
            check(`${theme}/${value} 本插件范围正确`, value === "off"
                ? ours.every((node) => node.capsules === 0) : ours.every((node) => node.capsules > 0), JSON.stringify(ours));
            check(`${theme}/${value} 第三方范围正确`, value === "all"
                ? others.every((node) => node.capsules > 0) : others.every((node) => node.capsules === 0), JSON.stringify(others));
            check(`${theme}/${value} 尺寸与参数值保持`, current.nodes.every((node, index) =>
                JSON.stringify(node.size) === JSON.stringify(first.nodes[index].size)
                && JSON.stringify(node.values) === JSON.stringify(first.nodes[index].values)));
            check(`${theme}/${value} 设置行样式可逆且没有内联污染`, value === "all"
                ? current.foreignDom?.border === "1px" && !current.foreignDom.inlineBorder && !current.foreignDom.inlinePadding
                : JSON.stringify(current.foreignDom) === JSON.stringify(first.foreignDom), JSON.stringify(current.foreignDom));
            if (value === "off") check(`${theme}/off 两种 LoRA 专用组件无胶囊投影`, current.nodes.slice(4).every((node) => node.shadow === 0));
            if (installed) {
                check(`${theme}/${value} 仅所选按钮处于选中态`, current.buttons.filter((button) => button.checked === "true").length === 1);
                await page.screenshot({ path: join(OUT, `skin_scope_${theme}_${value}.png`) });
            }
        }
    }
    await choose("off");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await loaded();
    const stored = await sample().catch(() => page.evaluate(() => ({ mode: document.documentElement.getAttribute("data-gg-skin-scope") })));
    check("明确保存的 off 在刷新后保留", stored.mode === "off", stored.mode);
    check("测试没有覆盖真实用户皮肤偏好", JSON.stringify((await (await fetch(`${URL}settings`)).json())[SETTING]) === JSON.stringify(originalSettings[SETTING]));
    check("本模块错误分类的反向验证有效", isOurError("gg-skin-scope.js: ReferenceError") && !knownExternal("gg-skin-scope.js: ReferenceError"));
    check("无本插件运行异常", errors.length === 0, JSON.stringify(errors));
    await page.evaluate(async (graph) => { await window.app.loadGraphData(graph); }, saved);
    writeFileSync(join(OUT, "skin_scope_report.json"), JSON.stringify({ passed, failed, types, report, errors, externalNoise }, null, 2), "utf8");
    await browser.close();
    console.log(`\n${passed}/${passed + failed} 通过`);
    process.exitCode = failed ? 1 : 0;
})().catch(async (error) => { console.error("ERR", error.stack); await browser?.close(); process.exitCode = 1; });
