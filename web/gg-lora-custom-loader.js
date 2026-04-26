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
        name: getWidget(node, `lora${index}_name`),
        strength: getWidget(node, `strength${index}`),
    };
}

function doesInputWithNameLink(node, name, show) {
    return node.inputs ? node.inputs.some((input) => input.name === name && input.link && !show) : false;
}

function toggleWidget(node, widget, show = false, suffix = "") {
    if (!widget || doesInputWithNameLink(node, widget.name, show)) {
        return;
    }

    if (!widgetState[widget.name]) {
        widgetState[widget.name] = {
            origType: widget.type,
            origComputeSize: widget.computeSize,
        };
    }

    widget.hidden = !show;
    widget.type = show ? widgetState[widget.name].origType : `${HIDDEN_TAG}${suffix}`;
    widget.computeSize = show ? widgetState[widget.name].origComputeSize : () => [0, -4];

    widget.linkedWidgets?.forEach((linkedWidget) => toggleWidget(node, linkedWidget, show, `:${widget.name}`));
}

function refreshNode(node) {
    const height = node.computeSize()[1];
    node.setSize([node.size[0], height]);
    node.setDirtyCanvas(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
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
    const countWidget = getWidget(node, COUNT_WIDGET_NAME);
    if (!countWidget) {
        return;
    }

    syncInitialState(node);
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
        setTimeout(() => setupNode(node), 0);
    },
});
