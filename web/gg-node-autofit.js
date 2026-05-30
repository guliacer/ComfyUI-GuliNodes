import { app } from "../../scripts/app.js";

const MIN_NODE_WIDTH = 150;
const MIN_NODE_HEIGHT = 44;
const MAX_AUTO_NODE_WIDTH = 320;
const TITLE_PADDING = 38;
const WIDGET_LABEL_PADDING = 68;
const SLOT_PADDING = 48;
const HIDDEN_WIDGET_PREFIX = "ggHiddenLoRA";
const AUTOFIT_EXCLUDED_NODE_NAMES = new Set(["GGPrettyReroute", "GGAnythingEverywhere", "GGTitleNode"]);

let measureContext = null;
const scheduledNodes = new WeakSet();
const scheduledOptions = new WeakMap();
const initializedNodes = new WeakSet();

function getMeasureContext() {
    if (measureContext) {
        return measureContext;
    }

    const canvas = document.createElement("canvas");
    measureContext = canvas.getContext("2d");
    return measureContext;
}

function measureText(text, font = "14px Arial") {
    const context = getMeasureContext();
    const value = String(text ?? "");
    if (!context || !value) {
        return 0;
    }

    context.font = font;
    return context.measureText(value).width;
}

function isGuliNodeData(nodeData) {
    const name = String(nodeData?.name ?? "");
    const displayName = String(nodeData?.display_name ?? "");
    const category = String(nodeData?.category ?? "");
    if (AUTOFIT_EXCLUDED_NODE_NAMES.has(name)) {
        return false;
    }
    return name.startsWith("GG") || displayName.startsWith("GG") || category.includes("GuliNodes");
}

function isGuliNode(node) {
    const comfyClass = String(node?.comfyClass ?? "");
    const type = String(node?.type ?? "");
    const title = String(node?.title ?? "");
    const category = String(node?.constructor?.category ?? "");
    if (AUTOFIT_EXCLUDED_NODE_NAMES.has(comfyClass) || AUTOFIT_EXCLUDED_NODE_NAMES.has(type)) {
        return false;
    }
    return comfyClass.startsWith("GG")
        || type.startsWith("GG")
        || title.startsWith("GG")
        || category.includes("GuliNodes");
}

function isVisibleWidget(widget) {
    if (!widget || widget.hidden) {
        return false;
    }

    const type = String(widget.type ?? "");
    return !type.startsWith(HIDDEN_WIDGET_PREFIX);
}

function widgetRequiredWidth(widget) {
    if (!isVisibleWidget(widget)) {
        return 0;
    }

    const nameText = widget.label ?? widget.name ?? "";

    if (widget.type === "button") {
        return Math.min(measureText(nameText) + 44, 220);
    }

    return Math.min(measureText(nameText) + WIDGET_LABEL_PADDING, 240);
}

function slotsRequiredWidth(slots = []) {
    return slots.reduce((width, slot) => {
        const text = slot?.label || slot?.localized_name || slot?.name || "";
        return Math.max(width, Math.min(measureText(text) + SLOT_PADDING, 240));
    }, 0);
}

function hasLayoutSensitiveWidget(node) {
    return (node.widgets ?? []).some((widget) => {
        if (!isVisibleWidget(widget)) {
            return false;
        }
        const type = String(widget.type ?? "").toLowerCase();
        return Boolean(widget.element)
            || type.includes("image")
            || type.includes("video")
            || type.includes("audio")
            || type.includes("web")
            || type.includes("markdown")
            || type.includes("preview");
    });
}

function requiredNodeWidth(node) {
    if (!isGuliNode(node)) {
        return 0;
    }

    const titleWidth = measureText(node.title ?? node.type ?? "") + TITLE_PADDING;
    const widgetWidth = (node.widgets ?? []).reduce((width, widget) => {
        return Math.max(width, widgetRequiredWidth(widget));
    }, 0);
    const inputWidth = slotsRequiredWidth(node.inputs);
    const outputWidth = slotsRequiredWidth(node.outputs);

    const width = Math.max(MIN_NODE_WIDTH, titleWidth, widgetWidth, inputWidth, outputWidth);
    return Math.ceil(Math.min(width, MAX_AUTO_NODE_WIDTH));
}

function compactNodeWidth(node, computedWidth) {
    const requiredWidth = requiredNodeWidth(node);
    if (hasLayoutSensitiveWidget(node)) {
        return Math.max(MIN_NODE_WIDTH, Math.min(computedWidth, MAX_AUTO_NODE_WIDTH), requiredWidth);
    }
    return Math.max(MIN_NODE_WIDTH, requiredWidth);
}

