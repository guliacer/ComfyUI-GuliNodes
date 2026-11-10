// GG 文本反推 · 长文本区高度策略（设计稿 39:1 / 40:1 的 04 落点规格表落地）。
//
// 为什么必须单独做：本机前端对同一个节点里的多个 `customtext` 采用「弹性平分
// 节点剩余高度」——把其中一个撑高，其余三个会被自动压矮（实测 150 让另外三个
// 从 87.5 掉到 65.3），于是四个文本框互相挤压、溢出到相邻行。
//
// 落地方式：只包装这 4 个 widget 的 `computeSize`，返回按定稿行数算出的固定高度。
// 官方会据此自动完成 ① 每帧写 computedHeight ② 重排 widget.y ③ 同步 textarea DOM
// 高度 ④ 重算节点 computeSize。整条链不需要我们手动 setSize / 改 properties /
// 写 widgets_values，因此不触碰「节点尺寸归属」红线，用户拖出来的高度仍归用户。
//
// 幂等与回退：保存原 computeSize、重复安装不叠加、DOM 未就绪时下一帧重试；
// 设置项 GuliNodes.enableReverseTextHeights 关掉后恢复原函数与原始 DOM 样式。
import { app } from "../../scripts/app.js";

const NODE_NAME = "GGWebAIReverseText";
const SETTING_ID = "GuliNodes.enableReverseTextHeights";
const PATCHED = Symbol.for("GuliNodes.reverseTextHeights.patched");

// 真机基线：默认 2 行的 textarea 是 67.5px、widget 占高 87.5px，
// 即 widget 高 = 47.5 + 行数 × 20。这样行数规格与官方 DOM 行高天然对齐。
const WIDGET_BASE = 47.5;
const ROW_PX = 20;
// 注：官方 DomWidget 会把 computeSize()[1] 再加 4px 才写进 computedHeight
// （实测 150→154 / 110→114 / 90→94）。这是宿主固定开销，不是我们的误差，
// 回归脚本的同步性判据要按 declared + 4 来断言。

// 04 规格表：默认行 / 最小 textarea 高 / 最大行 / 策略 / 分组。
// 「自适应」= 内容变多时自动增行到上限；「折叠」= 固定默认行，超出靠「展开」。
// 提取规则与总结要求同组，默认行数刻意一致（都是 4 行），避免一高一矮。
const SPEC = {
    "小说内容": { rows: 6, minPx: 54, maxRows: 12, strategy: "auto", group: "输入源" },
    "提取规则": { rows: 4, minPx: 54, maxRows: 12, strategy: "fold", group: "提取规则" },
    "总结要求": { rows: 4, minPx: 54, maxRows: 10, strategy: "fold", group: "提取规则" },
    "系统提示词": { rows: 3, minPx: 40, maxRows: 8, strategy: "fold", group: "高级" },
};

const widgetHeight = (rows) => WIDGET_BASE + rows * ROW_PX;

function settingEnabled() {
    try {
        const v = app.ui?.settings?.getSettingValue?.(SETTING_ID);
        return v !== false;
    } catch {
        return true;
    }
}

function isTarget(node) {
    return node?.comfyClass === NODE_NAME || node?.type === NODE_NAME;
}

function targetWidgets(node) {
    if (!Array.isArray(node?.widgets)) return [];
    return node.widgets.filter((w) => w && Object.hasOwn(SPEC, w.name) && w.type === "customtext");
}

function textareaOf(widget) {
    const el = widget?.element;
    if (el?.tagName === "TEXTAREA") return el;
    return el?.querySelector?.("textarea") ?? null;
}

// ---------------------------------------------------------------- DOM 交互层

