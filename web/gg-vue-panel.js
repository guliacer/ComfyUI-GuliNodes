import { isNodes2, watchNodeState, fitNodes2Content } from "./gg-nodes2.js";
import { applySurface, ensureGGDesign } from "./gg-ui-design.js";
import { measurePanelHeight, nextWidgetHeight, lockPanelChildren } from "./gg-panel-fit.js";

// A native DOM widget used only in Nodes 2.0. Classic nodes keep their existing
// canvas controls. The widget never contributes to widgets_values.
export function createVuePanel(node, name, minimumHeight = 32) {
    const existing = node.widgets?.find(widget => widget.name === name);
    if (existing?._ggVuePanel) return existing._ggVuePanel;
    if (typeof node.addDOMWidget !== "function") return null;
    ensureGGDesign();
    const host = document.createElement("div");
    host.className = "gg-surface gg-nodes2-panel";
    host.dataset.ggPanel = name;
    Object.assign(host.style, {
        display: "flex", flex: "0 0 auto", flexDirection: "column", gap: "6px",
        width: "100%", minWidth: "0", boxSizing: "border-box", padding: "4px",
        color: "var(--gg-ink)", background: "var(--gg-panel)",
    });
    applySurface(host);
    const panel = { host, widgetPad: 0, requestedHeight: 0, height: minimumHeight };
    const widget = node.addDOMWidget(name, "gg_nodes2_panel", host, {
        serialize: false,
        getValue: () => "",
        setValue: () => {},
        getMinHeight: () => isNodes2() ? panel.height : 0,
        getMaxHeight: () => isNodes2() ? panel.height : 0,
        hideOnZoom: false,
    });
    widget.serialize = false;
    widget.serializeValue = () => undefined;
    widget.computeSize = () => [0, isNodes2() ? nextWidgetHeight(panel, panel.height) : 0];
    widget._ggVuePanel = panel;
    panel.widget = widget;
    panel.fit = () => {
        lockPanelChildren(host);
        if (!isNodes2() || !host.isConnected) return;
        const height = Math.max(minimumHeight, measurePanelHeight(host));
        if (height !== panel.height) {
            panel.height = height;
            widget.computedHeight = height;
            fitNodes2Content(node);
            node.setDirtyCanvas?.(true, true);
        }
    };
    const syncMode = enabled => {
        enabled = enabled && panel.visible !== false;
        widget.hidden = !enabled;
        host.style.display = enabled ? "flex" : "none";
        widget.computedHeight = enabled ? panel.height : 0;
        if (enabled) requestAnimationFrame(panel.fit);
    };
    panel.syncVisibility = () => syncMode(isNodes2());
    syncMode(isNodes2());
    // Content edits call fit explicitly; observe real size changes instead of
    // forcing every panel through layout on each state-sync tick.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => panel.fit()) : null;
    observer?.observe(host);
    const removed = node.onRemoved;
    node.onRemoved = function (...args) {
        observer?.disconnect();
        return removed?.apply(this, args);
    };
    watchNodeState(node, name + ":mode", (enabled, changed) => {
        if (changed) syncMode(enabled);
    });
    return panel;
}

export function panelButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gg-btn";
    button.textContent = label;
    Object.assign(button.style, { minHeight: "28px", minWidth: "0", padding: "3px 8px" });
    button.addEventListener("click", event => { event.stopPropagation(); action(event); });
    return button;
}

// Shared ordering controls for lists whose classic UI used a canvas drag handle.
export function createVueOrderControls(node, countItems, moveItem) {
    const panel = createVuePanel(node, "gg_lora_order", 38);
    if (!panel) return;
    let selected = 0;
    const refresh = enabled => {
        // Classic three-column rows blank these labels. Vue lays each widget
        // out separately, so restore names when returning to the native view.
        if (enabled) {
            for (const widget of node.widgets ?? []) {
                if (/^LoRA\d+(名称|强度)$/.test(widget.name) && !String(widget.label ?? "").trim()) widget.label = widget.name;
            }
        }
        const count = countItems();
        if (panel.count === count) return;
        panel.count = count;
        panel.visible = count > 1;
        panel.syncVisibility();
        if (!enabled || count < 2) return;
        selected = Math.min(selected, count - 1);
        const row = document.createElement("div");
        Object.assign(row.style, { display: "flex", gap: "4px", alignItems: "center" });
        const select = document.createElement("select");
        select.setAttribute("aria-label", "调整 LoRA 顺序");
        Object.assign(select.style, { flex: "1", minWidth: "0", height: "28px",
            color: "var(--gg-ink)", background: "var(--gg-field)", borderRadius: "6px" });
        for (let i = 0; i < count; i++) select.add(new Option("LoRA " + (i + 1), String(i)));
        select.value = String(selected);
        const move = delta => {
            const target = selected + delta;
            if (target < 0 || target >= count) return;
            moveItem(selected, target);
            selected = target;
            select.value = String(selected);
            node.graph?.change?.();
            updateButtons();
        };
        const up = panelButton("上移", () => move(-1));
        const down = panelButton("下移", () => move(1));
        const updateButtons = () => { up.disabled = selected === 0; down.disabled = selected === count - 1; };
        select.addEventListener("change", () => { selected = Number(select.value); updateButtons(); });
        updateButtons();
        row.append(select, up, down);
        panel.host.replaceChildren(row);
        panel.fit();
        fitNodes2Content(node);
    };
    watchNodeState(node, "lora-order", (enabled, changed) => {
        if (changed) panel.count = null;
        refresh(enabled);
    });
    refresh(isNodes2());
}