function constrainedComputedSize(node) {
    const size = typeof node.computeSize === "function" ? node.computeSize() : node.size;
    const width = Number(size?.[0]) || MIN_NODE_WIDTH;
    const height = Number(size?.[1]) || Number(node.size?.[1]) || MIN_NODE_HEIGHT;
    return [
        compactNodeWidth(node, width),
        Math.max(MIN_NODE_HEIGHT, height),
    ];
}

function fitNode(node, options = {}) {
    if (!isGuliNode(node) || !node.size) {
        return;
    }

    installWidgetCallbacks(node);

    const computed = constrainedComputedSize(node);
    const currentWidth = Number(node.size[0]) || 0;
    const currentHeight = Number(node.size[1]) || 0;
    const minimumWidth = Number(computed[0]) || MIN_NODE_WIDTH;
    const minimumHeight = Math.max(MIN_NODE_HEIGHT, Number(computed[1]) || 0);
    const allowShrink = options.allowShrink !== false;
    let width = allowShrink ? minimumWidth : Math.max(currentWidth, minimumWidth);
    let height = allowShrink ? minimumHeight : Math.max(currentHeight, minimumHeight);

    width = Math.max(width, minimumWidth);
    height = Math.max(height, minimumHeight);

    if (Math.abs(width - currentWidth) > 1 || Math.abs(height - currentHeight) > 1) {
        node.setSize?.([Math.ceil(width), Math.ceil(height)]);
        node.size = [Math.ceil(width), Math.ceil(height)];
        try {
            node.setDirtyCanvas?.(true, true);
        } catch {
            // The canvas can be unavailable while ComfyUI is creating nodes.
        }
        try {
            node.graph?.setDirtyCanvas?.(true, true);
        } catch {
            // The node may not be attached to a graph yet.
        }
        try {
            app.graph?.setDirtyCanvas?.(true, true);
        } catch {
            // Some ComfyUI builds throw if app.graph is read too early.
        }
    }
}

function scheduleFit(node, options = {}) {
    if (!isGuliNode(node)) {
        return;
    }

    const existingOptions = scheduledOptions.get(node) ?? {};
    scheduledOptions.set(node, {
        allowShrink: options.allowShrink !== false && existingOptions.allowShrink !== false,
    });

    if (scheduledNodes.has(node)) {
        return;
    }

    scheduledNodes.add(node);
    requestAnimationFrame(() => {
        scheduledNodes.delete(node);
        const pendingOptions = scheduledOptions.get(node) ?? {};
        scheduledOptions.delete(node);
        fitNode(node, pendingOptions);
    });
}

function installWidgetCallbacks(node) {
    for (const widget of node.widgets ?? []) {
        if (!widget || widget._ggAutoFitCallbackInstalled) {
            continue;
        }

        const originalCallback = widget.callback;
        widget.callback = function (...args) {
            const result = originalCallback?.apply(this, args);
            scheduleFit(node, { allowShrink: false });
            return result;
        };
        widget._ggAutoFitCallbackInstalled = true;
    }
}

app.registerExtension({
    name: "ComfyUI.GuliNodes.NodeAutoFit",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!isGuliNodeData(nodeData) || nodeType.prototype._ggAutoFitInstalled) {
            return;
        }

        nodeType.prototype._ggAutoFitInstalled = true;

        const originalComputeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (...args) {
            const size = originalComputeSize?.apply(this, args) ?? [this.size?.[0] ?? MIN_NODE_WIDTH, this.size?.[1] ?? MIN_NODE_HEIGHT];
            if (!isGuliNode(this)) {
                return size;
            }
            const originalWidth = Number(size[0]) || MIN_NODE_WIDTH;
            const constrainedWidth = compactNodeWidth(this, originalWidth);
            return [constrainedWidth, Math.max(MIN_NODE_HEIGHT, Number(size[1]) || MIN_NODE_HEIGHT)];
        };

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = originalOnNodeCreated?.apply(this, args);
            initializedNodes.add(this);
            scheduleFit(this, { allowShrink: true });
            setTimeout(() => scheduleFit(this, { allowShrink: true }), 0);
            return result;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = originalOnConfigure?.apply(this, args);
            const isFirstLoad = !initializedNodes.has(this);
            if (isFirstLoad) {
                initializedNodes.add(this);
            }
            scheduleFit(this, { allowShrink: isFirstLoad });
            setTimeout(() => scheduleFit(this, { allowShrink: isFirstLoad }), 0);
            return result;
        };
    },

    nodeCreated(node) {
        initializedNodes.add(node);
        scheduleFit(node, { allowShrink: true });
    },

    loadedGraphNode(node) {
        initializedNodes.add(node);
        scheduleFit(node, { allowShrink: true });
        setTimeout(() => scheduleFit(node, { allowShrink: true }), 0);
    },
});
