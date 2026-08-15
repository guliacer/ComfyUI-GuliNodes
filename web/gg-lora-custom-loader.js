import { app } from "../../scripts/app.js";

const TARGET_CLASS = "GGLoRACustomLoader";
const COUNT_WIDGET_NAME = "LoRA数量";
const ADD_BUTTON_NAME = "新增LoRA";
const HIDDEN_TAG = "ggHiddenLoRA";
const MAX_LORAS = 20;
const widgetState = {};

function getWidget(node, name) {
    return node.widgets?.find((widget) => widget?.name === name) ?? null;
}

function getPair(node, index) {
    return {
        name: getWidget(node, `LoRA${index}名称`) ?? getWidget(node, `lora${index}_name`),
        strength: getWidget(node, `LoRA${index}强度`) ?? getWidget(node, `strength${index}`),
    };
}

function isHiddenWidget(widget) {
    if (!widget) {
        return true;
    }
    if (widget.hidden) {
        return true;
    }
    return String(widget.type ?? "").startsWith(HIDDEN_TAG);
}

function findInputForWidget(node, widget) {
    if (!node?.inputs?.length || !widget?.name) {
        return null;
    }

    return (
        node.inputs.find((input) => input?.widget?.name === widget.name)
        ?? node.inputs.find((input) => input?.name === widget.name)
        ?? null
    );
}

function ensureWidgetInputBinding(node, widget) {
    const input = findInputForWidget(node, widget);
    if (!input) {
        return null;
    }

    // 必须标记为 widget slot，否则会按“普通竖向输入”一直画出一串圆点。
    if (!input.widget || input.widget.name !== widget.name) {
        input.widget = { name: widget.name };
    }

    return input;
}

function doesInputWithNameLink(node, name, show) {
    return node.inputs
        ? node.inputs.some((input) => input.name === name && input.link != null && !show)
        : false;
}

function clearSlotPosition(input) {
    if (!input) {
        return;
    }
    delete input.pos;
}

function parkHiddenInputSlot(node, widget) {
    const input = ensureWidgetInputBinding(node, widget);
    if (!input) {
        return;
    }

    // 隐藏槽位不再参与竖向排布，也不保留旧的 y，避免圆点拖出节点外。
    clearSlotPosition(input);
    input._ggLoraHidden = true;

    // 部分前端会读取 alwaysVisible；隐藏时强制关掉。
    if ("alwaysVisible" in input) {
        input.alwaysVisible = false;
    }
}

function restoreInputSlot(node, widget) {
    const input = ensureWidgetInputBinding(node, widget);
    if (!input) {
        return;
    }

    delete input._ggLoraHidden;
    clearSlotPosition(input);
}

function toggleWidget(node, widget, show = false, suffix = "") {
    if (!widget || doesInputWithNameLink(node, widget.name, show)) {
        return;
    }

    if (!widgetState[widget.name]) {
        widgetState[widget.name] = {
            origType: widget.type,
            origComputeSize: widget.computeSize,
            origComputedHeight: widget.computedHeight,
        };
    }

    const state = widgetState[widget.name];
    widget.hidden = !show;
    widget.type = show ? state.origType : `${HIDDEN_TAG}${suffix}`;
    widget.computeSize = show ? state.origComputeSize : () => [0, -4];

    if (show) {
        if (state.origComputedHeight != null) {
            widget.computedHeight = state.origComputedHeight;
        } else {
            delete widget.computedHeight;
        }
        delete widget.y;
        delete widget.last_y;
        restoreInputSlot(node, widget);
    } else {
        widget.computedHeight = 0;
        widget.y = 0;
        widget.last_y = 0;
        parkHiddenInputSlot(node, widget);
    }

    widget.linkedWidgets?.forEach((linkedWidget) => {
        toggleWidget(node, linkedWidget, show, `:${widget.name}`);
    });
}

