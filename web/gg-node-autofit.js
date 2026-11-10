import { app } from "../../scripts/app.js";
import "./gg-widget-input-layout.js";

const MIN_NODE_WIDTH = 150;
const MIN_NODE_HEIGHT = 44;
const MAX_AUTO_NODE_WIDTH = 320;
const TITLE_PADDING = 38;
const WIDGET_LABEL_PADDING = 68;
const SLOT_PADDING = 48;
const HIDDEN_WIDGET_PREFIX = "ggHiddenLoRA";
// GGImageSuperResolution 的高度交给原生布局：底部那行提示文字是一个真正的
// custom widget，高度已经算进 node.computeSize()。autofit 再按内容定高一次会
// 把用户拖动的高度压回去，所以整体跳过（宽度也交回原生）。
const AUTOFIT_EXCLUDED_NODE_NAMES = new Set([
    "GGTitleNode",
    "GGGroupControllerM",
    "GGGroupControllerS",
    "GGPromptEnhancer",
    "GGOptionConfirm",
    "GGImageSuperResolution",
    // GG 图像对比 2张：大预览节点，尺寸完全归用户。autofit 在创建路径上
    // scheduleFit(allowShrink:true)，会把它 onNodeCreated 里刚定的 260×420
    // 按 computeSize 内容尺寸收回去；Vue 拖拽路径又不写 canvas.resizing_node，
    // 手动尺寸记不下来，用户拉大后下一次 fit 还是会缩。整类排除，
    // 尺寸下限与防收缩由 gg-image-comparer.js 自己接管。
    "GGImageComparer2",
]);

let measureContext = null;
const scheduledNodes = new WeakSet();
const scheduledOptions = new WeakMap();
const initializedNodes = new WeakSet();
// 用户手动拖过的节点尺寸。只存在节点对象上，不写 properties：
// 尺寸本身随工作流存进 node.size，重开时还在，这里只要别去改它就够了。
// 标记的意义是「这个人自己定过尺寸，autofit 从今往后只许撑大、不许收小」。
const MANUAL_SIZE_FLAG = "_ggAutoFitManualSize";

function readManualSize(node) {
    const size = node?.[MANUAL_SIZE_FLAG];
    return Array.isArray(size) && size.length >= 2 ? size : null;
}

// node.size 在这个前端里是 Float64Array，不是数组——用 Array.isArray 判会一直判假，
// 手动尺寸就永远记不下来。两边都认的写法是「有 length 且能取到两个数」。
function readNodeSize(node) {
    const size = node?.size;
    return size && typeof size.length === "number" && size.length >= 2 ? size : null;
}

function getMeasureContext() {
    if (measureContext) {
        return measureContext;
    }

    const canvas = document.createElement("canvas");
    measureContext = canvas.getContext("2d");
    return measureContext;
}

function measureText(text, font = "14px Arial") {
    const context = getMeasureContext();
    const value = String(text ?? "");
    if (!context || !value) {
        return 0;
    }

    context.font = font;
    return context.measureText(value).width;
}

function isGuliNodeData(nodeData) {
    const name = String(nodeData?.name ?? "");
    const displayName = String(nodeData?.display_name ?? "");
    const category = String(nodeData?.category ?? "");
    if (AUTOFIT_EXCLUDED_NODE_NAMES.has(name)) {
        return false;
    }
    return name.startsWith("GG") || displayName.startsWith("GG") || category.includes("GuliNodes");
}

function isGuliNode(node) {
    const comfyClass = String(node?.comfyClass ?? "");
    const type = String(node?.type ?? "");
    const title = String(node?.title ?? "");
    const category = String(node?.constructor?.category ?? "");
    if (AUTOFIT_EXCLUDED_NODE_NAMES.has(comfyClass) || AUTOFIT_EXCLUDED_NODE_NAMES.has(type)) {
        return false;
    }
    return comfyClass.startsWith("GG")
        || type.startsWith("GG")
        || title.startsWith("GG")
        || category.includes("GuliNodes");
}

