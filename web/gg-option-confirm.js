import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

const NODE_TYPE = "GGOptionConfirm";
const MIN_OUTPUTS = 1;
const MAX_OUTPUTS = 20;
const OUTPUT_TYPE = globalThis.LiteGraph?.OUTPUT ?? 2;

const TEXT = {
    title: "GG 选项确认",
    empty: "连接到控件输入",
    category: "GuliNodes/输入",
};

function isInputSpec(value) {
    return Array.isArray(value)
        && value.length > 0
        && (typeof value[0] === "string" || Array.isArray(value[0]));
}

function symbolInputSpec(widget) {
    let current = widget;
    while (current && current !== Object.prototype) {
        for (const symbol of Object.getOwnPropertySymbols(current)) {
            const candidate = widget?.[symbol];
            if (isInputSpec(candidate)) return candidate;
            if (typeof candidate !== "function") continue;
            try {
                const config = candidate.call(widget);
                if (isInputSpec(config)) return config;
            } catch {
                // Third-party widgets may expose unrelated symbol callbacks.
            }
        }
        current = Object.getPrototypeOf(current);
    }
    return null;
}

function nodeInputSpec(targetNode, widgetName) {
    const nodeData = targetNode?.constructor?.nodeData;
    return nodeData?.input?.required?.[widgetName]
        ?? nodeData?.input?.optional?.[widgetName]
        ?? null;
}

function liveComboValues(widget) {
    const values = widget?.options?.values;
    if (typeof values === "function") {
        try {
            const resolved = values();
            return Array.isArray(resolved) ? resolved : null;
        } catch {
            return null;
        }
    }
    return Array.isArray(values) && values.length ? values : null;
}

function fallbackInputSpec(input, targetWidget) {
    if (typeof input?.type === "string" && ComfyWidgets[input.type]) {
        return [input.type, {}];
    }

    const widgetType = String(targetWidget?.type || "").toLowerCase();
    if (widgetType === "combo") {
        const values = liveComboValues(targetWidget);
        return values ? [values, { default: targetWidget.value }] : null;
    }
    if (widgetType === "number") {
        const options = targetWidget?.options || {};
        const numericType = Number.isInteger(targetWidget?.value)
            && Number.isInteger(options.step)
            ? "INT"
            : "FLOAT";
        return [numericType, { ...options, default: targetWidget.value }];
    }
    if (widgetType === "toggle") return ["BOOLEAN", { default: targetWidget.value }];
    if (widgetType === "text" || widgetType === "customtext") {
        return ["STRING", { ...targetWidget.options, default: targetWidget.value }];
    }
    return null;
}

function targetInfo(targetNode, input) {
    if (!targetNode || !input) return null;
    const widgetName = input.widget?.name || input.name;
    if (!widgetName) return null;

    const targetWidget = targetNode.widgets?.find((widget) => widget.name === widgetName);
    let config = symbolInputSpec(input.widget)
        ?? nodeInputSpec(targetNode, widgetName)
        ?? fallbackInputSpec(input, targetWidget);
    const values = liveComboValues(targetWidget);
    if (values) {
        config = [values, { ...(Array.isArray(config) ? config[1] : {}), values }];
    }
    if (!isInputSpec(config)) return null;
    return { config, input, targetNode, targetWidget, widgetName };
}

function configType(config) {
    return Array.isArray(config?.[0]) ? "COMBO" : String(config?.[0] || "*");
}

function outputHasLink(output) {
    return Boolean(output?.links?.length);
}

function removeWidgets(node) {
    for (const widget of node.widgets || []) widget.onRemove?.();
    if (node.widgets) node.widgets.length = 0;
}

function chainWidgetCallback(node, slot, widget) {
    const original = widget.callback;
    widget.callback = function ggOptionConfirmWidgetCallback() {
        const result = original?.apply(this, arguments);
        node.applySlotToGraph(slot);
        return result;
    };
}

