import { watchNodeState } from "./gg-nodes2.js";
import { app } from "../../scripts/app.js";
import { refreshRowLayout } from "./gg-widget-rows.js";

// ---------------------------------------------------------------------------
// GG 简单数学表达式 —— 按需增长的输入 / 表达式 / 输出
//
// 后端一次把 a~z、表达式_1~10、结果_1~10 全声明完（前端 addInput 长出来的
// 端口必须在 INPUT_TYPES 里，否则 validate_inputs 会判成未知输入），这里只管
// 「显示几个」：
//   · 输入：默认 1 个；第 k 个接上线，就长出第 k+1 个。
//   · 表达式：条数 = max(1, 已接线的输入数, 已接线的输出数)。
//   · 输出：默认 2 个；第 k 个接上线，就长出第 k+1 个；且至少和表达式一样多。
// 输出 i 对应表达式 i，尾部永远多留一个没接线的输出供继续接线。
//
// 旧版本是 4 个固定输出（整数_1 / 浮点_1 / 整数_2 / 浮点_2）。FLOAT 输出已
// 删除，旧连线在这里迁移：浮点_1 → 结果_1、浮点_2 → 结果_2，整数_1/整数_2
// 留在 0/2 槽。只改 origin_slot，不动 link id，下游节点不用重连。
// ---------------------------------------------------------------------------

const NODE_NAME = "GGSimpleMath";
const INPUT_NAMES = Array.from({ length: 26 }, (_, index) => String.fromCharCode(97 + index));
const MAX_EXPRESSIONS = 10;
const MAX_OUTPUTS = 10;
const MIN_OUTPUTS = 2;
const HIDDEN_TYPE = "ggHiddenMathExpr";
const ANY_TYPE = "*";
const OUTPUT_NAME = (序号) => `结果_${序号}`;
const EXPR_NAME = (序号) => `表达式_${序号}`;

function isMathNode(node) {
    return !!node && (node.comfyClass ?? node.type) === NODE_NAME;
}

// 新版前端会把每个控件镜像成一条 input 条目（widget: {name}、link: null），
// 只按名字数端口会把 10 条表达式全当成输入端口。
function isRealInput(input) {
    return !!input && !input.widget && INPUT_NAMES.includes(String(input.name));
}

function mathInputs(node) {
    return (node?.inputs ?? []).filter(isRealInput);
}

