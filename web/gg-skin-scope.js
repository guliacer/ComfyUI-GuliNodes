import { app } from "../../scripts/app.js";
import { getUserItem, setUserItem } from "./gg-userdata-store.js";

export const WIDGET_SKIN_SCOPE_SETTING = "GuliNodes.widgetSkin.scope";
export const DEFAULT_WIDGET_SKIN_SCOPE = "own";
export const WIDGET_SKIN_SCOPE_ATTRIBUTE = "data-gg-skin-scope";
export const WIDGET_SKIN_SCOPE_OPTIONS = Object.freeze([
    { value: "all", text: "适配第三方" },
    { value: "own", text: "只我们插件" },
    { value: "off", text: "所有都关闭" },
]);

const MODULE_ROOTS = [
    "custom_nodes.ComfyUI-GuliNodes",
    "custom_nodes.ComfyUI-GuliNodes-Dependencies",
    "guli_nodes",
    "guli_nodes_dependency",
];
const nodeOwners = new Map();
const listeners = new Set();
let currentScope = DEFAULT_WIDGET_SKIN_SCOPE;

function normalizeScope(value) {
    return WIDGET_SKIN_SCOPE_OPTIONS.some((option) => option.value === value)
        ? value : DEFAULT_WIDGET_SKIN_SCOPE;
}

function ownsDefinition(data) {
    const module = String(data?.python_module ?? "");
    // Match a complete module root, never another plugin sharing its prefix.
    if (module) return MODULE_ROOTS.some((root) => module === root || module.startsWith(`${root}.`));
    const category = String(data?.category ?? "");
    return category === "GuliNodes" || category.startsWith("GuliNodes/");
}

export function isGuliSkinNode(node) {
    if (!node) return false;
    const name = String(node.comfyClass ?? node.type ?? "");
    if (nodeOwners.has(name)) return nodeOwners.get(name);
    const constructor = globalThis.LiteGraph?.registered_node_types?.[name] ?? node.constructor;
    return ownsDefinition(constructor?.nodeData ?? node.nodeData ?? {
        python_module: node.python_module,
        category: constructor?.category ?? node.category,
    });
}

export function getWidgetSkinScope() {
    return currentScope;
}

export function isWidgetSkinEnabled(node) {
    if (currentScope === "off") return false;
    return currentScope === "all" || isGuliSkinNode(node);
}

export function onWidgetSkinScopeChange(listener) {
    listeners.add(listener);
    // Settings may be loaded before this consumer: synchronize existing nodes once.
    try { listener(currentScope); }
    catch (error) { console.warn("[GuliNodes] 皮肤范围初始化失败，已保留原控件绘制", error); }
    return () => listeners.delete(listener);
}

export function applyWidgetSkinScope(value) {
    const next = normalizeScope(value);
    const root = globalThis.document?.documentElement;
    if (root?.getAttribute(WIDGET_SKIN_SCOPE_ATTRIBUTE) !== next) {
        root?.setAttribute(WIDGET_SKIN_SCOPE_ATTRIBUTE, next);
    }
    if (next === currentScope) return next;
    currentScope = next;
    for (const listener of listeners) {
        try { listener(next); }
        catch (error) { console.warn("[GuliNodes] 皮肤范围更新失败，已保留原控件绘制", error); }
    }
    app.canvas?.setDirty?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    return next;
}

export function setWidgetSkinScope(value) {
    const next = applyWidgetSkinScope(value);
    setUserItem(WIDGET_SKIN_SCOPE_SETTING, next);
    return next;
}

app.registerExtension({
    name: "ComfyUI.GGNodes.WidgetSkinScope",
    settings: [{
        id: WIDGET_SKIN_SCOPE_SETTING,
        category: ["GuliNodes", "节点控件皮肤"],
        name: "皮肤范围",
        type: "radio",
        options: WIDGET_SKIN_SCOPE_OPTIONS.map((option) => ({ ...option })),
        defaultValue: DEFAULT_WIDGET_SKIN_SCOPE,
        tooltip: "首次安装只统一本插件与配套节点；适配第三方时扩展到其它节点；全部关闭恢复宿主控件外观，布局与功能保持。",
        onChange: applyWidgetSkinScope,
    }],
    beforeRegisterNodeDef(nodeType, data) {
        if (data?.name) nodeOwners.set(String(data.name), ownsDefinition(data));
    },
    setup() {
        // Development uses a user setting, never a shipped all-on default.
        applyWidgetSkinScope(getUserItem(WIDGET_SKIN_SCOPE_SETTING) ?? DEFAULT_WIDGET_SKIN_SCOPE);
    },
});