function ensureExpandButton(widget, node) {
    const ta = textareaOf(widget);
    const host = ta?.parentElement;
    if (!ta || !host) return null;
    let btn = host.querySelector(":scope > .gg-rt-expand");
    if (btn) return btn;

    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gg-rt-expand";
    btn.textContent = "展开";
    btn.title = "展开到最大行数（失焦后回到默认行数）";
    Object.assign(btn.style, {
        position: "absolute", right: "6px", bottom: "5px", zIndex: "2",
        height: "18px", padding: "0 7px",
        border: "1px solid var(--gg-divider, #475569)",
        borderRadius: "6px",
        background: "var(--gg-panel, #1f2937)",
        color: "var(--gg-ink, #e5e7eb)",
        font: "10px/1 system-ui, sans-serif",
        cursor: "pointer", display: "none",
    });
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        widget._ggRtRows = SPEC[widget.name].maxRows;
        syncWidget(widget, node);
    });
    // 宿主是官方 DomWidget 的 fixed 容器，本身已带 position；补一次保险。
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.appendChild(btn);
    return btn;
}

function syncDom(widget) {
    const cfg = SPEC[widget.name];
    if (!cfg) return null;
    const ta = textareaOf(widget);
    if (!ta) return null;

    if (!widget._ggRtOriginalStyle) {
        widget._ggRtOriginalStyle = {
            overflowY: ta.style.overflowY,
            minHeight: ta.style.minHeight,
            resize: ta.style.resize,
        };
    }
    // 被裁时不用滚动条：内容超出直接裁掉，右下角给「展开」。
    ta.style.overflowY = "hidden";
    ta.style.minHeight = `${cfg.minPx}px`;
    ta.style.resize = "none";

    const btn = ensureExpandButton(widget, widget._ggRtNode);
    const expanded = Number(widget._ggRtRows) >= cfg.maxRows;
    const clipped = ta.scrollHeight > ta.clientHeight + 2;
    if (btn) btn.style.display = clipped && !expanded ? "block" : "none";
    return { clipped, expanded };
}