function createNodeClass(LiteGraph) {
    class GGOptionConfirmNode extends LiteGraph.LGraphNode {
    constructor(title) {
        super(title);
        this.title = TEXT.title;
        this.serialize_widgets = true;
        this.isVirtualNode = true;
        this.properties ||= {};
        this.ensureMinimumOutputs();
    }

    addEmptyOutput() {
        if ((this.outputs?.length || 0) >= MAX_OUTPUTS) return;
        const number = (this.outputs?.length || 0) + 1;
        this.addOutput(TEXT.empty + " " + number, "*");
    }

    ensureMinimumOutputs() {
        while ((this.outputs?.length || 0) < MIN_OUTPUTS) this.addEmptyOutput();
    }

    normalizeOutputs() {
        this.ensureMinimumOutputs();
        while (
            this.outputs.length > MIN_OUTPUTS
            && !outputHasLink(this.outputs.at(-1))
            && !outputHasLink(this.outputs.at(-2))
        ) {
            this.removeOutput(this.outputs.length - 1);
        }
        if (
            this.outputs.length < MAX_OUTPUTS
            && this.outputs.every(outputHasLink)
        ) {
            this.addEmptyOutput();
        }
    }

    resolveOutputTarget(slot) {
        const output = this.outputs?.[slot];
        const linkId = output?.links?.[0];
        const link = linkId == null ? null : this.graph?.links?.[linkId];
        if (!link) return null;
        const targetNode = this.graph?.getNodeById?.(link.target_id);
        const input = targetNode?.inputs?.[link.target_slot];
        const info = targetInfo(targetNode, input);
        return info ? { ...info, link } : null;
    }

    hookTargetWidget(info) {
        const targetWidget = info.targetWidget;
        if (!targetWidget) return;
        targetWidget.__ggOptionConfirmNodes ||= new Set();
        if (targetWidget.__ggOptionConfirmNodes.has(this)) return;

        const original = targetWidget.callback;
        const node = this;
        targetWidget.callback = function ggOptionConfirmTargetCallback() {
            const result = original?.apply(this, arguments);
            node.refreshComboInNode();
            return result;
        };
        targetWidget.__ggOptionConfirmNodes.add(this);
    }

    createSlotWidget(slot, info, previousValues) {
        const name = "value_" + (slot + 1);
        const type = configType(info.config);
        const constructor = ComfyWidgets[type];
        let widget = constructor?.(this, name, info.config, app)?.widget;
        if (!widget) {
            const options = info.config?.[1] || {};
            widget = this.addWidget(
                String(info.targetWidget?.type || type).toLowerCase(),
                name,
                options.default ?? info.targetWidget?.value ?? null,
                () => {},
                { ...options },
            );
        }
        if (!widget) return null;

        if (previousValues.has(name)) {
            widget.value = previousValues.get(name);
        } else if (info.targetWidget) {
            widget.value = info.targetWidget.value;
        }
        widget.__ggOptionConfirmSlot = slot;
        chainWidgetCallback(this, slot, widget);
        this.hookTargetWidget(info);
        return widget;
    }

    rebuildWidgets(savedValues = null) {
        const previousValues = new Map(
            (this.widgets || []).map((widget) => [widget.name, widget.value]),
        );
        const oldSize = [...(this.size || [220, 80])];
        removeWidgets(this);

        for (let slot = 0; slot < this.outputs.length; slot += 1) {
            const output = this.outputs[slot];
            const info = this.resolveOutputTarget(slot);
            if (!info) {
                output.type = "*";
                output.name = TEXT.empty + " " + (slot + 1);
                delete output.widget;
                continue;
            }

            const type = configType(info.config);
            output.type = type;
            output.name = (info.input.localized_name || info.input.label || info.input.name || type)
                + " " + (slot + 1);
            output.widget = info.input.widget || { name: info.widgetName };
            this.createSlotWidget(slot, info, previousValues);
        }

        if (Array.isArray(savedValues)) {
            for (let index = 0; index < savedValues.length; index += 1) {
                if (this.widgets?.[index]) this.widgets[index].value = savedValues[index];
            }
        }

        const computed = this.computeSize?.() || oldSize;
        this.setSize?.([
            Math.max(oldSize[0], computed[0]),
            Math.max(oldSize[1], computed[1]),
        ]);
        this.setDirtyCanvas?.(true, true);
    }

    applySlotToGraph(slot) {
        const info = this.resolveOutputTarget(slot);
        const sourceWidget = this.widgets?.find(
            (widget) => widget.__ggOptionConfirmSlot === slot,
        );
        if (!info?.targetWidget || !sourceWidget) return;

        info.targetWidget.value = sourceWidget.value;
        info.targetWidget.callback?.(
            info.targetWidget.value,
            app.canvas,
            info.targetNode,
            app.canvas?.graph_mouse || [0, 0],
            {},
        );
    }

    applyToGraph() {
        for (let slot = 0; slot < this.outputs.length; slot += 1) {
            this.applySlotToGraph(slot);
        }
    }

    refreshComboInNode() {
        for (let slot = 0; slot < this.outputs.length; slot += 1) {
            const info = this.resolveOutputTarget(slot);
            const widget = this.widgets?.find(
                (candidate) => candidate.__ggOptionConfirmSlot === slot,
            );
            if (!info || widget?.type !== "combo") continue;

            const values = liveComboValues(info.targetWidget)
                || (Array.isArray(info.config[0]) ? info.config[0] : info.config?.[1]?.values);
            if (typeof values === "function") {
                try {
                    widget.options.values = values();
                } catch {
                    continue;
                }
            } else if (Array.isArray(values)) {
                widget.options.values = values;
            } else {
                continue;
            }

            const choices = widget.options.values;
            if (Array.isArray(choices) && choices.length && !choices.includes(widget.value)) {
                widget.value = choices[0];
                widget.callback?.(widget.value);
            }
        }
    }

    onConnectOutput(slot, _type, input, targetNode) {
        if (outputHasLink(this.outputs?.[slot])) return false;
        return Boolean(targetInfo(targetNode, input));
    }

    onConnectionsChange(type) {
        if (type !== OUTPUT_TYPE || app.configuringGraph) return;
        queueMicrotask(() => {
            if (!this.graph) return;
            this.normalizeOutputs();
            this.rebuildWidgets();
            this.applyToGraph();
        });
    }

    onAfterGraphConfigured() {
        const savedValues = Array.isArray(this.widgets_values)
            ? [...this.widgets_values]
            : null;
        this.normalizeOutputs();
        this.rebuildWidgets(savedValues);
        this.applyToGraph();
    }
    }
    return GGOptionConfirmNode;
}

app.registerExtension({
    name: "ComfyUI.GGNodes.OptionConfirm",

    beforeRegisterVueAppNodeDefs(nodeDefs) {
        // Frontend-only nodes are registered by ComfyUI with display_name set to
        // the raw type id ("GGOptionConfirm"). The node search only indexes
        // name / display_name / search_aliases, so the Chinese title is never
        // searchable. Rewrite our def so the node shows in Chinese and is found
        // by searching "GG 选项确认", and pin it to the existing 输入 category.
        const def = Array.isArray(nodeDefs)
            ? nodeDefs.find((entry) => entry?.name === NODE_TYPE)
            : null;
        if (!def) return;
        def.display_name = TEXT.title;
        def.category = TEXT.category;
    },

    registerCustomNodes() {
        const LiteGraph = globalThis.LiteGraph;
        if (!LiteGraph?.LGraphNode || LiteGraph.registered_node_types?.[NODE_TYPE]) return;

        const GGOptionConfirmNode = createNodeClass(LiteGraph);
        LiteGraph.registerNodeType(
            NODE_TYPE,
            Object.assign(GGOptionConfirmNode, { title: TEXT.title }),
        );
        GGOptionConfirmNode.category = TEXT.category;
    },
});
