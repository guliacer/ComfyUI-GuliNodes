import { app } from "../../scripts/app.js";
import { growOnlyHeight } from "./gg-port-list-layout.js";

const NODE_NAME = "GGImageMergeMask";
const MASK_INPUT_NAME = "遮罩";
// 「遮罩扩展」「模糊半径」只作用在遮罩上：没接遮罩时遮罩是全白，
// 膨胀/羽化都不会改变结果，留着只会让人以为调了有效果。
const MASK_ONLY_WIDGETS = ["遮罩扩展", "模糊半径"];
const HIDDEN_TAG = "ggHiddenImageMergeMask";
const widgetState = {};

function getWidget(node, name) {
    return node.widgets?.find((widget) => widget?.name === name) ?? null;
}

function isMaskConnected(node) {
    const input = (node.inputs || []).find((item) => item?.name === MASK_INPUT_NAME);
    return input?.link != null;
}

function isWidgetConnected(node, name) {
    // 新版前端把每个控件镜像成一条 inputs 条目，接线后 link 不为空。
    return (node.inputs || []).some((item) => item?.widget?.name === name && item.link != null);
}

function ensureState(widget) {
    if (!widgetState[widget.name]) {
        widgetState[widget.name] = {
            origType: widget.type,
            origComputeSize: widget.computeSize,
        };
    }
    return widgetState[widget.name];
}

function toggleWidget(widget, show) {
    if (!widget) return;
    const state = ensureState(widget);
    // 显示时必须先恢复 type：前端在当前 type 属于隐藏类型时会丢弃 hidden 写入。
    if (show) {
        widget.type = state.origType;
        widget.hidden = false;
    } else {
        widget.hidden = true;
        widget.type = HIDDEN_TAG;
    }
    widget.computeSize = show ? state.origComputeSize : () => [0, -4];
}

function releaseWidget(widget) {
    // 控件被接成输入口时交还给前端：只恢复真实类型和尺寸，
    // hidden 留给前端按接线状态管，否则会把接线时的隐藏状态改回来。
    if (!widget) return;
    const state = ensureState(widget);
    if (widget.type === HIDDEN_TAG) widget.type = state.origType;
    widget.computeSize = state.origComputeSize;
}

function refreshNode(node) {
    if (typeof node.computeSize === "function" && typeof node.setSize === "function") {
        const [width, height] = node.computeSize();
        // 只增不减：用户拉高的高度不被「接没接遮罩」切换压回去（规则见 gg-port-list-layout.js）
        node.setSize([Math.max(Number(node.size?.[0]) || 0, width), growOnlyHeight(node.size?.[1], height)]);
    }
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function updateMaskWidgetVisibility(node) {
    const show = isMaskConnected(node);
    for (const name of MASK_ONLY_WIDGETS) {
        const widget = getWidget(node, name);
        if (!widget) continue;
        if (isWidgetConnected(node, name)) {
            releaseWidget(widget);
            continue;
        }
        toggleWidget(widget, show);
    }
    refreshNode(node);
    requestAnimationFrame(() => refreshNode(node));
}

function setupNode(node) {
    if (node?.comfyClass !== NODE_NAME && node?.type !== NODE_NAME) return;
    updateMaskWidgetVisibility(node);
}

app.registerExtension({
    name: "ComfyUI.GGNodes.ImageMergeMask",

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
            setTimeout(() => updateMaskWidgetVisibility(this), 0);
            return result;
        };
    },

    loadedGraphNode(node) {
        setTimeout(() => setupNode(node), 0);
    },
});
