import { app } from "../../scripts/app.js";
import { ggIcon } from "./gg-ui-icons.js";

const SETTING_ID = "GuliNodes.nodePluginName.enabled";
const TOP_GROUP_ID = "gg-node-plugin-name-buttons";
const TOP_BUTTON_ID = "gg-node-plugin-name-button";
const BODY_CLASS = "gg-node-plugin-name-hidden";
const DOM_BADGE_ROW_SELECTOR = "div.flex.h-5.w-full.gap-2.px-2.text-muted-foreground";
const REVEAL_TTL = 1800;

const DRAW_BADGES_PATCHED = Symbol.for("GuliNodes.nodePluginName.drawBadgesPatched");
const DRAW_BADGES_ORIGINAL = Symbol.for("GuliNodes.nodePluginName.drawBadgesOriginal");
const MOUSE_DOWN_PATCHED = Symbol.for("GuliNodes.nodePluginName.mouseDownPatched");

let featureEnabled = false;
let topButton = null;
let topGroup = null;
let topPlacementObserver = null;
let domBadgeObserver = null;
let domScanFrame = null;
let canvasDirtyFrame = null;
const installedCanvases = new WeakSet();
const domBadgeHosts = new Set();

function readSetting(id, fallback) {
    try {
        const value = app.extensionManager?.setting?.get?.(id);
        if (value !== undefined) return value;
    } catch (error) {
        console.warn("[GuliNodes] Unable to read node plugin name setting:", error);
    }

    try {
        return app.ui?.settings?.getSettingValue?.(id, fallback) ?? fallback;
    } catch {
        return fallback;
    }
}

async function writeSetting(id, value) {
    try {
        if (app.extensionManager?.setting?.set) {
            await app.extensionManager.setting.set(id, value);
            return;
        }
    } catch (error) {
        console.warn("[GuliNodes] Unable to write node plugin name setting:", error);
    }

    try {
        app.ui?.settings?.setSettingValue?.(id, value);
    } catch (error) {
        console.warn("[GuliNodes] Unable to write UI node plugin name setting:", error);
    }
}

function getCanvas() {
    return app.canvas || globalThis.LGraphCanvas?.active_canvas || null;
}

function getGraph() {
    return getCanvas()?.graph || app.graph || null;
}

function getGraphNodes(graph = getGraph()) {
    if (!graph) return [];
    if (Array.isArray(graph._nodes)) return graph._nodes;
    if (Array.isArray(graph.nodes)) return graph.nodes;
    return Object.values(graph._nodes_by_id || graph._nodes || {});
}

function nodeId(value) {
    if (value == null) return null;
    return String(typeof value === "object" ? value.id : value);
}

function isNodeSelected(node, canvas = getCanvas()) {
    if (!node) return false;
    if (node.selected === true) return true;
    const id = nodeId(node);
    const selected = canvas?.selected_nodes || canvas?.graph?.selected_nodes;
    return id != null && selected && (selected[id] === node || selected[id] != null);
}

function isSameNode(left, right) {
    if (!left || !right) return false;
    return left === right || (nodeId(left) != null && nodeId(left) === nodeId(right));
}

function isNodeRevealed(node) {
    if (!node) return false;
    if (isNodeSelected(node)) return true;

    const now = performance.now();
    if (Number(node._ggNodePluginNameRevealUntil) > now) return true;

    const canvas = getCanvas();
    if (isSameNode(canvas?.node_over, node) || isSameNode(canvas?.nodeOver, node)) return true;
    return node.mouseOver === true;
}

function markDirty() {
    getCanvas()?.setDirty?.(true, true);
    getCanvas()?.setDirtyCanvas?.(true, true);
    getGraph()?.setDirtyCanvas?.(true, true);
}