function hasLink(output) {
    if (!output) {
        return false;
    }
    if (output.link != null) {
        return true;
    }
    return Array.isArray(output.links) && output.links.length > 0;
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

// 新版前端 graph.links 是 LinkMap（Map 子类），旧版是数组或 id→link 对象。
function graphLinks(graph) {
    const links = graph?.links;
    if (!links) {
        return [];
    }
    if (typeof links.values === "function") {
        return Array.from(links.values());
    }
    return Array.isArray(links) ? links : Object.values(links);
}

function linkOriginId(link) {
    return link?.origin_id ?? link?._state?.originNodeId ?? null;
}

function linkOriginSlot(link) {
    return link?.origin_slot ?? link?._state?.originSlot ?? null;
}

// 新版前端的 Link.origin_slot 是 setter：赋值会同步 _state.originSlot 和两端
// output.links / input.link。绝不能绕过它去手写 _state 或重建 links 数组，
// 那会让前后端状态对不上、连线在下一帧被整条删掉。
function setLinkOriginSlot(link, slot) {
    if (link && slot != null && slot >= 0) {
        link.origin_slot = slot;
    }
}

// 旧版本 4 个输出：整数_1 / 浮点_1 / 整数_2 / 浮点_2。FLOAT 端口已删除，
// 旧连线要改指到对应结果槽：浮点_1(slot 1) → 结果_1(slot 0)、
// 浮点_2(slot 3) → 结果_2(slot 2)，整数_1/整数_2 本来就在 0/2。
//
// 不能走 removeOutput —— 它会 disconnectOutput 把连线删掉；也不能只认
// output.name：新版前端 configure 会按 nodeType 的 RETURN_NAMES 重建名字，
// 旧名字在画布上已经看不到了，得靠 onConfigure 里存下来的存档信息认。
function migrateLegacyOutputs(node) {
    if (node._ggMathOutputsMigrated) {
        return;
    }
    const outputs = node.outputs ?? [];
    const legacyNames = outputs.some(
        (output) => /^(整数|浮点)_\d+$/.test(String(output?.name ?? "")),
    );
    const legacy = legacyNames || node._ggMathLegacyHint === true;
    node._ggMathOutputsMigrated = true;
    if (!legacy) {
        return;
    }

    const graph = node.graph ?? app.graph;
    for (const link of graphLinks(graph)) {
        if (!link || String(linkOriginId(link)) !== String(node.id)) {
            continue;
        }
        const slot = linkOriginSlot(link);
        // 只搬旧版的浮点槽；整数_1(slot 0) / 整数_2(slot 2) 本来就落在正确位置，
        // 新版工作流的 slot 1/3 是合法连线，靠 _ggMathLegacyHint 区分，不会误搬。
        const target = slot === 1 ? 0 : slot === 3 ? 2 : -1;
        if (target >= 0) {
            setLinkOriginSlot(link, target);
        }
    }
    node.setDirtyCanvas?.(true, true);
    graph?.setDirtyCanvas?.(true, true);
    // 迁移改了 origin_slot，后面必须按新槽位重新算一遍
    node._ggMathStateKey = null;
}

function normalizeInputs(node, wanted) {
    const drop = [];
    (node.inputs ?? []).forEach((input, index) => {
        if (!isRealInput(input)) {
            return;
        }
        const order = INPUT_NAMES.indexOf(String(input.name));
        if (order >= wanted && input.link == null) {
            drop.push(index);
        }
    });
    for (const index of drop.reverse()) {
        node.removeInput?.(index);
    }

    const present = new Set(node.inputs.filter(isRealInput).map((input) => String(input.name)));
    for (let index = 0; index < wanted; index += 1) {
        if (!present.has(INPUT_NAMES[index]) && node.addInput) {
            node.addInput(INPUT_NAMES[index], ANY_TYPE);
        }
    }
}

function normalizeOutputs(node, wanted) {
    for (let slot = (node.outputs?.length ?? 0) - 1; slot >= wanted; slot -= 1) {
        if (!hasLink(node.outputs[slot])) {
            node.removeOutput?.(slot);
        }
    }
    while ((node.outputs?.length ?? 0) < wanted && node.addOutput) {
        node.addOutput(OUTPUT_NAME(node.outputs.length + 1), ANY_TYPE);
    }
    // 老工作流里可能残留旧名字，统一改回「结果_i」，类型统一成通配数值
    (node.outputs ?? []).forEach((output, index) => {
        output.name = OUTPUT_NAME(index + 1);
        output.type = ANY_TYPE;
    });
}

function expressionWidgets(node) {
    const result = [];
    for (let index = 1; index <= MAX_EXPRESSIONS; index += 1) {
        const widget = (node.widgets ?? []).find((item) => item?.name === EXPR_NAME(index));
        if (widget) {
            result.push({ index, widget });
        }
    }
    return result;
}

function isWiredWidget(node, widget) {
    return (node.inputs ?? []).some(
        (input) => input?.widget?.name === widget?.name && input.link != null,
    );
}

// 控件一旦被转成输入端口并接线，显隐就归前端管：只还原类型与尺寸，
// 绝不碰 hidden（否则断开后前端放不开）。还原顺序同样有讲究，见下。
function releaseWidget(widget) {
    if (!widget) {
        return;
    }
    if (widget._ggMathHidden) {
        widget.type = widget._ggMathType ?? "text";
        widget.computeSize = widget._ggMathComputeSize;
        if (!widget._ggMathComputeSize) {
            delete widget.computeSize;
        }
    }
    delete widget._ggMathHidden;
    delete widget._ggMathType;
    delete widget._ggMathComputeSize;
    delete widget._ggMathReleased;
}

function setWidgetVisible(widget, visible) {
    if (!widget) {
        return;
    }
    if (visible) {
        if (!widget._ggMathHidden) {
            return;
        }
        // 显示时先还原 type，再放开 hidden；反序会被前端按隐藏类型重新派生可见性。
        widget.type = widget._ggMathType ?? "text";
        widget.computeSize = widget._ggMathComputeSize;
        if (!widget._ggMathComputeSize) {
            delete widget.computeSize;
        }
        delete widget._ggMathHidden;
        delete widget._ggMathType;
        delete widget._ggMathComputeSize;
        widget.hidden = false;
        return;
    }
    if (widget._ggMathHidden) {
        return;
    }
    widget._ggMathHidden = true;
    widget._ggMathType = widget.type;
    widget._ggMathComputeSize = widget.computeSize;
    // 隐藏时先写 hidden 再换 type。
    widget.hidden = true;
    widget.type = HIDDEN_TYPE;
    widget.computeSize = () => [0, -4];
}

function normalizeExpressions(node, wanted) {
    for (const { index, widget } of expressionWidgets(node)) {
        if (isWiredWidget(node, widget)) {
            releaseWidget(widget);
            continue;
        }
        setWidgetVisible(widget, index <= wanted);
    }
}

function syncNode(node, force = false) {
    if (!isMathNode(node) || node._ggMathBusy || !node.graph) {
        return;
    }
    node._ggMathBusy = true;
    try {
        migrateLegacyOutputs(node);

        const inputs = mathInputs(node);
        let highestInput = -1;
        let connectedInputs = 0;
        for (const input of inputs) {
            if (input.link == null) {
                continue;
            }
            connectedInputs += 1;
            highestInput = Math.max(highestInput, INPUT_NAMES.indexOf(String(input.name)));
        }

        let highestOutput = -1;
        let connectedOutputs = 0;
        (node.outputs ?? []).forEach((output, index) => {
            if (!hasLink(output)) {
                return;
            }
            connectedOutputs += 1;
            highestOutput = Math.max(highestOutput, index);
        });

        const inputCount = clamp(Math.max(1, highestInput + 2), 1, INPUT_NAMES.length);
        const exprCount = clamp(Math.max(1, connectedInputs, connectedOutputs), 1, MAX_EXPRESSIONS);
        const outputCount = clamp(
            Math.max(MIN_OUTPUTS, exprCount, highestOutput + 2),
            MIN_OUTPUTS,
            MAX_OUTPUTS,
        );
        const key = `${inputCount}|${exprCount}|${outputCount}|${connectedInputs}|${highestOutput}`;
        if (!force && node._ggMathStateKey === key) {
            return;
        }
        const changed = node._ggMathStateKey !== key;
        node._ggMathStateKey = key;

        normalizeInputs(node, inputCount);
        normalizeOutputs(node, outputCount);
        normalizeExpressions(node, exprCount);

        if (changed) {
            refreshRowLayout(node);
            node.setDirtyCanvas?.(true, true);
            node.graph?.setDirtyCanvas?.(true, true);
        }
    } finally {
        node._ggMathBusy = false;
    }
}

function schedule(node, force = false) {
    if (!isMathNode(node)) {
        return;
    }
    watchNodeState(node, "simple-math", enabled => { if (enabled) syncNode(node); });
    if (node._ggMathTimer) {
        clearTimeout(node._ggMathTimer);
    }
    node._ggMathTimer = setTimeout(() => {
        node._ggMathTimer = null;
        syncNode(node, force);
    }, 0);
}

app.registerExtension({
    name: "ComfyUI.GGNodes.SimpleMathDynamic",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME || nodeType.prototype._ggMathPatched) {
            return;
        }
        nodeType.prototype._ggMathPatched = true;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = originalOnNodeCreated?.apply(this, args);
            schedule(this, true);
            return result;
        };

        // 老存档只有 2 条表达式值，而新节点有 10 条 required 文本控件。
        // 新版前端按控件数重建 inputs 里的控件镜像条目时不补齐，会把连线的
        // target_slot 打乱 —— 实测整条连线在 configure 阶段就被丢掉。
        // 所以必须在原始 configure 之前把 widgets_values 补到 10 个（前两个
        // 保留用户原值，后面按默认变量补齐），并记下「这是老工作流」。
        const originalConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info, ...rest) {
            const values = info?.widgets_values;
            const shortValues = Array.isArray(values) && values.length < MAX_EXPRESSIONS;
            const names = (info?.outputs ?? []).map((output) => String(output?.name ?? ""));
            const legacy = names.some((name) => /^(整数|浮点)_\d+$/.test(name)) || shortValues;
            this._ggMathLegacyHint = legacy;
            if (legacy) {
                // configure 可能跑在同一个节点上多次，迁移要重新允许一次
                this._ggMathOutputsMigrated = false;
            }
            if (shortValues) {
                const padded = values.slice();
                while (padded.length < MAX_EXPRESSIONS) {
                    padded.push(INPUT_NAMES[padded.length]);
                }
                info.widgets_values = padded;
            }
            return originalConfigure?.call(this, info, ...rest);
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info, ...rest) {
            const result = originalOnConfigure?.call(this, info, ...rest);
            // 存档里的连线在 configure 之后才齐，迁移必须排在它后面
            this._ggMathStateKey = null;
            schedule(this, true);
            return result;
        };

        // 接线/断线要强制重算：数量没变时缓存会命中，但前端对「已接线控件」
        // 的 hidden 接管范围已经变了。
        const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (...args) {
            const result = originalOnConnectionsChange?.apply(this, args);
            schedule(this, true);
            return result;
        };

        // 兜底：Vue 渲染下部分连线变化不触发 onConnectionsChange，
        // 绘制时按状态串比一次，没变化就只是一次字符串比较。
        const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (...args) {
            const result = originalOnDrawForeground?.apply(this, args);
            syncNode(this);
            return result;
        };
    },

    nodeCreated(node) {
        if (isMathNode(node)) schedule(node, true);
    },

    loadedGraphNode(node) {
        if (isMathNode(node)) schedule(node, true);
    },
});
