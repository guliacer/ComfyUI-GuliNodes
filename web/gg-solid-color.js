import { app } from "../../scripts/app.js";
import { applySurface, ensureGGDesign } from "./gg-ui-design.js";

// 画布颜色控件 —— 十六进制编辑（所有 GG 节点的 `color` 控件通用）
// ------------------------------------------------------------------
// canvas 渲染下 `io.Color` 由前端 `ColorWidget` 承担：它在控件左边画标签、
// 右边画 40px 色块，中间塞十六进制文本；整行只有一个控件时看着还行，
// 一旦被「单行多列」压进一列就会互相压住，标签永远读不全。
//
// 更要紧的是它只能点开系统取色器（`<input type="color">`），画布上没有
// 可以直接敲字的入口——用户要填一个准确的 `#364254` 只能靠取色器一点点吸。
//
// 这里接管点击：弹一个 `.gg-popover`，里面是十六进制输入框 + 色块预览 +
// 取色器按钮。输入框实时校验，`#RGB` / `#RRGGBB` / `r,g,b` 都收，提交时
// 统一写成 `#rrggbb`（后端 `_解析填充颜色` 这几种都认）。
//
// 之前只挂在 `GG纯色图像` 上，导致 `GG图像缩放V2` 切到「填充·自定义颜色」
// 后出现的同名控件仍然只能点系统取色器。现在按 `widget.type === "color"`
// 扫描所有 GG 节点，并在绘制期补挂，覆盖条件显隐后才出现的控件。
//
// 只改交互，不动控件类型与序列化：老工作流里的颜色值原样有效。

const GG_PREFIX = "GG";
const HEX_PATTERN = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGB_PATTERN = /^\(?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)?$/;

let openEditor = null;

// 系统取色面板只留一个 input 复用：每次新建的话，取消取色时 blur 不一定触发，
// 隐藏节点会一个接一个留在 body 上。
let colorPickerInput = null;

function getColorPicker() {
    if (!colorPickerInput) {
        colorPickerInput = document.createElement("input");
        colorPickerInput.type = "color";
        colorPickerInput.style.cssText =
            "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;";
        document.body.append(colorPickerInput);
    }
    return colorPickerInput;
}

function clampByte(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) {
        return 0;
    }
    return Math.min(255, Math.max(0, number));
}

function toHex6(raw) {
    const text = String(raw ?? "").trim();
    const rgb = RGB_PATTERN.exec(text);
    if (rgb) {
        const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(clampByte);
        return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    }
    if (!HEX_PATTERN.test(text)) {
        return null;
    }
    let body = text.replace(/^#/, "").toLowerCase();
    if (body.length === 3) {
        body = body.split("").map((ch) => ch + ch).join("");
    }
    return `#${body}`;
}

function currentHex(widget) {
    // 老版本可能存过 0~255 的整数写法，两种都认；认不出就给个兜底色。
    if (typeof widget?.value === "number") {
        const value = Math.max(0, Math.trunc(widget.value)) & 0xffffff;
        return `#${value.toString(16).padStart(6, "0")}`;
    }
    return toHex6(widget?.value) ?? "#00ff00";
}

function closeEditor() {
    if (!openEditor) {
        return;
    }
    const { host, dispose, commit } = openEditor;
    openEditor = null;
    dispose();
    host.remove();
    commit?.();
}

function editorTitle(widget) {
    // 动态控件的内部名是「缩放模式.填充颜色」这种带前缀的，弹层标题取最后一段。
    const raw = String(widget?.displayName || widget?.label || widget?.name || "颜色").trim();
    const short = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
    return short || "颜色";
}

function buildEditor(widget, onCommit) {
    const host = document.createElement("div");
    host.className = "gg-surface gg-popover";
    // 给一个专属标记：页面上还有别的 .gg-popover（提示词库、编组菜单），
    // 测试和排错时不能靠「最后一个 popover 就是它」来认。
    host.setAttribute("data-gg-solid-color", "1");
    host.style.cssText = "width:216px;padding:10px;display:block;";

    const title = document.createElement("span");
    title.className = "gg-popover-title";
    title.textContent = editorTitle(widget);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;";

    const swatch = document.createElement("span");
    swatch.style.cssText = [
        "width:28px", "height:28px", "flex:0 0 28px",
        "border-radius:6px", "border:1px solid var(--gg-divider)",
        "background:" + currentHex(widget),
    ].join(";");

    const input = document.createElement("input");
    input.className = "gg-field";
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = currentHex(widget);
    input.style.cssText = "font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:lowercase;";

    row.append(swatch, input);

    const hint = document.createElement("div");
    hint.textContent = "支持 #RRGGBB / #RGB / r,g,b";
    hint.style.cssText = "margin-top:6px;color:var(--gg-faint);font-size:11px;line-height:1.5;";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:6px;margin-top:8px;";

    const pickButton = document.createElement("button");
    pickButton.type = "button";
    pickButton.className = "gg-btn";
    pickButton.textContent = "取色器";

    const okButton = document.createElement("button");
    okButton.type = "button";
    okButton.className = "gg-btn is-primary";
    okButton.textContent = "确定";

    actions.append(pickButton, okButton);
    host.append(title, row, hint, actions);

    let latest = currentHex(widget);

    const syncPreview = () => {
        const hex = toHex6(input.value);
        input.style.borderColor = hex ? "" : "var(--gg-danger)";
        if (hex) {
            latest = hex;
            swatch.style.background = hex;
        }
        return hex;
    };

    input.addEventListener("input", syncPreview);
    input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
            event.preventDefault();
            if (syncPreview()) {
                closeEditor();
            }
        } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
        }
    });

    okButton.addEventListener("click", () => {
        if (syncPreview()) {
            closeEditor();
        } else {
            input.focus();
        }
    });

    pickButton.addEventListener("click", () => {
        // 系统取色器只能给「当前值」，所以先把输入框里合法的那一份喂进去。
        const picker = getColorPicker();
        const before = syncPreview() ?? latest;
        picker.value = before;
        picker.oninput = null;
        picker.onchange = () => {
            input.value = picker.value;
            syncPreview();
            commit();
        };
        picker.click();
    });

    const onPointerDown = (event) => {
        if (!host.contains(event.target)) {
            // 点到外面：填对了就落盘，填错了就当放弃，不给半截值。
            if (syncPreview()) {
                closeEditor();
            } else {
                cancel();
            }
        }
    };
    // 捕获阶段拦，避免画布同一次点击又去开别的控件。
    document.addEventListener("pointerdown", onPointerDown, true);

    function commit() {
        onCommit(latest);
    }

    function cancel() {
        openEditor = null;
        document.removeEventListener("pointerdown", onPointerDown, true);
        host.remove();
    }

    return {
        host,
        input,
        commit,
        dispose: () => document.removeEventListener("pointerdown", onPointerDown, true),
    };
}