function revealNode(node) {
    if (!node || !featureEnabled) return;
    node._ggNodePluginNameRevealUntil = performance.now() + REVEAL_TTL;
    markDirty();
    globalThis.setTimeout(() => {
        if (featureEnabled && Number(node._ggNodePluginNameRevealUntil) <= performance.now()) markDirty();
    }, REVEAL_TTL + 30);
}

function scheduleCanvasDirty() {
    if (canvasDirtyFrame != null) return;
    const request = globalThis.requestAnimationFrame || ((callback) => globalThis.setTimeout(callback, 0));
    canvasDirtyFrame = request(() => {
        canvasDirtyFrame = null;
        if (featureEnabled) markDirty();
    });
}

function patchDrawBadgesPrototype(proto) {
    if (!proto || typeof proto.drawBadges !== "function") return false;
    const original = proto.drawBadges;
    if (original[DRAW_BADGES_PATCHED]) return true;

    const wrapped = function (...args) {
        if (!featureEnabled || isNodeRevealed(this)) {
            return original.apply(this, args);
        }
        // ComfyUI composes the id/source/lifecycle labels into this row.
        // Skipping the official draw call hides the complete plugin badge row
        // without changing node data or the node's layout.
        return undefined;
    };
    wrapped[DRAW_BADGES_PATCHED] = true;
    wrapped[DRAW_BADGES_ORIGINAL] = original;

    try {
        proto.drawBadges = wrapped;
        return true;
    } catch (error) {
        console.warn("[GuliNodes] Unable to patch node badge drawing:", error);
        return false;
    }
}

function patchBadgeDrawing() {
    const prototypes = new Set();
    const globalPrototype = globalThis.LGraphNode?.prototype;
    if (globalPrototype) prototypes.add(globalPrototype);
    const liteGraphPrototype = globalThis.LiteGraph?.LGraphNode?.prototype;
    if (liteGraphPrototype) prototypes.add(liteGraphPrototype);
    for (const node of getGraphNodes()) {
        const proto = Object.getPrototypeOf(node);
        if (proto) prototypes.add(proto);
    }
    let patched = false;
    for (const proto of prototypes) patched = patchDrawBadgesPrototype(proto) || patched;
    return patched;
}

function patchNodeInteraction(node) {
    if (!node || node.onMouseDown?.[MOUSE_DOWN_PATCHED]) return;
    const original = node.onMouseDown;
    const wrapped = function (...args) {
        revealNode(this);
        return typeof original === "function" ? original.apply(this, args) : undefined;
    };
    wrapped[MOUSE_DOWN_PATCHED] = true;
    node.onMouseDown = wrapped;
}

function installCanvasInteraction(canvas = getCanvas()) {
    const element = canvas?.canvas;
    if (!element || installedCanvases.has(element)) return;
    installedCanvases.add(element);

    element.addEventListener("pointerdown", () => {
        revealNode(canvas.node_over || canvas.nodeOver);
        scheduleCanvasDirty();
    }, true);
    element.addEventListener("pointermove", scheduleCanvasDirty, { passive: true });
    element.addEventListener("pointerleave", scheduleCanvasDirty, { passive: true });
}

function findDomBadgeHost(row) {
    const rowRect = row.getBoundingClientRect();
    const fallback = row.parentElement || row;
    let current = row.parentElement;

    for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
        const rect = current.getBoundingClientRect();
        if (rect.width < rowRect.width || rect.height < rowRect.height) continue;
        const position = getComputedStyle(current).position;
        if (position === "absolute" && rect.width < 2400 && rect.height < 2400) return current;
    }
    return fallback;
}

function scanDomBadges() {
    domScanFrame = null;
    const rows = document.querySelectorAll(DOM_BADGE_ROW_SELECTOR);
    const activeHosts = new Set();
    for (const row of rows) {
        row.classList.add("gg-node-plugin-name-badges");
        const host = findDomBadgeHost(row);
        host.classList.add("gg-node-plugin-name-host");
        activeHosts.add(host);
    }
    for (const host of domBadgeHosts) {
        if (!activeHosts.has(host)) host.classList.remove("gg-node-plugin-name-host", "gg-node-plugin-name-visible");
    }
    domBadgeHosts.clear();
    for (const host of activeHosts) domBadgeHosts.add(host);
}

