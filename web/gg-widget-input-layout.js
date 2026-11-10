import { app } from "../../scripts/app.js";

const PROTO_MARK = "_ggConnectedWidgetRowsPatched";
const NODE_MARK = "_ggConnectedWidgetRowsInstalled";

function isGuliNodeData(nodeData) {
    const name = String(nodeData?.name ?? "");
    const displayName = String(nodeData?.display_name ?? "");
    const category = String(nodeData?.category ?? "");
    return name.startsWith("GG") || displayName.startsWith("GG") || category.includes("GuliNodes");
}

function hasConnectedWidgetInput(node, widget) {
    const name = widget?.name;
    if (!name || !Array.isArray(node?.inputs)) {
        return false;
    }
    return node.inputs.some((input) => input?.widget?.name === name && input.link != null);
}

function isConnectionHiddenWidget(node, widget) {
    // ComfyUI hides a widget after its mirror input is connected. Keep its row in
    // the canvas layout so the mirror port has a stable y coordinate. Do not
    // infer this from a matching name alone: every widget may have an unlinked
    // mirror input in current frontend versions.
    return widget?.hidden === true && hasConnectedWidgetInput(node, widget);
}

function installConnectedWidgetRows(nodeType) {
    if (!nodeType?.prototype || nodeType.prototype[PROTO_MARK]) {
        return;
    }

    const proto = nodeType.prototype;
    const originalGetLayoutWidgets = proto.getLayoutWidgets;
    const originalIsWidgetRowVisible = proto.isWidgetRowVisible;
    if (typeof originalGetLayoutWidgets !== "function"
        || typeof originalIsWidgetRowVisible !== "function") {
        return;
    }

    proto.getLayoutWidgets = function (...args) {
        const widgets = originalGetLayoutWidgets.apply(this, args);
        if (!Array.isArray(widgets) || !Array.isArray(this.widgets)) {
            return widgets;
        }
        const rows = new Set(widgets);
        for (const widget of this.widgets) {
            if (isConnectionHiddenWidget(this, widget)) {
                rows.add(widget);
            }
        }
        return this.widgets.filter((widget) => rows.has(widget));
    };

    proto.isWidgetRowVisible = function (widget, ...args) {
        if (isConnectionHiddenWidget(this, widget)) {
            return true;
        }
        return originalIsWidgetRowVisible.call(this, widget, ...args);
    };

    proto[PROTO_MARK] = true;
}

function withConnectedWidgetsMeasured(node, callback) {
    const restored = [];
    for (const widget of node?.widgets ?? []) {
        if (!isConnectionHiddenWidget(node, widget)
            || typeof widget.computeSize !== "function"
            || widget._ggConnectedWidgetMeasureWrapped) {
            continue;
        }
        const original = widget.computeSize;
        widget.computeSize = function (...args) {
            const hidden = this.hidden;
            this.hidden = false;
            try {
                return original.apply(this, args);
            } finally {
                this.hidden = hidden;
            }
        };
        widget._ggConnectedWidgetMeasureWrapped = true;
        restored.push([widget, original]);
    }
    try {
        return callback();
    } finally {
        // Keep the wrappers installed: the host calls widget.computeSize later
        // during arrange/computeSize as well. They are harmless outside a
        // connected hidden row and avoid another race with the next relayout.
        void restored;
    }
}

function refreshNodeLayout(node) {
    if (!node || !node[NODE_MARK]) {
        return;
    }
    withConnectedWidgetsMeasured(node, () => {
        try {
            node.arrange?.();
        } catch {
            // Some frontend builds call arrange before the graph is attached.
        }
    });
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "ComfyUI.GuliNodes.ConnectedWidgetRows",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!isGuliNodeData(nodeData)) {
            return;
        }
        installConnectedWidgetRows(nodeType);

        const proto = nodeType.prototype;
        if (proto[NODE_MARK]) {
            return;
        }
        proto[NODE_MARK] = true;

        const originalOnConnectionsChange = proto.onConnectionsChange;
        proto.onConnectionsChange = function (...args) {
            const result = originalOnConnectionsChange?.apply(this, args);
            refreshNodeLayout(this);
            return result;
        };
    },

    nodeCreated(node) {
        if (!isGuliNodeData(node?.constructor?.nodeData ?? {
            name: node?.comfyClass ?? node?.type,
            display_name: node?.title,
            category: node?.constructor?.category,
        })) {
            return;
        }
        requestAnimationFrame(() => refreshNodeLayout(node));
    },
});
