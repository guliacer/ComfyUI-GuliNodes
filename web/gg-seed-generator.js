import { app } from "../../scripts/app.js";

const NODE_NAME = "GGSeedGenerator";
const SOURCE_WIDGET = "种子来源";
const SEED_WIDGET = "种子";
const OFFSET_WIDGET = "偏移模式";
const SOURCE_RANDOM = "随机";
const SOURCE_LAST = "上次";
const SOURCE_MANUAL = "手动";
const OFFSET_KEEP = "保持";
const AUTO_SYNC_SOURCES = new Set([SOURCE_RANDOM, SOURCE_LAST]);

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

app.registerExtension({
    name: "ComfyUI.GGNodes.SeedGenerator",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            originalOnExecuted?.apply(this, arguments);
            syncGeneratedSeed(this, output);
        };
    },
});