function queueDomBadgeScan() {
    if (domScanFrame != null) return;
    const request = globalThis.requestAnimationFrame || ((callback) => globalThis.setTimeout(callback, 0));
    domScanFrame = request(scanDomBadges);
}

function installDomBadgeSupport() {
    if (!document.body) return;
    if (!document.getElementById("gg-node-plugin-name-style")) {
        const style = document.createElement("style");
        style.id = "gg-node-plugin-name-style";
        style.textContent = `
            body.${BODY_CLASS} .gg-node-plugin-name-badges {
                opacity: 0 !important;
                visibility: hidden !important;
                pointer-events: none !important;
            }
            body.${BODY_CLASS} .gg-node-plugin-name-host:hover .gg-node-plugin-name-badges,
            body.${BODY_CLASS} .gg-node-plugin-name-host.gg-node-plugin-name-visible .gg-node-plugin-name-badges {
                opacity: 1 !important;
                visibility: visible !important;
                pointer-events: auto !important;
            }
        `;
        document.head.appendChild(style);
    }

    if (!domBadgeObserver) {
        domBadgeObserver = new MutationObserver(queueDomBadgeScan);
        domBadgeObserver.observe(document.body, { childList: true, subtree: true });
    }
    queueDomBadgeScan();
}

function installDomPointerSupport() {
    document.addEventListener("pointerdown", (event) => {
        if (!featureEnabled) return;
        for (const host of domBadgeHosts) {
            if (!host.contains(event.target)) continue;
            host.classList.add("gg-node-plugin-name-visible");
            globalThis.setTimeout(() => host.classList.remove("gg-node-plugin-name-visible"), REVEAL_TTL);
            break;
        }
    }, true);
}

function applyFeatureEnabled(value) {
    featureEnabled = value === true;
    document.body?.classList.toggle(BODY_CLASS, featureEnabled);
    updateTopButton();
    patchBadgeDrawing();
    for (const node of getGraphNodes()) patchNodeInteraction(node);
    installCanvasInteraction();
    installDomBadgeSupport();
    markDirty();
}

function updateTopButton() {
    if (!topButton) return;
    const title = featureEnabled ? "关闭节点插件名称自动隐藏" : "开启节点插件名称自动隐藏";
    topButton.title = title;
    topButton.setAttribute("aria-label", title);
    topButton.setAttribute("aria-pressed", featureEnabled ? "true" : "false");
    topButton.classList.toggle("active", featureEnabled);
    topButton.classList.toggle("gg-state-on", featureEnabled);
    topButton.classList.toggle("gg-state-off", !featureEnabled);
    topButton.innerHTML = ggIcon("tagName", 18);
}

function createTopButton() {
    if (topButton) return;
    topButton = document.createElement("button");
    topButton.id = TOP_BUTTON_ID;
    topButton.type = "button";
    topButton.className = "comfyui-button gg-node-plugin-name-top-button";
    topButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = !featureEnabled;
        applyFeatureEnabled(next);
        void writeSetting(SETTING_ID, next);
    });
    topButton.addEventListener("contextmenu", (event) => event.preventDefault());
    updateTopButton();
}

