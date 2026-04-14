import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "ComfyUI.GGNodes.Clipboard",
    async nodeCreated(node) {
        if (node.comfyClass === "GGClipboardReader") {
            // 添加读取剪贴板按钮
            const btnWidget = node.addWidget("button", "read_clipboard", "read_clipboard", () => {
                // 直接读取剪贴板并设置输出，不触发后端
                navigator.clipboard.readText().then(text => {
                    const textWidget = node.widgets.find(w => w.name === "text");
                    if (textWidget) {
                        textWidget.value = text;
                        // 刷新显示
                        textWidget.element.value = text;
                        textWidget.element.dispatchEvent(new Event("input", { bubbles: true }));
                    }
                    // 直接设置输出数据，不经过后端
                    node.setOutputData(0, text);
                    app.graph.setDirtyCanvas(true);
                }).catch(err => {
                    console.error("读取剪贴板失败:", err);
                });
            });
            
            // 美化按钮显示
            btnWidget.label = "📋 读取剪贴板";
            node.setSize([180, 100]);
        }
    }
});