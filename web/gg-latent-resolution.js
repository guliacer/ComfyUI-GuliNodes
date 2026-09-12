import { app } from "../../scripts/app.js";

const NODE_NAME = "GGAspectRatioLatent";
const RESOLUTION_WIDGET = "分辨率";
const RATIO_WIDGET = "宽高比例";
const EDGE_WIDGET = "边长";
const EDGE_TYPE_WIDGET = "边长类型";
const ORIENTATION_WIDGET = "画面方向";
const K_SCALES = Object.freeze({ "1K": 1, "2K": 2, "3K": 3, "4K": 4 });

const REFERENCE_RESOLUTION_BASES = Object.freeze({
    "1:1": [1024, 1024],
    "3:4": [864, 1152],
    "4:3": [1152, 864],
    "16:9": [1312, 736],
    "9:16": [736, 1312],
    "2:3": [832, 1248],
    "3:2": [1248, 832],
    "21:9": [1568, 672],
});

function getWidget(node, name) {
    return node?.widgets?.find((widget) => widget.name === name);
}

function alignToEight(value) {
    return Math.max(8, Math.floor(value / 8) * 8);
}

function getPresetDimensions(ratio, resolution, orientation) {
    const scale = K_SCALES[resolution];
    if (!scale || typeof ratio !== "string") return null;

    const parts = ratio.split(":", 2).map(Number);
    if (parts.length !== 2 || !parts.every(Number.isFinite) || parts.some((part) => part <= 0)) {
        return null;
    }

    let [ratioWidth, ratioHeight] = parts;
    if ((orientation === "横屏" && ratioWidth < ratioHeight) ||
        (orientation === "竖屏" && ratioWidth > ratioHeight)) {
        [ratioWidth, ratioHeight] = [ratioHeight, ratioWidth];
    }

    const base = REFERENCE_RESOLUTION_BASES[`${ratioWidth}:${ratioHeight}`];
    if (base) {
        return [alignToEight(base[0] * scale), alignToEight(base[1] * scale)];
    }

    const targetArea = (1024 * scale) ** 2;
    return [
        alignToEight(Math.round(Math.sqrt(targetArea * ratioWidth / ratioHeight))),
        alignToEight(Math.round(Math.sqrt(targetArea * ratioHeight / ratioWidth))),
    ];
}

function markDirty(node) {
    node?.setDirtyCanvas?.(true, true);
    node?.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function setWidgetValue(node, widget, value) {
    if (!widget || widget.value === value) return;
    widget.value = value;
    markDirty(node);
}

function syncEdgeFromResolution(node) {
    const resolution = getWidget(node, RESOLUTION_WIDGET)?.value;
    const dimensions = getPresetDimensions(
        getWidget(node, RATIO_WIDGET)?.value,
        resolution,
        getWidget(node, ORIENTATION_WIDGET)?.value,
    );
    if (!dimensions) return;

    const edge = getPresetEdge(node, dimensions);
    setWidgetValue(node, getWidget(node, EDGE_WIDGET), edge);
}

function getPresetEdge(node, dimensions) {
    const edgeType = getWidget(node, EDGE_TYPE_WIDGET)?.value;
    return edgeType === "最短边" ? Math.min(...dimensions) : Math.max(...dimensions);
}

function wrapWidget(widget, handler) {
    if (!widget || widget.ggLatentResolutionWrapped) return;
    const originalCallback = widget.callback;
    widget.callback = function (...args) {
        const result = originalCallback?.apply(this, args);
        try {
            handler(...args);
        } catch (error) {
            console.warn("[GGLatentResolution] Unable to sync resolution widgets.", error);
        }
        return result;
    };
    widget.ggLatentResolutionWrapped = true;
}

function setupNode(node) {
    if (!node || (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME)) return;
    if (node.ggLatentResolutionInstalled) return;

    const resolutionWidget = getWidget(node, RESOLUTION_WIDGET);
    const ratioWidget = getWidget(node, RATIO_WIDGET);
    const edgeWidget = getWidget(node, EDGE_WIDGET);
    const edgeTypeWidget = getWidget(node, EDGE_TYPE_WIDGET);
    const orientationWidget = getWidget(node, ORIENTATION_WIDGET);
    if (!resolutionWidget || !ratioWidget || !edgeWidget || !edgeTypeWidget || !orientationWidget) return;

    node.ggLatentResolutionInstalled = true;
    wrapWidget(resolutionWidget, () => syncEdgeFromResolution(node));
    wrapWidget(ratioWidget, () => syncEdgeFromResolution(node));
    wrapWidget(edgeTypeWidget, () => syncEdgeFromResolution(node));
    wrapWidget(orientationWidget, () => syncEdgeFromResolution(node));
    wrapWidget(edgeWidget, () => {
        // A direct edge edit makes the explicit size authoritative.
        setWidgetValue(node, resolutionWidget, "自定义");
    });

    // Configure/load can restore widgets without invoking their callbacks.
    // Preserve a manually edited edge from older workflows: a saved preset is
    // authoritative only when the saved edge still matches that preset.
    if (resolutionWidget.value !== "自定义") {
        const dimensions = getPresetDimensions(
            ratioWidget.value,
            resolutionWidget.value,
            orientationWidget.value,
        );
        const expectedEdge = dimensions ? getPresetEdge(node, dimensions) : null;
        if (expectedEdge !== null && Number(edgeWidget.value) !== expectedEdge) {
            setWidgetValue(node, resolutionWidget, "自定义");
        } else {
            syncEdgeFromResolution(node);
        }
    }
}

function deferSetup(node) {
    setTimeout(() => setupNode(node), 0);
}

app.registerExtension({
    name: "ComfyUI.GGNodes.LatentResolution",

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME || nodeType.prototype.ggLatentResolutionHooksInstalled) return;
        nodeType.prototype.ggLatentResolutionHooksInstalled = true;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = originalOnNodeCreated?.apply(this, args);
            deferSetup(this);
            return result;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = originalOnConfigure?.apply(this, args);
            deferSetup(this);
            return result;
        };
    },

    nodeCreated(node) {
        deferSetup(node);
    },

    loadedGraphNode(node) {
        deferSetup(node);
    },
});
