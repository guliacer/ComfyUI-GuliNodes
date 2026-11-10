// Headless regression: load real extensions against a minimal ComfyUI host.
// Run: node tools/test_skin_scope.mjs
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "gg-skin-scope-test-"));
mkdirSync(join(work, "pkg", "web"), { recursive: true });
mkdirSync(join(work, "scripts"), { recursive: true });
writeFileSync(join(work, "package.json"), '{"type":"module"}', "utf8");
writeFileSync(join(work, "scripts", "app.js"), "export const app = globalThis.__testApp;\n", "utf8");
for (const name of ["gg-widget-rows.js", "gg-ui-design.js", "gg-userdata-store.js", "gg-skin-scope.js"]) {
    const source = join(root, "web", name);
    if (existsSync(source)) copyFileSync(source, join(work, "pkg", "web", name));
}

const attributes = new Map();
const settings = new Map();
const local = new Map();
const extensions = [];
const nodes = [];
let dirty = 0;
const settingId = "GuliNodes.widgetSkin.scope";
if (process.env.GG_SCOPE_START_ALL) settings.set(settingId, "all");
globalThis.window = globalThis;
globalThis.document = {
    documentElement: {
        getAttribute: (name) => attributes.get(name) ?? null,
        setAttribute: (name, value) => attributes.set(name, String(value)),
        removeAttribute: (name) => attributes.delete(name),
    },
    body: {},
};
globalThis.localStorage = {
    getItem: (key) => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, String(value)),
    removeItem: (key) => local.delete(key),
};
globalThis.LiteGraph = {
    NODE_WIDGET_HEIGHT: 24,
    WIDGET_BGCOLOR: "#202020",
    WIDGET_OUTLINE_COLOR: "#666666",
    WIDGET_TEXT_COLOR: "#dddddd",
    WIDGET_SECONDARY_TEXT_COLOR: "#999999",
    registered_node_types: {},
};
globalThis.LGraphCanvas = { clear_background_color: "#202020" };
globalThis.Comfy = { ColorPalette: "dark" };
globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
globalThis.__testApp = {
    registerExtension: (extension) => {
        extensions.push(extension);
        for (const setting of extension.settings ?? []) {
            setting.onChange?.(settings.get(setting.id) ?? setting.defaultValue);
        }
    },
    ui: { settings: {
        getSettingValue: (key, fallback) => settings.has(key) ? settings.get(key) : fallback,
        setSettingValue: (key, value) => {
            settings.set(key, value);
            for (const extension of extensions) {
                extension.settings?.find((item) => item.id === key)?.onChange?.(value);
            }
        },
    } },
    graph: { _nodes: nodes, _subgraphs: new Map() },
    canvas: { graph_mouse: [-100, -100], setDirty: () => { dirty += 1; } },
};
const earlyNode = process.env.GG_SCOPE_START_ALL
    ? makeNode("EarlyForeign", "custom_nodes.foreign", "foreign") : null;
const rows = await import(pathToFileURL(join(work, "pkg", "web", "gg-widget-rows.js")));
for (const extension of extensions) {
    await extension.init?.();
    await extension.setup?.();
}
const definition = extensions.flatMap((extension) => extension.settings ?? [])
    .find((item) => item.id === settingId);

