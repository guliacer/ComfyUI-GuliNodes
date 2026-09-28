import { app } from "../../scripts/app.js";

const NODE_NAME = "GGWebAIReverseText";
const MODEL_INPUT_NAME = "模型";
const LOCAL_ONLY_WIDGETS = ["top_p采样", "top_k采样", "输出think块"];
const HIDDEN_TAG = "ggHiddenReverseText";
const widgetState = {};

function getWidget(node, name) {
    return node.widgets?.find((widget) => widget?.name === name) ?? null;
}

function isModelConnected(node) {
    const input = (node.inputs || []).find((item) => item?.name === MODEL_INPUT_NAME);
    return input?.link != null;
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

function updateLocalWidgetVisibility(node) {
    // 只有连接了本地「模型」时才走本地推理路径，采样参数才生效；
    // 未连接（走 API 配置）时隐藏本地专用参数。
    const show = isModelConnected(node);
    for (const name of LOCAL_ONLY_WIDGETS) {
        toggleWidget(node, getWidget(node, name), show);
    }
    refreshNode(node);
    requestAnimationFrame(() => refreshNode(node));
}

function setupNode(node) {
    if (node?.comfyClass !== NODE_NAME && node?.type !== NODE_NAME) return;
    updateLocalWidgetVisibility(node);
}

app.registerExtension({
    name: "ComfyUI.GGNodes.WebAIReverseText",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

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

        const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (...args) {
            const result = originalOnConnectionsChange?.apply(this, args);
            setTimeout(() => updateLocalWidgetVisibility(this), 0);
            return result;
        };
    },

    loadedGraphNode(node) {
        setTimeout(() => setupNode(node), 0);
    },
});