function isVisibleWidget(widget) {
    if (!widget || widget.hidden) {
        return false;
    }

    const type = String(widget.type ?? "");
    return !type.startsWith(HIDDEN_WIDGET_PREFIX);
}

function widgetRequiredWidth(widget) {
    if (!isVisibleWidget(widget)) {
        return 0;
    }

    const nameText = widget.label ?? widget.name ?? "";

    if (widget.type === "button") {
        return Math.min(measureText(nameText) + 44, 220);
    }

    return Math.min(measureText(nameText) + WIDGET_LABEL_PADDING, 240);
}

function slotsRequiredWidth(slots = []) {
    return slots.reduce((width, slot) => {
        const text = slot?.label || slot?.localized_name || slot?.name || "";
        return Math.max(width, Math.min(measureText(text) + SLOT_PADDING, 240));
    }, 0);
}

function hasLayoutSensitiveWidget(node) {
    return (node.widgets ?? []).some((widget) => {
        if (!isVisibleWidget(widget)) {
            return false;
        }
        const type = String(widget.type ?? "").toLowerCase();
        return Boolean(widget.element)
            || type.includes("image")
            || type.includes("video")
            || type.includes("audio")
            || type.includes("web")
            || type.includes("markdown")
            || type.includes("preview");
    });
}

function requiredNodeWidth(node) {
    if (!isGuliNode(node)) {
        return 0;
    }

    const titleWidth = measureText(node.title ?? node.type ?? "") + TITLE_PADDING;
    const widgetWidth = (node.widgets ?? []).reduce((width, widget) => {
        return Math.max(width, widgetRequiredWidth(widget));
    }, 0);
    const inputWidth = slotsRequiredWidth(node.inputs);
    const outputWidth = slotsRequiredWidth(node.outputs);

    const width = Math.max(MIN_NODE_WIDTH, titleWidth, widgetWidth, inputWidth, outputWidth);
    return Math.ceil(Math.min(width, MAX_AUTO_NODE_WIDTH));
}

function compactNodeWidth(node, computedWidth) {
    const requiredWidth = requiredNodeWidth(node);
    // 节点可以声明自己的宽度下限（`_ggAutoFitMinWidth`）：控件是「标签左 + 数值右」
    // 的排法时，按标签估宽会把数值切掉，节点自己量出来的宽度更准。
    const floorWidth = Number(node?._ggAutoFitMinWidth) || 0;
    // 含 DOM widget（预览/面板/输入框等）的节点，宽度必须能容纳其内容。
    // computedWidth 是节点原生 computeSize 的结果，已包含 DOM widget 的
    // 内容宽度（如 WebAI 面板 520、视频预览 360），不能截断到
    // MAX_AUTO_NODE_WIDTH，否则内容会溢出节点边界。
    if (hasLayoutSensitiveWidget(node)) {
        return Math.max(MIN_NODE_WIDTH, computedWidth, requiredWidth, floorWidth);
    }
    return Math.max(MIN_NODE_WIDTH, requiredWidth, floorWidth);
}

function constrainedComputedSize(node) {
    const size = typeof node.computeSize === "function" ? node.computeSize() : node.size;
    const width = Number(size?.[0]) || MIN_NODE_WIDTH;
    const height = Number(size?.[1]) || Number(node.size?.[1]) || MIN_NODE_HEIGHT;
    return [
        compactNodeWidth(node, width),
        Math.max(MIN_NODE_HEIGHT, height),
    ];
}