let passed = 0;
let failed = 0;
function check(name, action) {
    try { action(); passed += 1; console.log(`PASS  ${name}`); }
    catch (error) { failed += 1; console.log(`FAIL  ${name}: ${error.message}`); }
}
function mode(value) {
    globalThis.__testApp.ui.settings.setSettingValue(settingId, value);
}
function context() {
    let path = null;
    const stack = [];
    const ctx = {
        fills: [], originals: 0, font: "", globalAlpha: 1,
        shadowBlur: 0, shadowColor: "transparent", shadowOffsetY: 0,
        fillStyle: "", strokeStyle: "", lineWidth: 1,
        save() { stack.push({ shadowBlur: this.shadowBlur, shadowColor: this.shadowColor,
            shadowOffsetY: this.shadowOffsetY, fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }); },
        restore() { Object.assign(this, stack.pop() ?? {}); },
        beginPath() { path = null; },
        roundRect(x, y, w, h) { path = { x, y, w, h }; },
        fill() { if (path) this.fills.push({ ...path, shadowBlur: this.shadowBlur, color: this.fillStyle }); },
        measureText(text) { return { width: String(text).length * 7 }; },
        stroke() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {}, rect() {}, clip() {},
        fillText() {}, translate() {},
    };
    return ctx;
}
function widget(name = "参数", type = "number") {
    return {
        name, type, value: 1, y: 12, computedHeight: 24, hidden: false,
        options: { precision: 2 },
        drawWidget(ctx) { ctx.originals += 1; },
    };
}
function makeNode(name, pythonModule, category = "GuliNodes/图像") {
    const data = { name, python_module: pythonModule, category };
    class Node {}
    Node.category = category;
    Node.nodeData = data;
    globalThis.LiteGraph.registered_node_types[name] = Node;
    for (const extension of extensions) extension.beforeRegisterNodeDef?.(Node, data);
    const node = new Node();
    Object.assign(node, {
        comfyClass: name, type: name, pos: [0, 0], size: new Float64Array([320, 100]),
        widgets: [widget()], inputs: [{ name: "参数", link: null, widget: { name: "参数" } }],
        outputs: [], properties: {},
        isWidgetVisible: (item) => !item.hidden,
        drawWidgets(ctx) { for (const item of this.widgets) item.drawWidget(ctx, { width: this.size[0], showText: true }); },
        setDirtyCanvas() {},
    });
    nodes.push(node);
    return node;
}
function draw(node) { const ctx = context(); node.drawWidgets(ctx, {}); return ctx; }
if (earlyNode) {
    check("保存的 all 早于绘制订阅时也补装已有节点", () => assert.equal(draw(earlyNode).originals, 0));
    mode("off");
    check("早期补装后用户明确 off 仍优先", () => assert.equal(draw(earlyNode).originals, 1));
    console.log(`\n${passed}/${passed + failed} 通过`);
    process.exit(failed ? 1 : 0);
}
const own = makeNode("GGScopeMain", "custom_nodes.ComfyUI-GuliNodes");
const dependency = makeNode("GGScopeDependency", "custom_nodes.ComfyUI-GuliNodes-Dependencies");
const foreign = makeNode("GGScopeForeign", "custom_nodes.ComfyUI-GuliNodes-Other", "GuliNodes/伪同名");
const official = makeNode("KSampler", "nodes", "sampling");
for (const node of nodes) rows.applyWidgetSkin(node);