function syncWidget(widget, node) {
    if (node) widget._ggRtNode = node;
    syncDom(widget);
    node?.setDirtyCanvas?.(true, true);
    node?.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function attachEvents(widget, node) {
    const ta = textareaOf(widget);
    if (!ta || widget._ggRtEventsBound) return;
    widget._ggRtEventsBound = true;
    const cfg = SPEC[widget.name];
    const originalRows = cfg.rows;

    const onFocus = () => {
        // 共性规则：进入编辑态允许撑到上限。
        widget._ggRtRows = cfg.maxRows;
        syncWidget(widget, node);
    };
    const onBlur = () => {
        // 共性规则：失焦回到默认行数。
        widget._ggRtRows = originalRows;
        syncWidget(widget, node);
    };
    const onInput = () => {
        if (cfg.strategy !== "auto") {
            syncDom(widget);
            return;
        }
        // 自适应：内容驱动增行，但不超过上限，也不低于默认行。
        const needed = Math.ceil((ta.scrollHeight - WIDGET_BASE) / ROW_PX);
        widget._ggRtRows = Math.min(cfg.maxRows, Math.max(originalRows, needed));
        syncWidget(widget, node);
    };

    ta.addEventListener("focus", onFocus);
    ta.addEventListener("blur", onBlur);
    ta.addEventListener("input", onInput);
    widget._ggRtHandlers = { onFocus, onBlur, onInput };
}

// ---------------------------------------------------------------- 安装 / 卸载

function install(node) {
    if (!isTarget(node)) return;
    if (!settingEnabled()) {
        uninstall(node);
        return;
    }
    for (const widget of targetWidgets(node)) {
        if (!widget._ggRtOriginalComputeSize) {
            widget._ggRtOriginalComputeSize = widget.computeSize;
        }
        if (widget.computeSize?.[PATCHED]) continue;

        const original = widget._ggRtOriginalComputeSize;
        const wrapped = function (width) {
            let computed = null;
            try {
                computed = original?.call(this, width);
            } catch {
                // 第三方 widget 可能要等 DOM 就绪才能测量，忽略即可。
            }
            const w = Number(computed?.[0]);
            const measured = [Number.isFinite(w) && w > 0 ? w : Number(width) || 0, Number(computed?.[1]) || 0];
            // 用户运行时把端口列表收起后，gg-port-list-toggle.js 会接管多行控件
            // 高度做紧凑布局。此时让位，避免两套补丁叠在同一个 computeSize 上。
            if (portListHidden(this._ggRtNode)) return measured;
            const rows = Number(this._ggRtRows) || SPEC[this.name].rows;
            measured[1] = widgetHeight(rows);
            return measured;
        };
        wrapped[PATCHED] = true;
        widget.computeSize = wrapped;
        widget._ggRtComputeSize = wrapped;
        widget._ggRtRows = SPEC[widget.name].rows;
        widget._ggRtNode = node;
    }

    // DOM 层要等官方 DomWidget 挂进文档才有 textarea，分帧重试但最多 10 次。
    let tries = 0;
    const bind = () => {
        if (!node.graph || !settingEnabled()) return;
        let ready = 0;
        for (const widget of targetWidgets(node)) {
            if (textareaOf(widget)) {
                attachEvents(widget, node);
                syncDom(widget);
                ready += 1;
            }
        }
        if (ready < Object.keys(SPEC).length && tries++ < 10) requestAnimationFrame(bind);
    };
    requestAnimationFrame(bind);

    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

function uninstall(node) {
    for (const widget of targetWidgets(node)) {
        const ta = textareaOf(widget);
        if (ta && widget._ggRtHandlers) {
            ta.removeEventListener("focus", widget._ggRtHandlers.onFocus);
            ta.removeEventListener("blur", widget._ggRtHandlers.onBlur);
            ta.removeEventListener("input", widget._ggRtHandlers.onInput);
        }
        if (ta && widget._ggRtOriginalStyle) {
            ta.style.overflowY = widget._ggRtOriginalStyle.overflowY;
            ta.style.minHeight = widget._ggRtOriginalStyle.minHeight;
            ta.style.resize = widget._ggRtOriginalStyle.resize;
        }
        ta?.parentElement?.querySelector?.(":scope > .gg-rt-expand")?.remove();
        if (widget.computeSize?.[PATCHED] && widget._ggRtOriginalComputeSize) {
            widget.computeSize = widget._ggRtOriginalComputeSize;
        }
        delete widget._ggRtComputeSize;
        delete widget._ggRtRows;
        delete widget._ggRtHandlers;
        delete widget._ggRtEventsBound;
        delete widget._ggRtOriginalStyle;
        delete widget._ggRtNode;
    }
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

// 端口列表隐藏时 gg-port-list-toggle.js 会自行接管多行控件高度（紧凑布局）。
// 那时让位给它，避免两套补丁叠在同一个 computeSize 上互相打架。
function portListHidden(node) {
    return node?.properties?.["_gg_port_list_hidden"] === true;
}

app.registerExtension({
    name: "ComfyUI.GGNodes.ReverseTextHeights",
    settings: [
        {
            id: SETTING_ID,
            name: "文本反推长文本区按规格分行",
            tooltip: "按设计稿给小说内容/提取规则/总结要求/系统提示词分配默认行数，编辑态撑到上限、失焦回默认，被裁用「展开」不用滚动条",
            type: "boolean",
            defaultValue: true,
            onChange(value) {
                for (const node of app.graph?._nodes ?? []) {
                    if (!isTarget(node)) continue;
                    if (value) install(node);
                    else uninstall(node);
                }
            },
        },
    ],
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;
        const hookLifecycle = (method) => {
            const original = nodeType.prototype[method];
            nodeType.prototype[method] = function (...args) {
                const result = original?.apply(this, args);
                setTimeout(() => {
                    if (portListHidden(this)) return;
                    install(this);
                }, 0);
                return result;
            };
        };
        hookLifecycle("onNodeCreated");
        hookLifecycle("onConfigure");
    },
    loadedGraphNode(node) {
        if (!isTarget(node) || portListHidden(node)) return;
        setTimeout(() => install(node), 0);
    },
});