function isNodeHeightOwnedByPortLayout(node) {
    if (!node) {
        return false;
    }

    // A collapsed node has a native title-only height.  A port-list-managed
    // node has either the compact height or the user's manually enlarged
    // height.  In both cases the generic autofit pass must leave height alone;
    // it may still keep the width compact.
    const collapsed = node.flags?.collapsed === true || node.collapsed === true;
    const hiddenPorts = node._ggPortListHidden === true
        || node.properties?._gg_port_list_hidden === true;
    const portLayoutOwnsHeight = node._ggPortListAutoSized === true
        || node._ggPortListManualSizeObserved === true
        || Array.isArray(node._ggPortListCompactSize)
        || node._ggPortListDrawingHidden === true;

    return collapsed || (hiddenPorts && portLayoutOwnsHeight);
}

function isKeyInputManagedHeight(node) {
    return node?.comfyClass === "GGKeyInput" || node?.type === "GGKeyInput";
}

function isCompressSaveSizeLocked(node) {
    return (node?.comfyClass === "GGImageCompressSave" || node?.type === "GGImageCompressSave")
        && node?._ggCompressSaveSizeLocked === true;
}

function hasMultilineTextWidget(node) {
    return (node?.widgets ?? []).some((widget) => {
        if (!widget || widget.hidden) return false;
        const type = String(widget.type ?? "").toLowerCase();
        if (type === "customtext" || type === "textarea") return true;
        if (widget.options?.multiline === true) return true;
        const el = widget.element || widget.inputEl;
        if (el && (el.tagName === "TEXTAREA" || el.querySelector?.("textarea"))) return true;
        return false;
    });
}

function fitNode(node, options = {}) {
    if (!isGuliNode(node) || !node.size) {
        return;
    }

    // 用户正握着这条边拖：任何自动写入都会跟拉力打架，把「拖小」实时顶回去，
    // 手动尺寸就永远记不到小值。拖拽期间整场停手，松手后再说。
    const liveCanvas = app?.canvas || globalThis.LGraphCanvas?.active_canvas;
    if (liveCanvas?.resizing_node === node) {
        return;
    }

    // 含多行文本框的节点，高度必须交给用户/原生自由调节：autofit 一旦按内容定高，
    // 多行框的最小高度会把节点卡在“只能拉高、无法压低”。这类节点整体跳过 autofit
    // （宽度也交回原生），确保用户能自己拉伸高度。
    if (hasMultilineTextWidget(node)) {
        return;
    }

    // 折叠节点的宽度由折叠按钮按标题贴合（见 gg-port-list-toggle.js）。
    // autofit 若继续按内容宽度调整，会把折叠节点重新撑宽，这里直接跳过。
    if (node.flags?.collapsed === true || node.collapsed === true) {
        return;
    }

    // GG 图像压缩保存自己记住工作流尺寸。加载后若再按内容收缩，
    // 切换工作流时节点高度会变。
    if (isCompressSaveSizeLocked(node)) {
        return;
    }

    // 两个 LoRA 节点都由各自的前端模块自行管理高度
    // （隐藏/显示 LoRA 槽位时精确贴合内容），autofit 只负责宽度，
    // 避免 allowShrink:false 把高度抬出内容范围。
    const heightLocked = node.comfyClass === "GGLoRACustomLoader"
        || node.type === "GGLoRACustomLoader"
        || node.comfyClass === "GGLoRAGroupLoader"
        || node.type === "GGLoRAGroupLoader";

    installWidgetCallbacks(node);

    const computed = constrainedComputedSize(node);
    const currentWidth = Number(node.size[0]) || 0;
    const currentHeight = Number(node.size[1]) || 0;
    const minimumWidth = Number(computed[0]) || MIN_NODE_WIDTH;
    const heightOwnedByPortLayout = isNodeHeightOwnedByPortLayout(node);
    const customHeight = isKeyInputManagedHeight(node);
    const minimumHeight = heightOwnedByPortLayout || customHeight
        ? currentHeight
        : Math.max(MIN_NODE_HEIGHT, Number(computed[1]) || 0);
    // 用户手动拖过尺寸的节点一律只增不减：宽高都是他自己定的，autofit 只负责别让内容被裁。
    // GGLoRACustomLoader 例外：它的高度本来就该跟着槽位数量精确贴合（见上），
    // 那是功能不是 bug，所以不参与这条保护。
    const manual = heightLocked ? null : readManualSize(node);
    const allowShrink = options.allowShrink !== false && !manual;
    // 下限要用「手动尺寸」而不是「当前尺寸」：前端 ComboWidget 换了选项会直接把 node.size
    // 写成内容高度（绕开所有扩展逻辑），这时 current 已经被改小了，拿它当下限等于认账。
    const floorWidth = Math.max(currentWidth, Number(manual?.[0]) || 0);
    const floorHeight = Math.max(currentHeight, Number(manual?.[1]) || 0);
    // 宽度：用户手动拖过就用他留的值（允许比内容窄——截断是他自己的选择，
    // 再拖宽随时可以），只在内容里含 DOM 面板时保住最小可用宽度。
    // 之前 max(floor, minimumWidth) 会把用户拖窄的节点在下次值变化时顶回内容宽。
    let width = allowShrink
        ? minimumWidth
        : manual && !hasLayoutSensitiveWidget(node)
        ? manual[0]
        : Math.max(floorWidth, minimumWidth);
    let height = heightOwnedByPortLayout
        ? currentHeight
        : customHeight
        ? currentHeight
        : heightLocked
        ? computed[1]
        : allowShrink ? minimumHeight : Math.max(floorHeight, minimumHeight);

    width = Math.max(width, minimumWidth);
    height = Math.max(height, minimumHeight);

    if (Math.abs(width - currentWidth) > 1 || Math.abs(height - currentHeight) > 1) {
        node.setSize?.([Math.ceil(width), Math.ceil(height)]);
        node.size = [Math.ceil(width), Math.ceil(height)];
        try {
            node.setDirtyCanvas?.(true, true);
        } catch {
            // The canvas can be unavailable while ComfyUI is creating nodes.
        }
        try {
            node.graph?.setDirtyCanvas?.(true, true);
        } catch {
            // The node may not be attached to a graph yet.
        }
        try {
            app.graph?.setDirtyCanvas?.(true, true);
        } catch {
            // Some ComfyUI builds throw if app.graph is read too early.
        }
    }
}