function cleanupHiddenSlots(node) {
    for (const widget of node.widgets ?? []) {
        if (!widget?.name) {
            continue;
        }

        // 只处理本节点的 LoRA 相关槽位 / 数量控件，避免误伤其他扩展加的 widget。
        const isLoraWidget = (
            widget.name === COUNT_WIDGET_NAME
            || /^LoRA\d+(名称|强度)$/.test(widget.name)
            || /^lora\d+_name$/.test(widget.name)
            || /^strength\d+$/.test(widget.name)
        );
        if (!isLoraWidget) {
            continue;
        }

        ensureWidgetInputBinding(node, widget);

        if (isHiddenWidget(widget)) {
            widget.hidden = true;
            widget.computedHeight = 0;
            widget.y = 0;
            widget.last_y = 0;
            if (!String(widget.type ?? "").startsWith(HIDDEN_TAG)) {
                if (!widgetState[widget.name]) {
                    widgetState[widget.name] = {
                        origType: widget.type,
                        origComputeSize: widget.computeSize,
                        origComputedHeight: widget.computedHeight,
                    };
                }
                widget.type = HIDDEN_TAG;
                widget.computeSize = () => [0, -4];
            }
            parkHiddenInputSlot(node, widget);
        }
    }

    // 二次清理：任何带 _ggLoraHidden 标记的 input 都去掉残留 pos。
    for (const input of node.inputs ?? []) {
        if (input?._ggLoraHidden) {
            clearSlotPosition(input);
            if ("alwaysVisible" in input) {
                input.alwaysVisible = false;
            }
        }
    }
}

function lockNodeHeight(node) {
    if (!node || !Array.isArray(node.size) || typeof node.computeSize !== "function") {
        return;
    }
    const contentHeight = node.computeSize()[1];
    if (Number.isFinite(contentHeight) && contentHeight > 0) {
        node.size[1] = Math.min(node.size[1], contentHeight);
    }
}

function installHeightLock(node) {
    if (node._ggLoraHeightLockInstalled) {
        return;
    }
    node._ggLoraHeightLockInstalled = true;

    const originalOnResize = node.onResize;
    node.onResize = function (...args) {
        const result = originalOnResize?.apply(this, args);
        cleanupHiddenSlots(this);
        lockNodeHeight(this);
        return result;
    };

    // arrange 会按 widget.y 回写 input.pos；隐藏槽需要在其后再次清掉。
    if (typeof node.arrange === "function" && !node._ggLoraArrangePatched) {
        const originalArrange = node.arrange.bind(node);
        node.arrange = function (...args) {
            const result = originalArrange(...args);
            cleanupHiddenSlots(this);
            return result;
        };
        node._ggLoraArrangePatched = true;
    }
}

function refreshNode(node) {
    cleanupHiddenSlots(node);

    if (typeof node.computeSize === "function") {
        const [width, height] = node.computeSize();
        const nextWidth = Math.max(Number(node.size?.[0]) || 0, width);
        const nextHeight = height;
        if (typeof node.setSize === "function") {
            node.setSize([nextWidth, nextHeight]);
        } else if (Array.isArray(node.size)) {
            node.size[0] = nextWidth;
            node.size[1] = nextHeight;
        }
    }

    try {
        node.arrange?.();
    } catch {
        // arrange 在节点尚未挂到 graph 时可能不可用
    }

    cleanupHiddenSlots(node);
    lockNodeHeight(node);

    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function normalizeVisibleCount(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return 0;
    }
    return Math.max(0, Math.min(MAX_LORAS, Math.trunc(parsed)));
}

function getVisibleCount(node) {
    const countWidget = getWidget(node, COUNT_WIDGET_NAME);
    return normalizeVisibleCount(countWidget?.value ?? 0);
}

function setVisibleCount(node, count) {
    const countWidget = getWidget(node, COUNT_WIDGET_NAME);
    if (!countWidget) {
        return;
    }

    const nextCount = normalizeVisibleCount(count);
    countWidget.value = nextCount;
    countWidget.callback?.(nextCount);
}

function updateSlotVisibility(node) {
    const visibleCount = getVisibleCount(node);

    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const { name, strength } = getPair(node, index);
        const show = index <= visibleCount;
        toggleWidget(node, name, show);
        toggleWidget(node, strength, show);
    }

    // 先同步一帧内布局，再在 rAF 里收一次，覆盖其他扩展的延后 fit。
    refreshNode(node);
    requestAnimationFrame(() => refreshNode(node));
}

