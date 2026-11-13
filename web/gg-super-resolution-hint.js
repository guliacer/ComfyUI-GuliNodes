import { app } from "../../scripts/app.js";

const NODE_ID = "GGImageSuperResolution";
const HINT_TEXT = "自动下载失败？点击这里查看网盘地址";
const HINT_URL = "https://pan.quark.cn/s/0fa41aaa6576";
const WIDGET_NAME = "gg_model_mirror_hint";

function ensureHintWidget(node) {
    if (node?.comfyClass !== NODE_ID && node?.type !== NODE_ID) return;
    if (!Array.isArray(node.widgets) || node.widgets.some(widget => widget.name === WIDGET_NAME)) return;
    // Native buttons have both canvas and Vue renderers, including keyboard
    // activation. This action is never serialized as a backend input.
    const widget = node.addWidget?.("button", WIDGET_NAME, HINT_TEXT, () => {
        window.open(HINT_URL, "_blank", "noopener,noreferrer");
    }, { serialize: false });
    if (!widget) return;
    widget.label = HINT_TEXT;
    widget.serialize = false;
    widget.serializeValue = () => undefined;
}

app.registerExtension({
    name: "ComfyUI.GGNodes.SuperResolutionHint",
    nodeCreated: ensureHintWidget,
    loadedGraphNode: ensureHintWidget,
    afterConfigureGraph() {
        for (const node of app.graph?._nodes ?? []) ensureHintWidget(node);
    },
});
