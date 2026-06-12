import { app } from "../../scripts/app.js";

const NODE_NAME = "GGTextFileLoad";
const FILE_WIDGET_NAME = "TXT文件";
const BUTTON_NAME = "选择文件上传";
const TXT_EXTENSIONS = [".txt", ".md", ".text"];

function getFileWidget(node) {
    return node.widgets?.find((widget) => widget?.name === FILE_WIDGET_NAME) ?? null;
}

function isTxtFile(file) {
    const name = String(file?.name || "").toLowerCase();
    return TXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function setComboValue(widget, value) {
    if (!widget) return;
    const values = widget.options?.values;
    if (Array.isArray(values) && !values.includes(value)) {
        values.push(value);
        values.sort((a, b) => String(a).localeCompare(String(b), "zh-Hans-CN"));
    }
    widget.value = value;
    widget.callback?.(value);
}

async function uploadTxtFile(file) {
    const body = new FormData();
    body.append("image", file);
    body.append("type", "input");
    body.append("overwrite", "false");

    const response = await fetch("/upload/image", {
        method: "POST",
        body,
    });

    if (!response.ok) {
        throw new Error(`上传失败：HTTP ${response.status}`);
    }
    return await response.json();
}

function chooseAndUpload(node) {
    const fileWidget = getFileWidget(node);
    if (!fileWidget) return;

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.md,.text,text/plain,text/markdown";
    input.style.display = "none";
    input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        if (!isTxtFile(file)) {
            alert("请选择 .txt、.md 或 .text 文本文件。");
            return;
        }
        try {
            const uploaded = await uploadTxtFile(file);
            const subfolder = uploaded?.subfolder ? `${uploaded.subfolder}/` : "";
            const name = `${subfolder}${uploaded?.name || file.name}`;
            setComboValue(fileWidget, name);
            node.setDirtyCanvas?.(true, true);
            node.graph?.setDirtyCanvas?.(true, true);
        } catch (error) {
            console.error("[GGTxtLoad] Upload failed:", error);
            alert(error?.message || "TXT 文件上传失败。");
        }
    }, { once: true });
    document.body.appendChild(input);
    input.click();
}

function setupNode(node) {
    if (!node || (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME)) return;
    if (node._ggTxtLoadUploadInstalled) return;
    node._ggTxtLoadUploadInstalled = true;

    node.addWidget("button", BUTTON_NAME, "上传", () => chooseAndUpload(node));
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "ComfyUI.GGNodes.TxtLoad",

    nodeCreated(node) {
        setTimeout(() => setupNode(node), 0);
    },

    loadedGraphNode(node) {
        setTimeout(() => setupNode(node), 0);
    },
});