check("分发默认值为只我们插件", () => assert.equal(definition?.defaultValue, "own"));
check("首次加载默认 own", () => assert.equal(attributes.get("data-gg-skin-scope"), "own"));
check("本插件控件默认绘制胶囊一次", () => {
    const ctx = draw(own);
    assert.equal(ctx.originals, 0);
    assert.equal(ctx.fills.filter((fill) => fill.h === 24 && fill.shadowBlur > 0).length, 1);
});
check("配套依赖插件默认使用相同皮肤", () => assert.equal(draw(dependency).originals, 0));
check("同前缀第三方插件保持原绘制", () => assert.equal(draw(foreign).originals, 1));
check("官方节点默认保持原绘制", () => assert.equal(draw(official).originals, 1));
mode("all");
check("切换 all 即时覆盖已有第三方节点", () => assert.equal(draw(foreign).originals, 0));
check("切换 all 同时覆盖官方标准控件", () => assert.equal(draw(official).originals, 0));
mode("off");
check("全部关闭后本插件交回原绘制", () => assert.equal(draw(own).originals, 1));
check("全部关闭后依赖包交回原绘制", () => assert.equal(draw(dependency).originals, 1));
check("全部关闭后第三方交回原绘制", () => assert.equal(draw(foreign).originals, 1));
check("全部关闭后官方交回原绘制", () => assert.equal(draw(official).originals, 1));
check("关闭不保留胶囊阴影", () => assert.equal(draw(own).fills.filter((fill) => fill.shadowBlur > 0).length, 0));
const custom = context();
rows.paintCapsuleBase(custom, 15, 12, 80, 24, true, false, own);
check("自绘列关闭后使用宿主底格且没有胶囊阴影", () => {
    assert.equal(custom.fills.filter((fill) => fill.shadowBlur > 0).length, 0);
    assert.equal(custom.fills[0]?.color, globalThis.LiteGraph.WIDGET_BGCOLOR);
});
mode("own");
check("从 all/off 返回 own 后第三方恢复原样", () => assert.equal(draw(foreign).originals, 1));
check("从 off 返回 own 后本插件重新换肤", () => assert.equal(draw(own).originals, 0));
own.widgets.push(widget("动态颜色", "color"));
check("动态新增颜色控件沿用当前范围", () => assert.equal(draw(own).originals, 0));
const dom = { ...widget("多行文本", "text"), element: {}, options: { multiline: true } };
own.widgets.push(dom);
check("DOM 多行控件仍走原绘制", () => assert.equal(draw(own).originals, 1));
check("切换皮肤不改变数值或节点尺寸", () => {
    assert.deepEqual([...own.size], [320, 100]);
    assert.equal(own.widgets[0].value, 1);
});
check("范围切换主动请求重绘", () => assert.ok(dirty > 0));
mode("invalid");
check("未知旧设置回退 own 而非全适配", () => assert.equal(attributes.get("data-gg-skin-scope"), "own"));
settings.set(settingId, "off");
for (const extension of extensions) await extension.setup?.();
check("已保存的 off 在初始化时保留", () => assert.equal(attributes.get("data-gg-skin-scope"), "off"));

const nested = makeNode("GGNestedForeign", "custom_nodes.foreign", "foreign");
nodes.pop();
const childGraph = { _nodes: [nested], _subgraphs: new Map() };
globalThis.__testApp.graph._subgraphs.set("child", childGraph);
childGraph._subgraphs.set("cycle", globalThis.__testApp.graph);
mode("all");
check("非空子图内已有第三方控件同步换肤且循环引用安全", () => assert.equal(draw(nested).originals, 0));
mode("own");
check("子图节点返回 own 后恢复原绘制", () => assert.equal(draw(nested).originals, 1));

const legacy = makeNode("LegacyForeign", "custom_nodes.foreign", "foreign");
delete legacy.widgets[0].drawWidget;
legacy.widgets[0].draw = function (ctx) { ctx.originals += 1; };
legacy.drawWidgets = function (ctx) { this.widgets[0].draw(ctx, this, this.size[0], 12, 24, false); };
mode("all");
check("legacy draw 入口换肤一次", () => {
    const ctx = draw(legacy);
    assert.equal(ctx.originals, 0);
    assert.equal(ctx.fills.filter((fill) => fill.shadowBlur > 0).length, 1);
});
mode("off");
check("legacy draw 关闭后原函数被调用一次", () => assert.equal(draw(legacy).originals, 1));

const row = makeNode("GGScopeRow", "guli_nodes.test");
rows.registerRowLayout(row.comfyClass, { columns: 1, minWidth: 320 });
const rowState = rows.applyRowLayout(row);
rowState.checkedAt = performance.now();
rowState.rows = [[row.widgets[0]]];
rowState.height = 100;
row.widgets[0]._ggCol = { x: 0, w: 320 };
check("真实行布局标准控件在 off 模式调用原绘制", () => assert.equal(draw(row).originals, 1));
mode("own");
check("真实行布局恢复 own 后重新绘制一次胶囊", () => {
    const ctx = draw(row);
    assert.equal(ctx.originals, 0);
    assert.equal(ctx.fills.filter((fill) => fill.shadowBlur > 0).length, 1);
});
console.log(`\n${passed}/${passed + failed} 通过`);
process.exitCode = failed ? 1 : 0;
