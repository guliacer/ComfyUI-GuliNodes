import { app } from "../../scripts/app.js";

const NODE_NAME = "GGSeedGenerator";
const SOURCE_WIDGET = "种子来源";
const SEED_WIDGET = "种子";
const OFFSET_WIDGET = "偏移模式";
const STEP_WIDGET = "步长";
const SOURCE_RANDOM = "随机";
const SOURCE_LAST = "上次";
const SOURCE_MANUAL = "手动";
const OFFSET_KEEP = "保持";
const HIDDEN_TAG = "ggHiddenSeed";
const AUTO_SYNC_SOURCES = new Set([SOURCE_RANDOM, SOURCE_LAST]);
const widgetState = {};

function firstValue(output, key) {
    const value = output?.[key];
    return Array.isArray(value) ? value[0] : value;
}

function outputValue(output, key) {
    return firstValue(output, key)
        ?? firstValue(output?.ui, key)
        ?? firstValue(output?.message, key)
        ?? firstValue(output?.message?.ui, key);
}

function getWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

function normalizeSeed(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.trunc(number));
}

function setWidgetValue(node, widget, value) {
    if (!widget || widget.value === value) return;

    widget.value = value;
    try {
        widget.callback?.(value);
    } catch (error) {
        console.warn("[GGSeedGenerator] Unable to run seed widget callback.", error);
    }

    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function syncGeneratedSeed(node, output) {
    const resultSeed = normalizeSeed(outputValue(output, "seed") ?? outputValue(output, "种子"));
    if (resultSeed === null) return;

    const sourceWidget = getWidget(node, SOURCE_WIDGET);
    const seedWidget = getWidget(node, SEED_WIDGET);
    const offsetWidget = getWidget(node, OFFSET_WIDGET);
    const source = outputValue(output, "source") ?? sourceWidget?.value;
    const offsetMode = outputValue(output, "offset_mode") ?? offsetWidget?.value;

    node.properties = node.properties || {};
    node.properties._gg_last_generated_seed = resultSeed;
    node.properties._gg_last_seed_source = source;
    node.properties._gg_last_offset_mode = offsetMode;

    if (AUTO_SYNC_SOURCES.has(source) || (source === SOURCE_MANUAL && offsetMode !== OFFSET_KEEP)) {
        setWidgetValue(node, seedWidget, resultSeed);
    }
}

function toggleWidget(node, widget, show) {
    if (!widget) return;

    if (!widgetState[widget.name]) {
        widgetState[widget.name] = {
            origType: widget.type,
            origComputeSize: widget.computeSize,
        };
    }
    const state = widgetState[widget.name];
    widget.hidden = !show;
    widget.type = show ? state.origType : HIDDEN_TAG;
    widget.computeSize = show ? state.origComputeSize : () => [0, -4];
}

function refreshNode(node) {
    if (typeof node.computeSize === "function" && typeof node.setSize === "function") {
        const [width, height] = node.computeSize();
        node.setSize([Math.max(Number(node.size?.[0]) || 0, width), height]);
    }
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function updateStepVisibility(node) {
    const offsetWidget = getWidget(node, OFFSET_WIDGET);
    const stepWidget = getWidget(node, STEP_WIDGET);
    if (!stepWidget) return;
    toggleWidget(node, stepWidget, offsetWidget?.value !== OFFSET_KEEP);
    refreshNode(node);
    requestAnimationFrame(() => refreshNode(node));
}

function setupNode(node) {
    if (node?.comfyClass !== NODE_NAME && node?.type !== NODE_NAME) return;

    const offsetWidget = getWidget(node, OFFSET_WIDGET);
    if (offsetWidget && !offsetWidget._ggSeedCallbackInstalled) {
        const originalCallback = offsetWidget.callback;
        offsetWidget.callback = function (...args) {
            const result = originalCallback?.apply(this, args);
            updateStepVisibility(node);
            return result;
        };
        offsetWidget._ggSeedCallbackInstalled = true;
    }
    updateStepVisibility(node);
}

app.registerExtension({
    name: "ComfyUI.GGNodes.SeedGenerator",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            originalOnExecuted?.apply(this, arguments);
            syncGeneratedSeed(this, output);
        };

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = originalOnNodeCreated?.apply(this, args);
            setTimeout(() => setupNode(this), 0);
            return result;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = originalOnConfigure?.apply(this, args);
            setTimeout(() => setupNode(this), 0);
            return result;
        };
    },

    nodeCreated(node) {
        setTimeout(() => setupNode(node), 0);
    },

    loadedGraphNode(node) {
        setTimeout(() => setupNode(node), 0);
    },
});