function compactSlots(node) {
    const activeSlots = [];

    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const { name, strength } = getPair(node, index);
        const loraName = name?.value ?? "None";
        if (loraName !== "None") {
            activeSlots.push({
                name: loraName,
                strength: strength?.value ?? 1.0,
            });
        }
    }

    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const { name, strength } = getPair(node, index);
        const slot = activeSlots[index - 1];

        if (name) {
            name.value = slot?.name ?? "None";
        }
        if (strength) {
            strength.value = slot?.strength ?? 1.0;
        }
    }

    setVisibleCount(node, activeSlots.length);
    updateSlotVisibility(node);
}

function installSlotCallbacks(node) {
    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const { name, strength } = getPair(node, index);

        if (name && !name._ggLoraCallbackInstalled) {
            const originalNameCallback = name.callback;
            name.callback = function (value, ...args) {
                originalNameCallback?.call(this, value, ...args);
                if (value === "None") {
                    compactSlots(node);
                } else {
                    refreshNode(node);
                }
            };
            name._ggLoraCallbackInstalled = true;
        }

        if (strength && !strength._ggLoraCallbackInstalled) {
            const originalStrengthCallback = strength.callback;
            strength.callback = function (value, ...args) {
                originalStrengthCallback?.call(this, value, ...args);
                refreshNode(node);
            };
            strength._ggLoraCallbackInstalled = true;
        }
    }
}

function installAddButton(node) {
    if (node._ggAddButtonInstalled) {
        return;
    }

    // 避免重复添加按钮（setup 可能被多 hook 触发）
    const existing = getWidget(node, ADD_BUTTON_NAME);
    if (existing) {
        node._ggAddButtonInstalled = true;
        return;
    }

    const button = node.addWidget("button", ADD_BUTTON_NAME, ADD_BUTTON_NAME, () => {
        const currentCount = getVisibleCount(node);
        if (currentCount >= MAX_LORAS) {
            return;
        }
        setVisibleCount(node, currentCount + 1);
        updateSlotVisibility(node);
    });

    button.serializeValue = () => undefined;
    node._ggAddButtonInstalled = true;
}

function syncInitialState(node) {
    if (node._ggLoraInitialSyncDone) {
        return;
    }

    node._ggLoraInitialSyncDone = true;
    const activeCount = Array.from({ length: MAX_LORAS }, (_, offset) => offset + 1).filter((index) => {
        const { name } = getPair(node, index);
        return (name?.value ?? "None") !== "None";
    }).length;

    if (activeCount > getVisibleCount(node)) {
        setVisibleCount(node, activeCount);
    }
}

function setupNode(node) {
    if (!node || node.comfyClass !== TARGET_CLASS) {
        return;
    }

    const countWidget = getWidget(node, COUNT_WIDGET_NAME);
    if (!countWidget) {
        return;
    }

    syncInitialState(node);
    installHeightLock(node);
    toggleWidget(node, countWidget, false);
    installSlotCallbacks(node);
    installAddButton(node);
    updateSlotVisibility(node);
}

app.registerExtension({
    name: "ComfyUI.GuliNodes.LoRACustomLoader",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== TARGET_CLASS) {
            return;
        }

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalOnNodeCreated?.apply(this, arguments);
            setTimeout(() => setupNode(this), 0);
            return result;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = originalOnConfigure?.apply(this, arguments);
            // 加载工作流后允许重新同步可见数量
            this._ggLoraInitialSyncDone = false;
            setTimeout(() => setupNode(this), 0);
            return result;
        };
    },

    nodeCreated(node) {
        if (node.comfyClass !== TARGET_CLASS) {
            return;
        }
        setTimeout(() => setupNode(node), 0);
    },

    loadedGraphNode(node) {
        if (node.comfyClass !== TARGET_CLASS) {
            return;
        }
        node._ggLoraInitialSyncDone = false;
        setTimeout(() => setupNode(node), 0);
    },

    async afterConfigureGraph() {
        const nodes = app.graph?._nodes ?? app.graph?.nodes ?? [];
        for (const node of nodes) {
            if (node?.comfyClass === TARGET_CLASS) {
                node._ggLoraInitialSyncDone = false;
                setupNode(node);
            }
        }
    },
});