function openHexEditor(node, widget, clientX, clientY, sourceEvent) {
    closeEditor();
    ensureGGDesign();

    // `setValue` 的第二个参数是 WidgetEventOptions，它会解构 `{ e, node, canvas }`
    // 并把 `e` 透传给 callback——少传就直接抛 `Cannot destructure property 'e'`。
    const eventOptions = {
        e: sourceEvent ?? null,
        node,
        canvas: app.canvas,
    };

    const editor = buildEditor(widget, (hex) => {
        if (typeof widget.setValue === "function") {
            widget.setValue(hex, eventOptions);
        } else {
            // 少数自定义 color 控件没有 setValue，直接写值并触发回调。
            widget.value = hex;
            widget.callback?.(hex);
        }
        node?.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
    });

    applySurface(editor.host);
    document.body.append(editor.host);

    // 先挂上去再量尺寸，才能按实际高度决定往上还是往下弹。
    const margin = 8;
    const width = editor.host.offsetWidth || 216;
    const height = editor.host.offsetHeight || 120;
    let left = Number(clientX) || 0;
    let top = (Number(clientY) || 0) + 12;
    if (left + width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - margin - width);
    }
    if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, (Number(clientY) || 0) - height - 12);
    }
    editor.host.style.left = `${left}px`;
    editor.host.style.top = `${top}px`;

    openEditor = editor;
    editor.input.focus();
    editor.input.select();
}

// 按类型挂载，不再认节点类名 / 控件名：所有 GG 节点里的 `color` 控件都该有
// 可敲字的十六进制入口，包括「填充·自定义颜色」这类条件显隐后才出现的。
function attachColorEditors(node) {
    if (!node || !String(node.comfyClass ?? "").startsWith(GG_PREFIX)) {
        return 0;
    }
    let attached = 0;
    for (const widget of node.widgets ?? []) {
        if (String(widget?.type ?? "").toLowerCase() !== "color") {
            continue;
        }
        if (widget._ggSolidColorHook) {
            continue;
        }
        widget._ggSolidColorHook = true;
        // 画布有时不带参数调用 onClick（例如程序化触发），解构前先兜一层。
        const open = (args) => {
            const { e, node: owner } = args ?? {};
            openHexEditor(owner ?? node, widget, e?.clientX, e?.clientY, e);
        };
        widget.onClick = open;
        widget.onDblClick = open;
        widget.cursor = "pointer";
        attached += 1;
    }
    return attached;
}

// 动态显隐会往 widgets 数组里增删控件：在绘制期按数组长度变化补挂一次，
// 长度没变时完全不动，几十个节点的大工作流也不会每帧白扫。
function installDynamicScan(node) {
    if (!node || node._ggColorScanInstalled) {
        return;
    }
    node._ggColorScanInstalled = true;
    const original = node.drawWidgets;
    node.drawWidgets = function (...args) {
        const count = this.widgets?.length ?? 0;
        if (this._ggColorWidgetCount !== count) {
            this._ggColorWidgetCount = count;
            attachColorEditors(this);
        }
        return original?.apply(this, args);
    };
}

function setupColorNode(node) {
    attachColorEditors(node);
    installDynamicScan(node);
}

app.registerExtension({
    name: "ComfyUI.GGNodes.SolidColor",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!String(nodeData?.name ?? "").startsWith(GG_PREFIX)) {
            return;
        }
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = onNodeCreated?.apply(this, args);
            // 部分节点的 widget 在 onNodeCreated 之后才由别的扩展补齐。
            setTimeout(() => setupColorNode(this), 0);
            return result;
        };
    },

    nodeCreated(node) {
        if (!String(node?.comfyClass ?? "").startsWith(GG_PREFIX)) {
            return;
        }
        setTimeout(() => setupColorNode(node), 0);
    },

    loadedGraphNode(node) {
        if (!String(node?.comfyClass ?? "").startsWith(GG_PREFIX)) {
            return;
        }
        // 读档重建的 widget 是新对象，_ggSolidColorHook 不跟着存档走，必须清标记重挂。
        for (const widget of node.widgets ?? []) {
            delete widget._ggSolidColorHook;
        }
        setTimeout(() => setupColorNode(node), 0);
    },

    async afterConfigureGraph() {
        const nodes = app.graph?._nodes ?? app.graph?.nodes ?? [];
        for (const node of nodes) {
            if (String(node?.comfyClass ?? "").startsWith(GG_PREFIX)) {
                setupColorNode(node);
            }
        }
    },
});
