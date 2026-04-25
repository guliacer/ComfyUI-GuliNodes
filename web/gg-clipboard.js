import { app } from "../../scripts/app.js";

const COPY_LABEL = "\u590d\u5236\u6587\u672c";
const COPIED_LABEL = "\u5df2\u590d\u5236";
const COPY_FAILED_LABEL = "\u590d\u5236\u5931\u8d25";
const READ_LABEL = "\u8bfb\u53d6\u526a\u8d34\u677f";

function getTextWidget(node) {
    return node.widgets?.find((widget) => widget.name === "text");
}

function setTextWidgetValue(widget, text) {
    if (!widget) return;
    widget.value = text;
    if (widget.element) {
        widget.element.value = text;
        widget.element.dispatchEvent(new Event("input", { bubbles: true }));
    }
}

function getTextWidgetValue(node) {
    const textWidget = getTextWidget(node);
    return String(textWidget?.value ?? textWidget?.element?.value ?? "");
}

function getDisplayText(node) {
    return getTextWidgetValue(node);
}

async function writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
        document.execCommand("copy");
    } finally {
        textarea.remove();
    }
}

function setButtonLabel(widget, label, delay = 0) {
    if (!widget) return;
    widget.label = label;
    widget.value = label;
    if (delay > 0) {
        setTimeout(() => setButtonLabel(widget, COPY_LABEL), delay);
    }
    app.graph.setDirtyCanvas(true, true);
}


app.registerExtension({
    name: "ComfyUI.GGNodes.Clipboard",
    async nodeCreated(node) {
        if (node.comfyClass === "GGClipboardReader" || node.comfyClass === "GGCLIPTextEncode") {
            const btnWidget = node.addWidget("button", "read_clipboard", READ_LABEL, () => {
                navigator.clipboard.readText().then((text) => {
                    setTextWidgetValue(getTextWidget(node), text);
                    node.setOutputData?.(0, text);
                    app.graph.setDirtyCanvas(true, true);
                }).catch((err) => {
                    console.error("\u8bfb\u53d6\u526a\u8d34\u677f\u5931\u8d25:", err);
                });
            });
            btnWidget.label = READ_LABEL;
            if (node.comfyClass === "GGClipboardReader") {
                node.setSize([220, 120]);
            } else {
                node.setSize([480, 320]);
            }
            return;
        }

        if (node.comfyClass === "GGTextDisplayCopy") {
            const copyWidget = node.addWidget("button", "copy_text", COPY_LABEL, async () => {
                try {
                    await writeClipboard(getDisplayText(node));
                    setButtonLabel(copyWidget, COPIED_LABEL, 1200);
                } catch (err) {
                    console.error("\u590d\u5236\u6587\u672c\u5931\u8d25:", err);
                    setButtonLabel(copyWidget, COPY_FAILED_LABEL, 1600);
                }
            });
            copyWidget.label = COPY_LABEL;
            node.setSize([320, 240]);
        }
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "GGTextDisplayCopy") return;

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function(message) {
            onExecuted?.apply(this, arguments);
            const text = Array.isArray(message?.text) ? message.text.join("\n") : String(message?.text ?? getTextWidgetValue(this));
            setTextWidgetValue(getTextWidget(this), text);
            app.graph.setDirtyCanvas(true, true);
        };
    }
});