function scheduleFit(node, options = {}) {
    if (!isGuliNode(node)) {
        return;
    }

    const existingOptions = scheduledOptions.get(node) ?? {};
    scheduledOptions.set(node, {
        allowShrink: options.allowShrink !== false && existingOptions.allowShrink !== false,
    });

    if (scheduledNodes.has(node)) {
        return;
    }

    scheduledNodes.add(node);
    requestAnimationFrame(() => {
        scheduledNodes.delete(node);
        const pendingOptions = scheduledOptions.get(node) ?? {};
        scheduledOptions.delete(node);
        fitNode(node, pendingOptions);
    });
}

function installWidgetCallbacks(node) {
    for (const widget of node.widgets ?? []) {
        if (!widget || widget._ggAutoFitCallbackInstalled) {
            continue;
        }

        const originalCallback = widget.callback;
        widget.callback = function (...args) {
            const result = originalCallback?.apply(this, args);
            scheduleFit(node, { allowShrink: false });
            return result;
        };
        widget._ggAutoFitCallbackInstalled = true;
    }
}

app.registerExtension({
    name: "ComfyUI.GuliNodes.NodeAutoFit",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!isGuliNodeData(nodeData) || nodeType.prototype._ggAutoFitInstalled) {
            return;
        }

        nodeType.prototype._ggAutoFitInstalled = true;

        const originalComputeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (...args) {
            const size = originalComputeSize?.apply(this, args) ?? [this.size?.[0] ?? MIN_NODE_WIDTH, this.size?.[1] ?? MIN_NODE_HEIGHT];
            if (!isGuliNode(this) || hasMultilineTextWidget(this)) {
                // 含多行文本框的节点交回原生尺寸，保持可自由压低高度。
                return size;
            }
            const originalWidth = Number(size[0]) || MIN_NODE_WIDTH;
            const constrainedWidth = compactNodeWidth(this, originalWidth);
            return [constrainedWidth, Math.max(MIN_NODE_HEIGHT, Number(size[1]) || MIN_NODE_HEIGHT)];
        };

        const originalOnResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const result = originalOnResize?.apply(this, arguments);
            // 只有画布正握着这个节点的边在拖，才算用户自己定的尺寸。
            // ComfyUI 与其它扩展的布局也会走 onResize，把那些值记成手动尺寸，节点就再也收不回去了。
            const canvas = app?.canvas || globalThis.LGraphCanvas?.active_canvas;
            const liveSize = readNodeSize(this);
            if (canvas?.resizing_node === this && liveSize) {
                this[MANUAL_SIZE_FLAG] = [Math.round(Number(liveSize[0]) || 0), Math.round(Number(liveSize[1]) || 0)];
                // 持久化副本：读档时节点对象是新建的，内存标记要靠 properties 带回来。
                try {
                    if (!this.properties || typeof this.properties !== "object") this.properties = {};
                    this.properties._ggAutoFitUserSize = [this[MANUAL_SIZE_FLAG][0], this[MANUAL_SIZE_FLAG][1]];
                } catch {
                    // properties 不可写时退回内存标记路径
                }
            }
            return result;
        };

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = originalOnNodeCreated?.apply(this, args);
            initializedNodes.add(this);
            scheduleFit(this, { allowShrink: true });
            setTimeout(() => scheduleFit(this, { allowShrink: true }), 0);
            return result;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = originalOnConfigure?.apply(this, args);
            const isFirstLoad = !initializedNodes.has(this);
            if (isFirstLoad) {
                initializedNodes.add(this);
            }
            // 拖拽时写进 properties 的用户尺寸在这里认领：fitNode 的 floor 用
            // max(current, manual)，没有这一步读档后官方 refreshNode 会先按内容
            // 收回去、manual 就永远追不回来。
            const savedUser = this.properties?._ggAutoFitUserSize;
            if (Array.isArray(savedUser) && savedUser.length >= 2
                && Number(savedUser[0]) > 0 && Number(savedUser[1]) > 0) {
                this[MANUAL_SIZE_FLAG] = [Math.round(Number(savedUser[0])), Math.round(Number(savedUser[1]))];
            }
            // 工作流里存的就是上次的尺寸（用户可能特意拉过），加载后一律只增不减。
            scheduleFit(this, { allowShrink: false });
            setTimeout(() => scheduleFit(this, { allowShrink: false }), 0);
            return result;
        };
    },

    nodeCreated(node) {
        initializedNodes.add(node);
        scheduleFit(node, { allowShrink: true });
    },

    loadedGraphNode(node) {
        initializedNodes.add(node);
        // 重开工作流不许把节点缩回内容尺寸：用户拉出来的宽高要留住，
        // 否则每次打开工作流都得重新拉一遍。
        scheduleFit(node, { allowShrink: false });
        setTimeout(() => scheduleFit(node, { allowShrink: false }), 0);
    },
});

// 内容变化（控件显隐、端口增删）之后调用：允许把高度收回到内容尺寸。
// 加载路径默认只增不减，靠这条把「隐藏了一堆控件但节点还留着旧高度」的情况收回来；
// 用户手动拖过的节点（MANUAL_SIZE_FLAG）在 fitNode 里仍然只增不减。
//
// 必须同步跑 fitNode，不能走 scheduleFit：那个队列合并 allowShrink 时是「只降不升」
// （有一路说不许缩，整批就不许缩），而加载路径正好排着一路 allowShrink:false，
// 异步派发会被它盖掉、高度收不回来。
export function refitAfterContentChange(node) {
    fitNode(node, { allowShrink: true });
}
