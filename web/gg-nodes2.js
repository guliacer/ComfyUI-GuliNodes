import { app } from "../../scripts/app.js";

// Rendering-mode and lifecycle helpers. No Vue internals or widget value setters
// are patched: the native renderer remains the owner of its layout and inputs.
export function isNodes2() {
    const setting = app.ui?.settings?.getSettingValue?.("Comfy.VueNodes.Enabled");
    return setting == null ? !!globalThis.LiteGraph?.vueNodesMode : !!setting;
}

const watched = new Map();
let timer = null;
let resizing = null;
let dragging = null;
export function nodes2Drag() { return isNodes2() ? dragging : null; }

export function isUserResizingNode(node) {
    return !!node && (resizing?.node === node || app.canvas?.resizing_node === node);
}

function tick() {
    const enabled = isNodes2();
    for (const [node, entries] of watched) {
        if (!node.graph || node.graph !== (app.canvas?.getCurrentGraph?.() ?? app.graph)) continue;
        for (const entry of entries.values()) {
            if (!enabled && entry.mode === false) continue;
            const changed = entry.mode !== enabled;
            entry.mode = enabled;
            try {
                entry.update(enabled, changed);
            } catch (error) {
                // A failed adapter must not prevent other nodes from updating.
                if (!entry.failed) console.warn("[GuliNodes] Nodes 2.0 界面同步失败：", error);
                entry.failed = true;
            }
        }
    }
}

// One bounded timer for nodes that need a canvas-draw-independent fallback.
// onRemoved releases the entry; ordinary native widgets do not join this loop.
export function watchNodeState(node, key, update) {
    let entries = watched.get(node);
    if (!entries) {
        entries = new Map();
        watched.set(node, entries);
        const removed = node.onRemoved;
        node.onRemoved = function (...args) {
            watched.delete(this);
            if (!watched.size && timer != null) {
                clearInterval(timer);
                timer = null;
            }
            return removed?.apply(this, args);
        };
    }
    if (entries.has(key)) entries.get(key).update = update;
    else entries.set(key, { update, mode: undefined, failed: false });
    if (timer == null) timer = setInterval(tick, 150);
}


const pendingFits = new WeakSet();
export function fitNodes2Content(node) {
    if (!isNodes2() || !node || pendingFits.has(node) || isUserResizingNode(node)) return;
    pendingFits.add(node);
    let attempts = 0;
    const fit = () => {
        if (!isNodes2() || !node.graph || node.graph !== (app.canvas?.getCurrentGraph?.() ?? app.graph) || isUserResizingNode(node)) { pendingFits.delete(node); return; }
        const element = document.querySelector('.lg-node[data-node-id="' + CSS.escape(String(node.id)) + '"]');
        if (!element) {
            if (++attempts < 6) { setTimeout(fit, 80); return; }
            pendingFits.delete(node);
            return;
        }
        pendingFits.delete(node);
        if (node.flags?.collapsed) return;
        const saved = element.style.getPropertyValue("--node-height");
        let natural;
        try {
            element.style.setProperty("--node-height", "0px");
            natural = Math.max(44, element.offsetHeight - (globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30));
        } finally {
            if (saved) element.style.setProperty("--node-height", saved);
            else element.style.removeProperty("--node-height");
        }
        const user = node._ggAutoFitManualSize ?? node.properties?._ggAutoFitUserSize ?? node._ggNodes2SavedSize;
        const height = Math.max(natural, Number(user?.[1]) || 0);
        if (Math.abs(height - Number(node.size?.[1])) > 1) node.setSize?.([Number(node.size[0]), height]);
    };
    requestAnimationFrame(fit);
}

function rememberSize(node) {
    if (!node?.size?.length) return;
    const size = Array.from(node.size, Number);
    if (!size.every(value => Number.isFinite(value) && value > 0)) return;
    node._ggAutoFitManualSize = size;
    node.properties ??= {};
    node.properties._ggAutoFitUserSize = size.slice();
    // Existing panel sizing listeners consume the same onResize event.
    node.onResize?.(node.size);
}

app.registerExtension({
    name: "ComfyUI.GGNodes.Nodes2Compatibility",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!String(nodeData?.name).startsWith("GG") || nodeType.prototype._ggNodes2SizePatched) return;
        nodeType.prototype._ggNodes2SizePatched = true;
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info, ...args) {
            if (info?.size?.length >= 2) this._ggNodes2SavedSize = Array.from(info.size);
            return configure?.call(this, info, ...args);
        };
    },
    setup() {
        document.addEventListener("pointerdown", event => {
            if (!isNodes2() || event.button !== 0 || event.target?.closest?.("button,input,textarea,select,[contenteditable=true],.lg-slot,[data-corner],.gg-nodes2-panel")) return;
            const element = event.target?.closest?.(".lg-node[data-node-id]");
            const graph = app.canvas?.getCurrentGraph?.() ?? app.graph;
            const node = element && graph?._nodes?.find(item => String(item.id) === element.dataset.nodeId);
            if (node && !node.flags?.pinned) dragging = { node, pointerId: event.pointerId, start: Array.from(node.pos), moved: false };
        }, true);
        document.addEventListener("pointermove", event => {
            if (!dragging || event.pointerId !== dragging.pointerId) return;
            dragging.moved ||= dragging.node.pos[0] !== dragging.start[0] || dragging.node.pos[1] !== dragging.start[1];
        }, true);
        const finishDrag = event => {
            const current = dragging;
            if (current && event.pointerId === current.pointerId) requestAnimationFrame(() => { if (dragging === current) dragging = null; });
        };
        document.addEventListener("pointerup", finishDrag, true);
        document.addEventListener("pointercancel", finishDrag, true);
        document.addEventListener("pointerdown", event => {
            if (!isNodes2() || event.button !== 0) return;
            const handle = event.target?.closest?.("[data-corner]");
            const element = handle?.closest?.(".lg-node[data-node-id]");
            if (!element) return;
            const graph = app.canvas?.getCurrentGraph?.() ?? app.graph;
            const node = graph?._nodes?.find(item => String(item.id) === element.dataset.nodeId);
            if (!node || !String(node.comfyClass ?? node.type).startsWith("GG")) return;
            resizing = { node, pointerId: event.pointerId };
        }, true);
        const finish = event => {
            if (!resizing || event.pointerId !== resizing.pointerId) return;
            const current = resizing;
            // The host commits the resize during its pointer listener first.
            requestAnimationFrame(() => {
                if (resizing !== current) return;
                rememberSize(current.node);
                resizing = null;
            });
        };
        document.addEventListener("pointerup", finish, true);
        document.addEventListener("pointercancel", finish, true);
        window.addEventListener("blur", () => { resizing = null; dragging = null; });
    },
});