function installTopStyles() {
    if (document.getElementById("gg-node-plugin-name-top-style")) return;
    const style = document.createElement("style");
    style.id = "gg-node-plugin-name-top-style";
    style.textContent = `
        #${TOP_GROUP_ID} {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            height: 34px;
            margin-inline: 2px;
        }
        #${TOP_BUTTON_ID} {
            width: 34px;
            min-width: 34px;
            max-width: 34px;
            height: 34px;
            min-height: 34px;
            padding: 0 !important;
            border-radius: 8px;
            border: 1px solid var(--gg-ui-accent-border, rgba(100,116,139,0.3)) !important;
            background: var(--gg-ui-accent-soft, rgba(100,116,139,0.1)) !important;
            color: var(--gg-ui-accent, #64748b) !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            box-sizing: border-box;
            line-height: 0 !important;
            cursor: pointer;
        }
        #${TOP_BUTTON_ID}.gg-state-off {
            color: var(--gg-ui-muted, #64748b) !important;
            background: rgba(148,163,184,0.08) !important;
            border-color: rgba(148,163,184,0.18) !important;
        }
        #${TOP_BUTTON_ID} .gg-ui-icon {
            width: 18px;
            height: 18px;
            pointer-events: none;
        }
    `;
    document.head.appendChild(style);
}

async function setupTopButton() {
    if (topGroup) return;
    installTopStyles();
    createTopButton();
    topGroup = document.createElement("div");
    topGroup.id = TOP_GROUP_ID;
    topGroup.appendChild(topButton);

    const place = () => {
        if (window.__ggMountTopGroup?.(topGroup)) return true;
        const toolbarHost = document.getElementById("gg-toolbar-top-switch");
        if (toolbarHost) {
            if (topGroup.parentElement !== toolbarHost) toolbarHost.appendChild(topGroup);
            topGroup.style.position = "";
            topGroup.style.top = "";
            topGroup.style.right = "";
            topGroup.style.zIndex = "";
            return true;
        }

        const settingsGroup = app.menu?.settingsGroup?.element;
        if (settingsGroup?.parentElement) {
            settingsGroup.before(topGroup);
            return true;
        }

        const queueButton = document.getElementById("queue-button");
        if (queueButton?.parentElement) {
            queueButton.insertAdjacentElement("afterend", topGroup);
            return true;
        }

        if (topGroup.parentElement !== document.body) document.body.appendChild(topGroup);
        topGroup.style.position = "fixed";
        topGroup.style.top = "18px";
        topGroup.style.right = "clamp(54px, 16vw, 330px)";
        topGroup.style.zIndex = "100002";
        return false;
    };

    place();
    let attempts = 0;
    const timer = globalThis.setInterval(() => {
        attempts += 1;
        if (place() || attempts >= 12) globalThis.clearInterval(timer);
        updateTopButton();
    }, 500);

    let placeTimer = null;
    const schedulePlace = () => {
        if (placeTimer) clearTimeout(placeTimer);
        placeTimer = setTimeout(() => { placeTimer = null; place(); }, 200);
    };
    topPlacementObserver = new MutationObserver(schedulePlace);
    topPlacementObserver.observe(document.body, { childList: true, subtree: true });
}

window.__ggApplyNodePluginNameVisibility = applyFeatureEnabled;

app.registerExtension({
    name: "ComfyUI.GuliNodes.NodePluginName",

    async setup() {
        featureEnabled = readSetting(SETTING_ID, false) === true;
        installDomBadgeSupport();
        installDomPointerSupport();
        applyFeatureEnabled(featureEnabled);
        await setupTopButton();
    },

    settings: [
        {
            id: SETTING_ID,
            category: ["GuliNodes", "节点显示"],
            name: "隐藏节点插件名称",
            type: "boolean",
            defaultValue: false,
            tooltip: "开启后自动隐藏节点右上角的插件名称；选中、点击或悬浮节点时恢复显示，折叠节点同样生效。",
            onChange: (value) => applyFeatureEnabled(value),
        },
    ],

    nodeCreated(node) {
        patchBadgeDrawing();
        patchNodeInteraction(node);
        installCanvasInteraction();
    },

    loadedGraphNode(node) {
        patchBadgeDrawing();
        patchNodeInteraction(node);
        installCanvasInteraction();
        queueDomBadgeScan();
    },

    afterConfigureGraph() {
        applyFeatureEnabled(featureEnabled);
    },
});
