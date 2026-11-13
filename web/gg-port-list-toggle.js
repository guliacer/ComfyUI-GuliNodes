import { isNodes2, watchNodeState } from "./gg-nodes2.js";
import { app } from "../../scripts/app.js";
import { ggIcon } from "./gg-ui-icons.js";
import { applySurface, ensureGGDesign, detectHostTheme, PALETTES } from "./gg-ui-design.js";
import {
    DEFAULT_MULTILINE_WIDGET_HEIGHT,
    MIN_MULTILINE_WIDGET_HEIGHT,
    getVisibleContentHeight,
    normalizeMultilineHeight,
    shouldLockHiddenNodeSize,
} from "./gg-port-list-layout.js";

const SETTING_ID = "GuliNodes.enablePortListToggle";
const COLLAPSE_SETTING_ID = "GuliNodes.enableNodeCollapseButton";
const PIN_SETTING_ID = "GuliNodes.enableNodePinButton";
const COLLAPSE_WIDTH_SETTING_ID = "GuliNodes.nodeCollapseWidthPadding";
const STATE_PROPERTY = "_gg_port_list_hidden";
const MULTILINE_MANUAL_PROPERTY = "_gg_multiline_manual_size";
// 多行文本框的手动高度记忆，按控件名持久化在节点 properties 里，
// 隐藏端口、切换显示、保存并重开工作流后都保持一致。
const MULTILINE_HEIGHT_PROPERTY = "_gg_multiline_heights";
// 拖动尺寸手势标志的兜底超时：松手后若再无 onResize 可消费，标志必须自动失效，
// 否则后续任何布局引起的尺寸变化都会被误判为用户手动调整。
const RESIZE_GESTURE_TIMEOUT_MS = 3000;
const TOP_BUTTON_ID = "gg-port-list-toggle-button";
const COLLAPSE_TOP_BUTTON_ID = "gg-node-collapse-button";
const PIN_TOP_BUTTON_ID = "gg-node-pin-button";
const COLLAPSE_SETTINGS_PANEL_ID = "gg-node-collapse-settings-panel";
const COLLAPSE_SETTINGS_PANEL_WIDTH = 320;
// 设计稿 9:259 共存示意定稿：20×20 / r6 / 图标 13 / 间距 3 / 距右边缘 6。
// 命中区由 getButtonRect() 单一派生，改这里绘制与点击会同步变化。
const BUTTON_SIZE = 20;
const BUTTON_RADIUS = 6;
const BUTTON_RIGHT = 6;
const BUTTON_GAP = 3;
const BUTTON_HIT_PADDING = 3;
// 与节点原生标题按钮（如子图查看按钮）之间的横向间距。
const NATIVE_BUTTON_GAP = 6;
// 设计稿 4:259 标题栏按钮三档降级阈值（展开态节点宽度）。
const TITLE_BUTTON_FULL_WIDTH = 300;          // ≥300 三枚全显
const TITLE_BUTTON_NO_PIN_WIDTH = 240;        // 240–299 撤置顶（低频），留折叠+端口
const TITLE_BUTTON_COLLAPSE_ONLY_WIDTH = 180; // 180–239 只留折叠（唯一有状态回报）
// <180 一枚都不画，功能全部收进右键菜单
const TITLE_BUTTON_SHRINK_SIZE = 16;          // 180–239 档按钮缩小尺寸
const NODE_DRAW_PATCHED = Symbol.for("GuliNodes.portListToggle.nodeDrawPatched");
const CANVAS_DRAW_NODE_PATCHED = Symbol.for("GuliNodes.portListToggle.canvasDrawNodePatched");
const NODE_RESIZE_PATCHED = Symbol.for("GuliNodes.portListToggle.nodeResizePatched");
const NODE_COMPUTE_SIZE_PATCHED = Symbol.for("GuliNodes.portListToggle.nodeComputeSizePatched");

const SIZE_EPSILON = 0.5;
const COMPACT_BOTTOM_PADDING = 10;
const DEFAULT_WIDGET_HEIGHT = 24;
const MIN_NODE_HEIGHT = 44;
const COMPACT_WIDGET_TOP = 2;
const COMPACT_WIDGET_GAP = 4;
const TEXT_WIDGET_LAYOUT_PATCHED = Symbol.for("GuliNodes.portListToggle.textWidgetLayoutPatched");

let featureEnabled = false;
let collapseFeatureEnabled = true;
let pinFeatureEnabled = true;
let topButton = null;
let collapseTopButton = null;
let collapseTopHost = null;
let collapseSettingsButton = null;
let collapseSettingsPanel = null;
let pinTopButton = null;
let pinTopHost = null;
let topHostObserver = null;
let canvasPatchTimer = null;
let buttonTooltip = null;
let buttonTooltipTimer = null;

function getSettingValue(id, fallback) {
    try {
        const value = app.extensionManager?.setting?.get?.(id);
        if (value !== undefined) return value;
    } catch (error) {
        console.warn("[GGPortListToggle] Unable to read setting:", id, error);
    }

    try {
        return app.ui?.settings?.getSettingValue?.(id, fallback) ?? fallback;
    } catch {
        return fallback;
    }
}

async function setSettingValue(id, value) {
    try {
        if (app.extensionManager?.setting?.set) {
            await app.extensionManager.setting.set(id, value);
            return;
        }
    } catch (error) {
        console.warn("[GGPortListToggle] Unable to write extension setting:", id, error);
    }

    try {
        app.ui?.settings?.setSettingValue?.(id, value);
    } catch (error) {
        console.warn("[GGPortListToggle] Unable to write UI setting:", id, error);
    }
}

function portCount(value) {
    if (Array.isArray(value)) return value.length;
    const length = Number(value?.length);
    return Number.isFinite(length) && length > 0 ? length : 0;
}

function cachePortState(node) {
    if (!node || node._ggPortListDrawingHidden) return node?._ggPortListHasPorts === true;
    const inputCount = portCount(node.inputs);
    const outputCount = portCount(node.outputs);
    node._ggPortListInputCount = inputCount;
    node._ggPortListOutputCount = outputCount;
    node._ggPortListHasPorts = inputCount > 0 || outputCount > 0;
    return node._ggPortListHasPorts;
}

function nodeHasPorts(node) {
    if (!node) return false;
    if (node._ggPortListDrawingHidden) return node._ggPortListHasPorts === true;
    return cachePortState(node);
}

function readHiddenState(node) {
    return node?._ggPortListHidden === true
        || node?.properties?.[STATE_PROPERTY] === true;
}

function readMultilineManualState(node) {
    // Session-only flag. The persisted variant used to survive across
    // reloads and forced every later toggle into "textarea fills the node"
    // mode, which is how nodes ended up permanently stretched. Textarea
    // heights are persisted separately via MULTILINE_HEIGHT_PROPERTY now.
    return node?._ggPortListMultilineManualSizeObserved === true;
}

function markHiddenLayoutPending(node) {
    if (!node) return;
    node._ggPortListLayoutPending = true;
}

function setMultilineManualState(node, manual) {
    if (!node) return;
    node._ggPortListMultilineManualSizeObserved = Boolean(manual);
}

function isMultilineLayoutActive(node) {
    return Boolean(
        node
        && featureEnabled
        && readHiddenState(node)
        && !isNodeCollapsed(node),
    );
}

function getMultilineMemoryKey(widget, index) {
    const name = typeof widget?.name === "string" ? widget.name.trim() : "";
    return name || `w${index}`;
}

function readManualHeightMap(node) {
    const stored = node?.properties?.[MULTILINE_HEIGHT_PROPERTY];
    return stored && typeof stored === "object" && !Array.isArray(stored)
        ? { ...stored }
        : {};
}

function writeManualHeightMap(node, map) {
    if (!node) return;
    if (!node.properties || typeof node.properties !== "object") node.properties = {};
    const keys = Object.keys(map);
    if (keys.length) node.properties[MULTILINE_HEIGHT_PROPERTY] = map;
    else delete node.properties[MULTILINE_HEIGHT_PROPERTY];
    // properties 的变更需要触发一次图变更才会被序列化保存。
    node.graph?.change?.();
}

// 把记忆里的手动高度应用到文本控件。这是文本框高度唯一的常规来源：
// 不从节点高度反推，因此文本框与节点高度之间不存在互相喂养的循环。
function applyMultilineMemory(node) {
    if (!node || !Array.isArray(node.widgets)) return;
    const textWidgets = getMultilineWidgets(node);
    if (!textWidgets.length) return;
    const memory = readManualHeightMap(node);
    for (let index = 0; index < textWidgets.length; index++) {
        const widget = textWidgets[index];
        const key = getMultilineMemoryKey(widget, index);
        const height = normalizeMultilineHeight(
            memory[key] ?? DEFAULT_MULTILINE_WIDGET_HEIGHT,
        );
        widget._ggPortListTextHeight = height;
        syncMultilineWidgetElement(widget, height);
    }
}

// 拖动开始时记录锚点：节点高度与各文本框当时的记忆高度。
function beginManualResizeAnchor(node) {
    if (!isMultilineLayoutActive(node) || node._ggPortListResizeAnchor) return;
    const textWidgets = getMultilineWidgets(node);
    if (!textWidgets.length) return;
    node._ggPortListResizeAnchor = {
        height: Number(node.size?.[1]) || 0,
        heights: new Map(textWidgets.map((widget) => [
            widget,
            Number(widget._ggPortListTextHeight) || DEFAULT_MULTILINE_WIDGET_HEIGHT,
        ])),
    };
}

// 拖动过程中让文本框高度跟随节点高度增量实时变化：
// 拖高时文本框长高，拖矮时文本框跟着缩短，节点最小高度随之下移，
// 因此节点永远可以拖回紧凑尺寸——文本框不会被记忆值定死。
function trackManualResize(node) {
    if (!isMultilineLayoutActive(node)) return;
    const anchor = node._ggPortListResizeAnchor;
    const textWidgets = getMultilineWidgets(node);
    if (!anchor || !textWidgets.length) return;
    const delta = (Number(node.size?.[1]) || 0) - anchor.height;
    const perWidgetDelta = delta / textWidgets.length;
    for (let index = 0; index < textWidgets.length; index++) {
        const widget = textWidgets[index];
        const base = anchor.heights.get(widget) ?? DEFAULT_MULTILINE_WIDGET_HEIGHT;
        const next = normalizeMultilineHeight(base + perWidgetDelta);
        widget._ggPortListTextHeight = next;
        syncMultilineWidgetElement(widget, next);
    }
}

// 拖动结束的一次性结算：把拖动后的最终文本框高度写入持久记忆。
// 分配只在拖动过程中实时发生，这里只负责记住结果，之后高度保持稳定。
function settleManualMultilineHeight(node) {
    if (!node) return;
    const anchor = node._ggPortListResizeAnchor;
    node._ggPortListResizeAnchor = undefined;
    if (!isMultilineLayoutActive(node)) return;
    const textWidgets = getMultilineWidgets(node);
    if (!textWidgets.length) return;

    // 拖动中 trackManualResize 已把最终高度写到控件上，这里持久化。
    const memory = readManualHeightMap(node);
    for (let index = 0; index < textWidgets.length; index++) {
        const widget = textWidgets[index];
        const key = getMultilineMemoryKey(widget, index);
        const height = normalizeMultilineHeight(
            widget._ggPortListTextHeight
                ?? anchor?.heights?.get(widget)
                ?? DEFAULT_MULTILINE_WIDGET_HEIGHT,
        );
        memory[key] = height;
        widget._ggPortListTextHeight = height;
    }
    writeManualHeightMap(node, memory);

    if (!readHiddenState(node)) {
        // 显示端口态：高度已持久化，布局交给 ComfyUI 原生管理。
        node.setDirtyCanvas?.(true, true);
        return;
    }

    // 隐藏态：重排紧凑布局；节点比内容矮时抬到最小内容高度，
    // 保证文本框至少有默认最小高度可用。
    compactVisibleWidgets(node);
    rememberCompactWidgetLayout(node);
    node._ggPortListLayoutPending = false;
    const contentHeight = getCompactNodeHeight(node);
    if (Number.isFinite(contentHeight) && contentHeight > Number(node.size?.[1])) {
        const settled = writeNodeSize(node, [Number(node.size?.[0]) || 0, contentHeight]);
        if (settled) node._ggPortListCompactSize = [settled[0], settled[1]];
    }

    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

function setHiddenState(node, hidden) {
    if (!node) return;
    const next = Boolean(hidden);
    node._ggPortListHidden = next;

    if (!node.properties || typeof node.properties !== "object") node.properties = {};
    if (next) node.properties[STATE_PROPERTY] = true;
    else delete node.properties[STATE_PROPERTY];

    if (isNodes2()) {
        syncVueTitle(node);
        node.graph?.change?.();
        node.setDirtyCanvas?.(true, true);
        return;
    }
    if (next) {
        markHiddenLayoutPending(node);
        applyHiddenNodeSize(node);
    }
    else restoreHiddenNodeSize(node);
    node.graph?.change?.();
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

function isNodeCollapsed(node) {
    return node?.flags?.collapsed === true || node?.collapsed === true;
}

function isNodePinned(node) {
    return node?.flags?.pinned === true || node?.pinned === true;
}

function setNodePinned(node, pinned) {
    if (!node) return;
    const next = Boolean(pinned);
    if (isNodePinned(node) === next) return;
    if (typeof node.pin === "function") {
        node.pin(next);
    } else {
        if (!node.flags || typeof node.flags !== "object") node.flags = {};
        node.flags.pinned = next;
    }
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

// 折叠后统一宽度：所有折叠节点的渲染宽度都等于设置值 collapseFixedWidth（真正统一），
// 长标题截断、短标题右侧留白。做法是折叠时给节点的 _collapsed_width 装一个 getter，
// 返回当前设置值，并吞掉 LiteGraph 每帧「按标题重算」的写入；这样无需改动 node.size，
// 展开尺寸与 autofit 都不受影响，命中区、选择框、我们的按钮定位也都由 _collapsed_width
// 派生，自然跟着统一。展开时撤掉 getter，交回原生行为。
const COLLAPSE_WIDTH_DEFAULT = 158;
const COLLAPSE_WIDTH_MIN = 96;
const COLLAPSE_WIDTH_MAX = 260;
// 三档预设（设计稿第 5 页 ·06）：覆盖 90% 用法，滑杆只处理中间值。
const COLLAPSE_WIDTH_PRESETS = [
    { value: 120, label: "紧凑" },
    { value: 158, label: "标准" },
    { value: 200, label: "宽松" },
];
const COLLAPSE_WIDTH_FORCED_FLAG = "_ggCollapseWidthForced";
let collapseFixedWidth = COLLAPSE_WIDTH_DEFAULT;

function normalizeCollapseWidth(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return COLLAPSE_WIDTH_DEFAULT;
    return Math.max(COLLAPSE_WIDTH_MIN, Math.min(COLLAPSE_WIDTH_MAX, Math.round(number)));
}

// LiteGraph 折叠标题是「截断到 20 个字符、左对齐、不按宽度裁剪」，所以一旦我们把
// 折叠宽度强制成固定值，超过该宽度的标题就会溢出到节点外（用户反馈的问题）。
// 这里用一个 onDrawTitleText 覆写：折叠时按统一宽度把标题裁到带省略号、并画在节点内。
function truncateTitleToWidth(ctx, text, maxWidth) {
    if (maxWidth <= 0) return "";
    if (ctx.measureText(text).width <= maxWidth) return text;
    const ellipsis = "\u2026";
    let shown = text;
    while (shown.length > 0 && ctx.measureText(shown + ellipsis).width > maxWidth) {
        shown = shown.slice(0, -1);
    }
    return shown.length ? shown + ellipsis : ellipsis;
}

function ggCollapsedTitleText(ctx, title_height, size, _scale, fontStyle, selected) {
    const LG = globalThis.LiteGraph;
    ctx.font = fontStyle || this.titleFontStyle;
    const raw = String((typeof this.getTitle === "function" ? this.getTitle() : this.title) ?? "")
        + (this.pinned ? "\uD83D\uDCCC" : "");
    if (!raw) return;
    ctx.fillStyle = selected
        ? (LG?.NODE_SELECTED_TITLE_COLOR || "#ffffff")
        : (this.constructor?.title_text_color || LG?.NODE_TITLE_COLOR || "#999");
    const th = Number(title_height) || LG?.NODE_TITLE_HEIGHT || 30;
    // 折叠：裁进统一宽度（左侧折叠圆点约占一个标题栏高度，右侧留 8px）；
    // 展开（极少数过渡帧会用到本覆写）：退回原生按可用宽度裁剪的行为。
    const maxWidth = isNodeCollapsed(this)
        ? collapseFixedWidth - th - 8
        : (Number(size?.[0]) || collapseFixedWidth) - th * 2;
    ctx.textAlign = "left";
    ctx.fillText(
        truncateTitleToWidth(ctx, raw, maxWidth),
        th,
        (LG?.NODE_TITLE_TEXT_Y ?? 20) - th,
    );
}

function forceCollapsedWidth(node) {
    if (!node || node[COLLAPSE_WIDTH_FORCED_FLAG]) return;
    try {
        Object.defineProperty(node, "_collapsed_width", {
            configurable: true,
            enumerable: false,
            get() { return collapseFixedWidth; },
            set() { /* 吞掉 LiteGraph 每帧按标题的重算写入，保持统一宽度 */ },
        });
    } catch (_) {
        node._collapsed_width = collapseFixedWidth;
    }
    // 接管折叠标题绘制，按统一宽度裁剪，绝不溢出节点。保存原有 onDrawTitleText 以便展开时还原。
    node._ggOrigOnDrawTitleText = node.onDrawTitleText;
    node.onDrawTitleText = ggCollapsedTitleText;
    node[COLLAPSE_WIDTH_FORCED_FLAG] = true;
}

function releaseCollapsedWidth(node) {
    if (!node || !node[COLLAPSE_WIDTH_FORCED_FLAG]) return;
    try { delete node._collapsed_width; } catch (_) { /* ignore */ }
    node.onDrawTitleText = node._ggOrigOnDrawTitleText;
    delete node._ggOrigOnDrawTitleText;
    node[COLLAPSE_WIDTH_FORCED_FLAG] = false;
}

function syncCollapsedWidth(node) {
    if (!node) return;
    if (collapseFeatureEnabled && isNodeCollapsed(node)) forceCollapsedWidth(node);
    else releaseCollapsedWidth(node);
}

function setNodeCollapsed(node, collapsed) {
    if (!node) return;
    const next = Boolean(collapsed);
    if (isNodeCollapsed(node) === next) return;

    node.graph?.beforeChange?.();
    try {
        if (typeof node.collapse === "function") node.collapse();
        if (isNodeCollapsed(node) !== next) {
            if (!node.flags || typeof node.flags !== "object") node.flags = {};
            node.flags.collapsed = next;
        }
    } finally {
        node.graph?.change?.();
        node.graph?.afterChange?.();
    }

    syncCollapsedWidth(node);
    if (!next && featureEnabled && readHiddenState(node)) {
        markHiddenLayoutPending(node);
        applyHiddenNodeSize(node);
    }
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

function getTitleHeight(node) {
    const candidates = [
        node?.title_height,
        node?.constructor?.title_height,
        globalThis.LiteGraph?.NODE_TITLE_HEIGHT,
        30,
    ];
    for (const value of candidates) {
        const number = Number(value);
        if (Number.isFinite(number) && number >= 18) return number;
    }
    return 30;
}

function getNodeTitleWidth(node) {
    if (isNodeCollapsed(node)) {
        const collapsedWidth = Number(node?._collapsed_width);
        if (Number.isFinite(collapsedWidth) && collapsedWidth > 0) return collapsedWidth;

        const defaultCollapsedWidth = Number(globalThis.LiteGraph?.NODE_COLLAPSED_WIDTH);
        if (Number.isFinite(defaultCollapsedWidth) && defaultCollapsedWidth > 0) {
            return defaultCollapsedWidth;
        }
    }
    return Math.max(0, Number(node?.size?.[0]) || 0);
}

// 节点原生标题按钮从右边缘向左依次排布（见 LiteGraph.drawNode），每个按钮
// 绘制后把命中区写进 button._last_area（节点局部坐标，与本文件按钮同一坐标系）。
// 取所有可见原生按钮最左边界，我们的按钮就贴在它左侧，避免遮挡（如子图查看按钮）。
function nativeTitleButtonsLeftEdge(node) {
    const buttons = node?.title_buttons;
    if (!Array.isArray(buttons) || buttons.length === 0) return null;
    let minLeft = Infinity;
    for (const button of buttons) {
        if (!button || button.visible === false) continue;
        const area = button._last_area;
        const left = Number(area?.[0]);
        const areaWidth = Number(area?.[2]);
        if (Number.isFinite(left) && Number.isFinite(areaWidth) && areaWidth > 0) {
            minLeft = Math.min(minLeft, left);
        }
    }
    return Number.isFinite(minLeft) ? minLeft : null;
}

// 官方（LiteGraph 原生）固定是否被启用：节点自带 pin 时我们不再画自己的置顶按钮，
// 避免两个固定入口冲突（设计稿 4:259「官方有 pin 时我们不画置顶」）。
function hostHasOfficialPin(node) {
    if (!node) return false;
    if (node.pinned === true) return true;
    const buttons = node.title_buttons;
    if (Array.isArray(buttons)) {
        for (const button of buttons) {
            if (!button || button.visible === false) continue;
            const id = String(
                button.name ?? button.icon ?? button.type ?? button.action ?? button.id ?? ""
            ).toLowerCase();
            if (id.includes("pin")) return true;
        }
    }
    return false;
}

// 标题栏按钮的单一真相源（设计稿 4:259 三档降级 + 官方 pin 抑制）：
// 按节点当前宽度 / 折叠态 / 官方 pin 决定三枚按钮的可见性与尺寸，
// 绘制与点击命中必须全部经由本函数，避免「画在这、点在那」。
function computeTitleButtons(node) {
    const collapsed = isNodeCollapsed(node);
    const titleHeight = getTitleHeight(node);
    const baseSize = Math.min(BUTTON_SIZE, Math.max(18, titleHeight - 6));

    // 折叠态：只保留「恢复」一枚（设计稿 1:259），其余收起。
    if (collapsed) {
        return {
            port: null,
            collapse: anchoredButtonRect(rightAnchorForNode(node, titleHeight), titleHeight, baseSize),
            pin: null,
        };
    }

    const width = getNodeTitleWidth(node);
    const hasPorts = nodeHasPorts(node);
    const officialPin = hostHasOfficialPin(node);

    // 三档降级（宽松 → 严格）。
    const fullTier = width >= TITLE_BUTTON_FULL_WIDTH;            // ≥300 三枚全显
    const midTier = width >= TITLE_BUTTON_NO_PIN_WIDTH;           // 240–299 撤置顶
    const smallTier = width >= TITLE_BUTTON_COLLAPSE_ONLY_WIDTH;  // 180–239 只留折叠

    const showPin = fullTier && !officialPin && pinFeatureEnabled;
    // 端口按钮常显（无端口时由 drawPortListButton 画 34% 禁用态）
    const showPort = featureEnabled && midTier;
    const showCollapse = collapseFeatureEnabled && smallTier;     // 180+ 保留折叠

    if (!showPin && !showPort && !showCollapse) {
        // <180 一枚都不画，功能收进右键菜单（见 installNode 的 getExtraMenuOptions）。
        return { port: null, collapse: null, pin: null };
    }

    // 180–239 档：唯一有状态回报的折叠按钮缩到 16px。
    const size = smallTier && !midTier ? Math.min(TITLE_BUTTON_SHRINK_SIZE, baseSize) : baseSize;
    const right = rightAnchorForNode(node, titleHeight);

    // 自右向左依次排布：端口 → 折叠 → 置顶。
    const present = [];
    if (showPort) present.push("port");
    if (showCollapse) present.push("collapse");
    if (showPin) present.push("pin");
    const rects = { port: null, collapse: null, pin: null };
    let cursor = right;
    for (const key of present) {
        const rect = anchoredButtonRect(cursor, titleHeight, size);
        rects[key] = rect;
        cursor = rect.x - BUTTON_GAP;
    }
    return rects;
}

// 标题栏按钮右侧锚点：默认贴右边缘，展开态若节点自带标题按钮（如子图查看）则让位。
function rightAnchorForNode(node, titleHeight) {
    const width = getNodeTitleWidth(node);
    let rightAnchor = width - BUTTON_RIGHT;
    if (!isNodeCollapsed(node)) {
        const nativeLeft = nativeTitleButtonsLeftEdge(node);
        if (nativeLeft != null) {
            // 设计稿第 1 页 ·04：我们的组与官方按钮之间 = 6 间距 + 1px 分隔线 + 12。
            rightAnchor = Math.min(rightAnchor, nativeLeft - NATIVE_BUTTON_GAP - 1 - 12);
        }
    }
    return rightAnchor;
}

// 以右侧游标为基准生成一枚按钮的矩形（节点局部坐标，与绘制 / 命中同一套）。
function anchoredButtonRect(rightCursor, titleHeight, size) {
    return {
        x: Math.max(2, rightCursor - size),
        // LiteGraph's node-local draw origin is the top of the body; the
        // title bar occupies the negative Y range above it.
        y: -titleHeight + Math.max(2, (titleHeight - size) / 2),
        width: size,
        height: size,
    };
}

function getButtonRect(node) {
    return computeTitleButtons(node).port;
}

function getCollapseButtonRect(node) {
    return computeTitleButtons(node).collapse;
}

function getPinButtonRect(node) {
    return computeTitleButtons(node).pin;
}

function getNodeButtonRects(node) {
    return computeTitleButtons(node);
}

function getLocalPosition(position, event) {
    if (Array.isArray(position) && position.length >= 2) return position;
    if (Array.isArray(event?.localPos) && event.localPos.length >= 2) return event.localPos;
    if (Array.isArray(event?.pos) && event.pos.length >= 2) return event.pos;
    return null;
}

function readNodeSize(node) {
    const size = node?.size;
    if (!size || typeof size.length !== "number" || size.length < 2) return null;
    const width = Number(size[0]);
    const height = Number(size[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return [width, height];
}

function sizesMatch(first, second) {
    return !!first && !!second
        && Math.abs(Number(first[0]) - Number(second[0])) <= SIZE_EPSILON
        && Math.abs(Number(first[1]) - Number(second[1])) <= SIZE_EPSILON;
}

function layoutCacheMatches(node) {
    const cached = node?._ggPortListCompactSize;
    return Array.isArray(cached)
        && Number.isFinite(Number(cached[1]))
        && node?._ggPortListLayoutPending !== true
        && Number(cached[0]) === Number(node?.size?.[0])
        && Array.isArray(node?._ggPortListWidgetLayoutCompactValues);
}

function withHiddenPortArrays(node, callback) {
    if (!node) return callback();

    const originalInputs = Array.isArray(node.inputs) ? [...node.inputs] : node.inputs;
    const originalOutputs = Array.isArray(node.outputs) ? [...node.outputs] : node.outputs;
    const originalWidgetSlotsDirty = node._widgetSlotsDirty;
    const wasDrawingHidden = node._ggPortListDrawingHidden === true;
    node._ggPortListDrawingHidden = true;
    try {
        node.inputs = [];
        node.outputs = [];
        return callback();
    } finally {
        node.inputs = originalInputs;
        node.outputs = originalOutputs;
        node._ggPortListDrawingHidden = wasDrawingHidden;
        // A temporary port projection must not invalidate the real slot cache.
        // Doing so makes every subsequent draw arrange the node again.
        node._widgetSlotsDirty = originalWidgetSlotsDirty;
    }
}

function getHiddenNodeComputedSize(node) {
    const computeSize = node?._ggPortListOriginalComputeSize || node?.computeSize;
    if (typeof computeSize !== "function") return null;

    try {
        return withHiddenPortArrays(node, () => {
            const computed = computeSize.call(node);
            const width = Number(computed?.[0]);
            const height = Number(computed?.[1]);
            if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
            return [width, height];
        });
    } catch {
        return null;
    }
}

function getTextAreaElement(widget) {
    const candidates = [widget?.inputEl, widget?.element];
    for (const direct of candidates) {
        if (direct?.tagName === "TEXTAREA") return direct;
        const nested = direct?.querySelector?.("textarea");
        if (nested) return nested;
    }
    return null;
}

function isMultilineWidget(widget) {
    if (!widget) return false;
    if (widget.options?.multiline === true) return true;
    if (widget.type === "customtext") return true;
    return getTextAreaElement(widget) !== null;
}

function getMultilineWidgetHeight(widget) {
    const configured = Number(widget?._ggPortListTextHeight);
    return normalizeMultilineHeight(configured);
}

function getMultilineWidgets(node) {
    return Array.isArray(node?.widgets)
        ? node.widgets.filter(isMultilineWidget)
        : [];
}

// 多行控件只在“端口列表已隐藏”时需要固定高度来参与紧凑布局。
// 其它状态交回 ComfyUI 原生控件；否则历史记忆高度会成为 LiteGraph 的
// 全局最小尺寸，导致普通节点只能拉高、无法向下缩小。
function restoreNativeMultilineWidgetLayout(node) {
    if (!node || !Array.isArray(node.widgets)) return;
    for (const widget of node.widgets) {
        if (!isMultilineWidget(widget)) continue;

        const wrapped = widget._ggPortListWrappedComputeSize;
        if (wrapped && widget.computeSize === wrapped) {
            widget.computeSize = widget._ggPortListOriginalComputeSize;
        } else if (!wrapped
            && widget._ggPortListTextLayoutPatched === true
            && widget._ggPortListOriginalComputeSize) {
            // 兼容旧会话中没有保存 wrapper 引用的节点。
            widget.computeSize = widget._ggPortListOriginalComputeSize;
        }
        delete widget._ggPortListWrappedComputeSize;
        delete widget._ggPortListTextLayoutPatched;
        delete widget._ggPortListOriginalComputeSize;

        const element = getTextAreaElement(widget);
        const savedStyle = widget._ggPortListTextElementStyle;
        if (element && savedStyle) {
            element.style.height = savedStyle.height;
            element.style.minHeight = savedStyle.minHeight;
            element.style.maxHeight = savedStyle.maxHeight;
            element.style.overflowY = savedStyle.overflowY;
            element.style.boxSizing = savedStyle.boxSizing;
        }
        delete widget._ggPortListTextElementStyle;
    }
}

function syncMultilineWidgetElement(widget, height) {
    const element = getTextAreaElement(widget);
    if (!element) return;
    if (!widget._ggPortListTextElementStyle) {
        widget._ggPortListTextElementStyle = {
            height: element.style.height,
            minHeight: element.style.minHeight,
            maxHeight: element.style.maxHeight,
            overflowY: element.style.overflowY,
            boxSizing: element.style.boxSizing,
        };
    }
    element.style.height = `${Math.max(MIN_MULTILINE_WIDGET_HEIGHT, height)}px`;
    element.style.minHeight = `${MIN_MULTILINE_WIDGET_HEIGHT}px`;
    element.style.maxHeight = `${Math.max(MIN_MULTILINE_WIDGET_HEIGHT, height)}px`;
    element.style.overflowY = "auto";
    element.style.boxSizing = "border-box";
}

function ensureMultilineWidgetLayout(node) {
    if (!node || !Array.isArray(node.widgets)) return;
    if (!featureEnabled || !readHiddenState(node) || isNodeCollapsed(node)) {
        restoreNativeMultilineWidgetLayout(node);
        return;
    }
    for (const widget of node.widgets) {
        if (!isMultilineWidget(widget)) continue;
        if (widget._ggPortListTextLayoutPatched === true) continue;

        const originalComputeSize = widget.computeSize;
        widget._ggPortListOriginalComputeSize = originalComputeSize;
        const wrappedComputeSize = function (width) {
            let computed = null;
            try {
                computed = originalComputeSize?.call(this, width);
            } catch {
                // A third-party widget may measure only after its DOM exists.
            }
            const measuredWidth = Number(computed?.[0]);
            const active = !isNodeCollapsed(node);
            if (!active) return computed;
            return [
                Number.isFinite(measuredWidth) && measuredWidth > 0 ? measuredWidth : Number(width) || 0,
                getMultilineWidgetHeight(this),
            ];
        };
        wrappedComputeSize[TEXT_WIDGET_LAYOUT_PATCHED] = true;
        widget.computeSize = wrappedComputeSize;
        widget._ggPortListWrappedComputeSize = wrappedComputeSize;
        widget._ggPortListTextLayoutPatched = true;
    }

    // During native node collapse the title bar owns the node height. Leave
    // the current textarea DOM height untouched until the node is restored;
    // rewriting it here can trigger a second DOM measurement and make the
    // collapsed node oscillate between title-only and expanded heights.
    if (!isNodeCollapsed(node)) {
        applyMultilineMemory(node);
    }
}

function getWidgetHeight(widget, width, node) {
    if (isMultilineWidget(widget) && featureEnabled && readHiddenState(node) && !isNodeCollapsed(node)) {
        return getMultilineWidgetHeight(widget);
    }
    try {
        const layout = widget?.computeLayoutSize?.(node);
        const minHeight = Number(layout?.minHeight);
        if (Number.isFinite(minHeight) && minHeight > 0) return minHeight;
    } catch {
        // Some third-party widgets require a fully initialized node to measure.
    }

    try {
        const computed = widget?.computeSize?.(width);
        const computedHeight = Number(computed?.[1]);
        if (Number.isFinite(computedHeight) && computedHeight > 0) return computedHeight;
    } catch {
        // Some third-party widgets require a fully initialized node to measure.
    }

    const directHeight = Number(widget?.height);
    if (Number.isFinite(directHeight) && directHeight > 0) return directHeight;

    return DEFAULT_WIDGET_HEIGHT;
}

function widgetIsVisible(widget, node) {
    if (!widget || widget.hidden === true) return false;
    if (widget.type === "hidden") return false;
    try {
        if (typeof node?.isWidgetVisible === "function" && !node.isWidgetVisible(widget)) {
            return false;
        }
    } catch {
        // Keep the widget visible when a node-specific visibility check fails.
    }
    try {
        if (typeof widget.isVisible === "function" && !widget.isVisible()) return false;
    } catch {
        // Keep the widget visible when a custom widget visibility check fails.
    }
    if (typeof widget.computeSize === "function") {
        try {
            const computed = widget.computeSize();
            if (Array.isArray(computed) && Number(computed[1]) <= 0) return false;
        } catch {
            // Keep the widget visible when its optional measurement fails.
        }
    }
    return true;
}

function getVisibleWidgetOffset(node) {
    const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
    const positions = widgets
        .filter((widget) => widgetIsVisible(widget, node))
        .map((widget) => Number(widget.y))
        .filter((value) => Number.isFinite(value));
    if (!positions.length) return 0;
    return Math.max(0, Math.min(...positions));
}

function comparableNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function getWidgetLayoutFingerprint(node) {
    const width = comparableNumber(node?.size?.[0]);
    const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
    return {
        width,
        widgets: widgets.map((widget) => [
            widget,
            comparableNumber(widget?.computedHeight),
            comparableNumber(widget?.height),
            widget?.hidden === true,
            widget?.type || "",
            comparableNumber(widget?.options?.height),
            comparableNumber(widget?.options?.minHeight),
            comparableNumber(widget?.options?.maxHeight),
            widget?.hidden === true,
        ]),
    };
}

function sameWidgetLayoutFingerprint(first, second) {
    if (!first || !second || first.width !== second.width) return false;
    const firstWidgets = Array.isArray(first.widgets) ? first.widgets : [];
    const secondWidgets = Array.isArray(second.widgets) ? second.widgets : [];
    if (firstWidgets.length !== secondWidgets.length) return false;

    return firstWidgets.every((firstEntry, index) => {
        const secondEntry = secondWidgets[index];
        if (!secondEntry || firstEntry.length !== secondEntry.length) return false;
        return firstEntry.every((value, valueIndex) => value === secondEntry[valueIndex]);
    });
}

function rememberWidgetLayout(node) {
    if (!node || !Array.isArray(node.widgets)) return;
    if (!Array.isArray(node._ggPortListWidgetLayoutBeforeHide)) {
        node._ggPortListWidgetLayoutBeforeHide = [];
    }

    const saved = node._ggPortListWidgetLayoutBeforeHide;
    for (const widget of node.widgets) {
        if (!widget || saved.some((entry) => entry.widget === widget)) continue;
        saved.push(readWidgetLayout(widget));
    }
}

function readWidgetLayout(widget) {
    return {
        widget,
        hasY: Object.prototype.hasOwnProperty.call(widget, "y"),
        y: widget.y,
        hasLastY: Object.prototype.hasOwnProperty.call(widget, "last_y"),
        lastY: widget.last_y,
        hasComputedHeight: Object.prototype.hasOwnProperty.call(widget, "computedHeight"),
        computedHeight: widget.computedHeight,
    };
}

function captureWidgetLayout(node) {
    if (!node || !Array.isArray(node.widgets)) return [];
    return node.widgets.filter(Boolean).map(readWidgetLayout);
}

function applyWidgetLayoutValues(layout, { includeComputedHeight = true } = {}) {
    if (!Array.isArray(layout)) return;

    for (const entry of layout) {
        const widget = entry?.widget;
        if (!widget) continue;

        if (entry.hasY) widget.y = entry.y;
        else delete widget.y;
        if (entry.hasLastY) widget.last_y = entry.lastY;
        else delete widget.last_y;
        if (!includeComputedHeight) continue;
        if (entry.hasComputedHeight) widget.computedHeight = entry.computedHeight;
        else delete widget.computedHeight;
    }
}

function restoreWidgetLayout(node) {
    restoreWidgetLayoutValues(node);
    if (Array.isArray(node?.widgets)) {
        restoreNativeMultilineWidgetLayout(node);
    }
    delete node._ggPortListWidgetLayoutBeforeHide;
    delete node._ggPortListWidgetLayoutCompactValues;
    delete node._ggPortListWidgetLayoutCompact;
    delete node._ggPortListWidgetLayoutFingerprint;
}

function restoreWidgetLayoutValues(node) {
    const saved = node?._ggPortListWidgetLayoutBeforeHide;
    if (!Array.isArray(saved)) return;
    applyWidgetLayoutValues(saved);
}

function arrangeNodeWidgets(node) {
    if (!node) return;
    // arrange() clears this flag. Marking it before arranging also covers
    // frontend versions that use it to decide whether widget-backed slots
    // need to be projected again.
    node._widgetSlotsDirty = true;
    node._setConcreteSlots?.();
    try {
        node?.arrange?.();
    } catch {
        // Some node implementations only expose arrange after graph attach.
    }
}

function arrangeWidgetsWithoutPorts(node) {
    if (!node || !Array.isArray(node.widgets)) return;
    ensureMultilineWidgetLayout(node);

    // Layout is an event-driven operation. During a draw pass the compact
    // positions are already applied by drawNodeWithPortToggle; repeating the
    // full arrange here would make every canvas movement pay for two layouts.
    if (node._ggPortListLayoutPending !== true
        && node._ggPortListWidgetLayoutCompact === true
        && Array.isArray(node._ggPortListWidgetLayoutCompactValues)) {
        applyWidgetLayoutValues(node._ggPortListWidgetLayoutCompactValues, {
            includeComputedHeight: false,
        });
        return false;
    }

    const fingerprint = getWidgetLayoutFingerprint(node);
    const needsRelayout = !sameWidgetLayoutFingerprint(
        node._ggPortListWidgetLayoutFingerprint,
        fingerprint,
    );

    if (needsRelayout) {
        // A dynamic combo, autogrow input, text-area resize, or node width
        // change can invalidate the saved full-port layout. Normalize once
        // with the real ports before taking a new baseline.
        if (Array.isArray(node._ggPortListWidgetLayoutBeforeHide)) {
            restoreWidgetLayoutValues(node);
        }
        const wasAutoSized = node._ggPortListAutoSized;
        node._ggPortListAutoSized = false;
        try {
            arrangeNodeWidgets(node);
        } finally {
            node._ggPortListAutoSized = wasAutoSized;
        }
        node._ggPortListWidgetLayoutBeforeHide = [];
        rememberWidgetLayout(node);
    } else {
        // Re-run the compact layout from a stable full-port baseline. This
        // prevents repeated draw passes from accumulating offsets.
        restoreWidgetLayoutValues(node);
    }

    withHiddenPortArrays(node, () => {
        arrangeNodeWidgets(node);
    });

    fitMultilineWidgetsToNode(node);
    compactVisibleWidgets(node);

    // Keep a stable portless snapshot. DOM widgets are positioned by a
    // foreground pass after the node draw; a third-party DOM widget can cause
    // another arrange() during that draw, so relying on the transient y value
    // alone lets its panel jump back below the old ports.
    rememberCompactWidgetLayout(node);
    node._ggPortListWidgetLayoutFingerprint = getWidgetLayoutFingerprint(node);
    node._ggPortListLayoutPending = false;
    return true;
}

function compactVisibleWidgets(node) {
    if (!node || !Array.isArray(node.widgets)) return;
    let nextY = COMPACT_WIDGET_TOP;
    for (const widget of node.widgets) {
        if (!widgetIsVisible(widget, node)) continue;
        const height = getWidgetHeight(widget, Number(node.size?.[0]) || 0, node);
        widget.y = nextY;
        widget.last_y = nextY;
        if (isMultilineWidget(widget)) {
            widget.computedHeight = height;
            if (featureEnabled && readHiddenState(node) && !isNodeCollapsed(node)) {
                syncMultilineWidgetElement(widget, height);
            }
        }
        nextY += height + COMPACT_WIDGET_GAP;
    }
}

function rememberCompactWidgetLayout(node) {
    if (!node || !Array.isArray(node.widgets)) return;
    node._ggPortListWidgetLayoutCompactValues = captureWidgetLayout(node);
    node._ggPortListWidgetLayoutCompact = true;
}

function fitMultilineWidgetsToNode(node) {
    // This is the portless-layout allocator. Running it while the real port
    // list is visible would overwrite the native textarea size on every node
    // resize, including ordinary user resizes.
    if (!node || !Array.isArray(node.widgets) || !featureEnabled || !readHiddenState(node)) return;
    // Textarea heights come exclusively from the persisted manual memory
    // (applyMultilineMemory). Deriving them from node.size here used to feed
    // an oscillation loop: the textarea consumed the available space, the
    // content height grew back into the node, and a leaked resize-gesture
    // flag kept the "manual" mode permanently enabled, so the node kept
    // growing on every layout pass.
    applyMultilineMemory(node);
}

function syncMultilineWidgets(node) {
    if (!featureEnabled || !readHiddenState(node) || isNodeCollapsed(node)) {
        restoreNativeMultilineWidgetLayout(node);
        return;
    }
    const textWidgets = getMultilineWidgets(node);
    if (!textWidgets.length) return;

    ensureMultilineWidgetLayout(node);

    fitMultilineWidgetsToNode(node);
}

function getWidgetContentHeight(node, multilineHeightOverride = null) {
    const current = readNodeSize(node);
    const width = current ? current[0] : Number(node?.size?.[0]) || 0;
    const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
    const widgetOffset = getVisibleWidgetOffset(node);
    const visibleWidgets = [];
    let nextY = 2;
    for (const widget of widgets) {
        if (!widgetIsVisible(widget, node)) continue;
        const widgetY = Number(widget.y);
        const y = Number.isFinite(widgetY) ? Math.max(0, widgetY - widgetOffset) : nextY;
        const height = isMultilineWidget(widget) && Number.isFinite(multilineHeightOverride)
            ? Math.max(MIN_MULTILINE_WIDGET_HEIGHT, multilineHeightOverride)
            : getWidgetHeight(widget, width, node);
        visibleWidgets.push({ visible: true, y, height });
        nextY = Math.max(nextY, y + height + COMPACT_WIDGET_GAP);
    }
    return visibleWidgets.length
        ? getVisibleContentHeight(
            visibleWidgets,
            getTitleHeight(node),
            COMPACT_BOTTOM_PADDING,
        )
        : null;
}

function getMultilineResizeMinimumHeight(node) {
    if (!node || !getMultilineWidgets(node).length) return null;
    return getWidgetContentHeight(node, MIN_MULTILINE_WIDGET_HEIGHT);
}

function getCompactNodeHeight(node) {
    const current = readNodeSize(node);
    if (!current) return null;

    // An executed preview owns the lower part of the node. Do not remove that
    // area when the port list is hidden; users still need to see the result.
    // Restore the pre-hide height so a later execution can re-expand the node.
    if (Array.isArray(node?.imgs) && node.imgs.length > 0) {
        const beforeHide = node._ggPortListAutoSizeBeforeHide;
        const restored = Array.isArray(beforeHide) ? Number(beforeHide[1]) : NaN;
        return Number.isFinite(restored) ? Math.max(restored, current[1]) : current[1];
    }

    // Size to the actual visible widgets. Trusting computeSize would keep the
    // empty preview/display area some nodes reserve (e.g. the image comparer),
    // leaving a large blank block below the last widget once ports are hidden.
    const widgetHeight = getWidgetContentHeight(node);
    if (Number.isFinite(widgetHeight)) return widgetHeight;

    // No measurable widgets: fall back to the portless computed size.
    const titleHeight = getTitleHeight(node);
    const computed = getHiddenNodeComputedSize(node);
    if (computed) return Math.max(titleHeight + COMPACT_BOTTOM_PADDING, computed[1]);
    return titleHeight + COMPACT_BOTTOM_PADDING;
}

function writeNodeSize(node, size) {
    if (!node || !size || size.length < 2) return null;
    const current = readNodeSize(node);
    if (sizesMatch(current, size)) return current;

    node._ggPortListApplyingSize = true;
    try {
        if (typeof node.setSize === "function") node.setSize([size[0], size[1]]);
        else if (node.size && typeof node.size.length === "number") {
            node.size[0] = size[0];
            node.size[1] = size[1];
            node.onResize?.(node.size);
        }
    } finally {
        node._ggPortListApplyingSize = false;
    }

    const next = readNodeSize(node) || [size[0], size[1]];
        node._ggPortListLastPluginSize = [...next];
    node.setDirtyCanvas?.(true, true);
    return next;
}

function markManualResizeIfNeeded(node) {
    if (node?._ggPortListApplyingSize || !node?._ggPortListLastPluginSize) return;
    const canvas = app.canvas || globalThis.LGraphCanvas?.active_canvas;
    // setSize/onResize are also used by ComfyUI and other extensions while a
    // node is being laid out. Only a resize gesture counts as the user's
    // manual height change; otherwise those layout passes would block restore.
    if (canvas?.resizing_node && canvas.resizing_node !== node) return;
    if (!canvas?.resizing_node && node._ggPortListUserResizeGesture !== true) return;
    // A gesture flag whose pointerup was swallowed (mouse released outside the
    // window, alt-tab, context menu) must expire, or later layout-driven size
    // changes get misread as manual drags and the node never stops growing.
    const gestureAt = Number(node._ggPortListUserResizeGestureAt);
    if (Number.isFinite(gestureAt)
        && Date.now() - gestureAt > RESIZE_GESTURE_TIMEOUT_MS) {
        node._ggPortListUserResizeGesture = false;
        node._ggPortListUserResizeGestureAt = undefined;
        // 过期手势不再结算：锚点一并丢弃，避免影响下一次真实拖动。
        node._ggPortListResizeAnchor = undefined;
        return;
    }
    const current = readNodeSize(node);
    if (current && Math.abs(current[1] - Number(node._ggPortListLastPluginSize[1])) > SIZE_EPSILON) {
        node._ggPortListManualSizeObserved = true;
        if (getMultilineWidgets(node).length > 0) setMultilineManualState(node, true);
    }
}

function applyHiddenNodeSize(node) {
    if (!node || isNodeCollapsed(node) || !nodeHasPorts(node) || !readHiddenState(node)) return;
    const current = readNodeSize(node);
    if (!current) return;

    // While the user is actively dragging the node edge, suspend the automatic
    // compact sizing; the one-shot settlement after the gesture decides the
    // final height and feeds it into the remembered text height.
    if (node._ggPortListUserResizeGesture === true) return;

    if (!node._ggPortListAutoSizeBeforeHide) {
        node._ggPortListAutoSizeBeforeHide = [...current];
        // Preserve a manual size saved while the node was already hidden, but
        // never infer it from a normal full-port layout.
        node._ggPortListManualSizeObserved = readMultilineManualState(node);
        markHiddenLayoutPending(node);
    }

    // A user-resized hidden node owns its height. Never reapply the automatic
    // compact size over it; only synchronize the text widget to the available
    // space. This is the main guard against resize/draw oscillation.
    markManualResizeIfNeeded(node);
    if (node._ggPortListManualSizeObserved) {
        arrangeWidgetsWithoutPorts(node);
        fitMultilineWidgetsToNode(node);
        compactVisibleWidgets(node);
        node._ggPortListLastPluginSize = [...current];
        return;
    }

    if (layoutCacheMatches(node)) {
        node._ggPortListAutoSized = true;
        writeNodeSize(node, [current[0], node._ggPortListCompactSize[1]]);
        return;
    }

    // Keep this layout outside the draw wrapper. ComfyUI's DOM widget layer
    // reads widget.y after canvas drawing has completed, so a draw-only shift
    // is immediately lost and textareas remain at their old port offset.
    arrangeWidgetsWithoutPorts(node);

    const compactHeight = getCompactNodeHeight(node);
    if (!Number.isFinite(compactHeight) || current[1] <= compactHeight + SIZE_EPSILON) {
        // Keep the auto-size state after the first shrink. Later draw passes
        // may temporarily re-layout widgets while the ports are hidden.
        // Losing this flag would make the original height impossible to restore.
        if (node._ggPortListAutoSized !== true) node._ggPortListAutoSized = false;
        node._ggPortListLastPluginSize = [...current];
        return;
    }

    node._ggPortListAutoSized = true;
    node._ggPortListCompactSize = [current[0], compactHeight];
    writeNodeSize(node, [current[0], compactHeight]);
}

function restoreHiddenNodeSize(node) {
    if (!node) return;
    restoreWidgetLayout(node);
    markManualResizeIfNeeded(node);
    const beforeHide = node._ggPortListAutoSizeBeforeHide;
    const shouldRestore = node._ggPortListAutoSized
        && !node._ggPortListManualSizeObserved
        && Array.isArray(beforeHide);
    if (shouldRestore) writeNodeSize(node, beforeHide);

    delete node._ggPortListAutoSizeBeforeHide;
    delete node._ggPortListLastPluginSize;
    delete node._ggPortListAutoSized;
    delete node._ggPortListManualSizeObserved;
    delete node._ggPortListCompactSize;
    delete node._ggPortListLayoutPending;
    setMultilineManualState(node, false);
}

function getCanvasHoveredNode() {
    const canvas = app.canvas || globalThis.LGraphCanvas?.active_canvas;
    return canvas?.node_over || canvas?.nodeOver || canvas?.hovered_node || null;
}

// 标题栏三枚按钮的配色：跟随宿主明暗。detectHostTheme 自带 1 秒缓存，
// 不会在 drawNode 里每帧触发 getComputedStyle。
let titleButtonThemeCache = { at: 0, mode: "dark" };
function titleButtonPalette() {
    const now = Date.now();
    if (now - titleButtonThemeCache.at > 1000) {
        titleButtonThemeCache = { at: now, mode: detectHostTheme() };
    }
    return PALETTES[titleButtonThemeCache.mode === "light" ? "light" : "dark"];
}

function hexToRgba(hex, alpha) {
    const text = String(hex || "").replace("#", "");
    const full = text.length === 3 ? [...text].map((ch) => ch + ch).join("") : text;
    const value = Number.parseInt(full, 16);
    if (!Number.isFinite(value)) return `rgba(76, 141, 255, ${alpha})`;
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

// 一枚标题栏按钮的四态底色（设计稿第 1 页 ·02 / 第 2 页 ·02）：
// 默认只有图标；悬停出 btn 底 + ink 图标；激活 accent 软底 + accent 图标。
function titleButtonSkin(palette, { hovered, active, pressed, mode }) {
    if (pressed) return { fill: palette.pressBg, stroke: palette.divider, icon: palette.ink, iconFill: null };
    if (active) {
        return {
            fill: hexToRgba(palette.accent, mode === "light" ? 0.10 : 0.30),
            stroke: hexToRgba(palette.accent, 0.55),
            icon: palette.accent,
            iconFill: palette.accent,
        };
    }
    if (hovered) return { fill: palette.btnHover, stroke: palette.divider, icon: palette.ink, iconFill: null };
    return { fill: null, stroke: null, icon: palette.muted, iconFill: null };
}

function isNodeHovered(node) {
    return node?._ggPortListNodeHovered === true || getCanvasHoveredNode() === node;
}

function isInsideNode(node, position, event) {
    const local = getLocalPosition(position, event);
    const size = readNodeSize(node);
    if (!local || !size) return false;
    const titleHeight = getTitleHeight(node);
    const titleWidth = getNodeTitleWidth(node);
    return local[0] >= 0 && local[0] <= size[0]
        && (!isNodeCollapsed(node) || local[0] <= titleWidth)
        && local[1] >= -titleHeight && local[1] <= size[1];
}

function shouldShowPortListButton(node) {
    // 设计稿第 1 页 ·02：三枚按钮常显。没有端口的节点画 34% 禁用态，
    // 而不是“点它也没反应”的隐形按钮。
    return featureEnabled && !isNodeCollapsed(node);
}

function isInsideButton(node, position, event) {
    const local = getLocalPosition(position, event);
    if (!local) return false;
    const rect = getButtonRect(node);
    if (!rect) return false;
    const padding = BUTTON_HIT_PADDING;
    return local[0] >= rect.x - padding
        && local[0] <= rect.x + rect.width + padding
        && local[1] >= rect.y - padding
        && local[1] <= rect.y + rect.height + padding;
}

function isInsideRect(rect, position, event) {
    const local = getLocalPosition(position, event);
    if (!local || !rect) return false;
    const padding = BUTTON_HIT_PADDING;
    return local[0] >= rect.x - padding
        && local[0] <= rect.x + rect.width + padding
        && local[1] >= rect.y - padding
        && local[1] <= rect.y + rect.height + padding;
}

function ensureButtonTooltip() {
    if (buttonTooltip) return buttonTooltip;
    buttonTooltip = document.createElement("div");
    buttonTooltip.className = "gg-node-title-button-tooltip";
    buttonTooltip.style.cssText = [
        "position: fixed",
        "z-index: 100008",
        "display: none",
        "max-width: 260px",
        "padding: 6px 9px",
        "border: 1px solid rgba(148,163,184,0.42)",
        "border-radius: 6px",
        "background: rgba(15,23,42,0.92)",
        "color: #fff",
        "font: 12px/1.35 system-ui, sans-serif",
        "white-space: nowrap",
        "pointer-events: none",
        "box-shadow: 0 6px 18px rgba(15,23,42,0.24)",
    ].join(";");
    document.body.appendChild(buttonTooltip);
    return buttonTooltip;
}

function hideButtonTooltip() {
    clearTimeout(buttonTooltipTimer);
    buttonTooltipTimer = null;
    if (buttonTooltip) buttonTooltip.style.display = "none";
}

function showButtonTooltip(text, event) {
    const tooltip = ensureButtonTooltip();
    clearTimeout(buttonTooltipTimer);
    buttonTooltipTimer = setTimeout(() => {
        tooltip.textContent = text;
        const x = Number(event?.clientX) || 0;
        const y = Number(event?.clientY) || 0;
        tooltip.style.left = `${Math.min(window.innerWidth - 12, Math.max(12, x + 12))}px`;
        tooltip.style.top = `${Math.min(window.innerHeight - 12, Math.max(12, y - 34))}px`;
        tooltip.style.transform = "translateY(-100%)";
        tooltip.style.display = "block";
    }, 120);
}

function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, width, height, r);
        return;
    }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

function drawEyeIcon(ctx, centerX, centerY, hidden) {
    const width = 6.6;
    const height = 4.3;
    ctx.beginPath();
    ctx.moveTo(centerX - width, centerY);
    ctx.bezierCurveTo(centerX - width * 0.42, centerY - height, centerX + width * 0.42, centerY - height, centerX + width, centerY);
    ctx.bezierCurveTo(centerX + width * 0.42, centerY + height, centerX - width * 0.42, centerY + height, centerX - width, centerY);
    ctx.stroke();
    if (!hidden) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, 2, 0, Math.PI * 2);
        ctx.stroke();
        return;
    }
    ctx.beginPath();
    ctx.moveTo(centerX - 6, centerY - 6);
    ctx.lineTo(centerX + 6, centerY + 6);
    ctx.stroke();
}

// 标题栏按钮的公共画法：底色 / 描边 / 图标色全部走主题皮肤（设计稿 1·02 / 2·02）。
// 拿到画布后显式设 globalAlpha，避免上一段绘制遗留的透明度漏进图标。
function paintTitleButton(ctx, rect, skin, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    if (skin.fill) {
        roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, BUTTON_RADIUS);
        ctx.fillStyle = skin.fill;
        ctx.fill();
        ctx.strokeStyle = skin.stroke || skin.fill;
        ctx.lineWidth = 1;
        ctx.stroke();
    }
    ctx.strokeStyle = skin.icon;
    ctx.fillStyle = skin.iconFill || skin.icon;
    ctx.lineWidth = 1.25;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
}

function titleButtonState(node, key, active) {
    const palette = titleButtonPalette();
    const hovered = key === "port"
        ? node._ggPortListButtonHovered === true
        : key === "collapse"
            ? node._ggPortListCollapseButtonHovered === true
            : node._ggPortListPinButtonHovered === true;
    const pressed = key === "port"
        ? node._ggPortListButtonPressed === true
        : key === "collapse"
            ? node._ggPortListCollapseButtonPressed === true
            : node._ggPortListPinButtonPressed === true;
    return { palette, skin: titleButtonSkin(palette, { hovered, active, pressed, mode: titleButtonThemeCache.mode }) };
}

function drawPortListButton(node, ctx) {
    if (!ctx || !shouldShowPortListButton(node)) return;
    const rect = getButtonRect(node);
    if (!rect) return;
    const hidden = readHiddenState(node);
    const enabled = nodeHasPorts(node);
    // 无端口：34% 透明禁用态，不画 hover 底、不响应点击（设计稿 1·02）。
    const { skin } = titleButtonState(node, "port", hidden);
    paintTitleButton(ctx, rect, enabled ? skin : { ...skin, fill: null, stroke: null, icon: titleButtonPalette().muted }, enabled ? 1 : 0.34);
    drawEyeIcon(ctx, rect.x + rect.width / 2, rect.y + rect.height / 2, hidden);
    ctx.restore();
}

function drawCollapseIcon(ctx, centerX, centerY, expanded) {
    const direction = expanded ? 1 : -1;
    const arm = 5.5;
    const tip = 2.5;
    ctx.beginPath();
    for (const [x, y, dx, dy] of [
        [-1, -1, 1, 1], [1, -1, -1, 1], [-1, 1, 1, -1], [1, 1, -1, -1],
    ]) {
        const startX = centerX + x * arm;
        const startY = centerY + y * arm;
        const endX = centerX + x * (arm - tip * direction);
        const endY = centerY + y * (arm - tip * direction);
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX + dx * tip, endY);
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX, endY + dy * tip);
    }
    ctx.stroke();
}

function drawCollapseButton(node, ctx) {
    if (!ctx || !collapseFeatureEnabled) return;
    const rect = getCollapseButtonRect(node);
    if (!rect) return;
    // 激活态 = 已折叠（设计稿 1·02），图标同时翻转成「展开」。
    const { skin } = titleButtonState(node, "collapse", isNodeCollapsed(node));
    paintTitleButton(ctx, rect, skin);
    drawCollapseIcon(ctx, rect.x + rect.width / 2, rect.y + rect.height / 2, !isNodeCollapsed(node));
    ctx.restore();
}

function drawPinIcon(ctx, centerX, centerY, pinned) {
    // 图钉：帽杆 + 锥形钉体 + 针尖；未固定时略微倾斜以区分状态，已固定时填充钉体。
    ctx.save();
    ctx.translate(centerX, centerY);
    if (!pinned) ctx.rotate(-0.5);
    ctx.beginPath();
    ctx.moveTo(-3.6, -4.4);
    ctx.lineTo(3.6, -4.4);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-2.4, -4.4);
    ctx.lineTo(-1.3, 1);
    ctx.lineTo(1.3, 1);
    ctx.lineTo(2.4, -4.4);
    ctx.closePath();
    if (pinned) ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 1);
    ctx.lineTo(0, 5.4);
    ctx.stroke();
    ctx.restore();
}

function drawPinButton(node, ctx) {
    if (!ctx || !pinFeatureEnabled) return;
    const rect = getPinButtonRect(node);
    if (!rect) return;
    const pinned = isNodePinned(node);
    const { skin } = titleButtonState(node, "pin", pinned);
    paintTitleButton(ctx, rect, skin);
    drawPinIcon(ctx, rect.x + rect.width / 2, rect.y + rect.height / 2, pinned);
    ctx.restore();
}

function drawNativeButtonDivider(node, ctx) {
    if (!ctx || isNodeCollapsed(node)) return;
    const nativeLeft = nativeTitleButtonsLeftEdge(node);
    if (nativeLeft == null) return;
    const buttons = computeTitleButtons(node);
    if (!buttons || !Object.values(buttons).some(Boolean)) return;

    const titleHeight = getTitleHeight(node);
    const dividerHeight = Math.min(16, Math.max(12, titleHeight - 12));
    const centerY = -titleHeight / 2;
    const x = nativeLeft - NATIVE_BUTTON_GAP - 0.5;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = titleButtonPalette().divider;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, centerY - dividerHeight / 2);
    ctx.lineTo(x, centerY + dividerHeight / 2);
    ctx.stroke();
    ctx.restore();
}

function refreshNode(node) {
    if (!node) return;
    if (isNodes2()) { syncVueTitle(node); return; }
    // 统一折叠宽度：无论节点是被我们的按钮、原生双击还是加载工作流带入折叠状态，
    // 都在这里对齐 getter（折叠装、展开撤），确保所有折叠节点等宽。
    syncCollapsedWidth(node);
    // The persisted property can be restored after the node instance is
    // created. Re-sync the runtime flag before drawing or sizing.
    node._ggPortListHidden = readHiddenState(node);
    cachePortState(node);
    // The remembered height is only a layout aid for hidden ports. In the
    // normal visible-port state, restore the native widget so its minimum
    // height does not block manual node resizing.
    if (featureEnabled && readHiddenState(node) && !isNodeCollapsed(node)) {
        ensureMultilineWidgetLayout(node);
    } else {
        restoreNativeMultilineWidgetLayout(node);
    }
    syncMultilineWidgets(node);
    // 迁移老版本写入的持久手动标志：文本框高度已由 MULTILINE_HEIGHT_PROPERTY 接管，
    // 旧标志会让节点跨会话死锁在"吃满节点高度"模式，必须清除。
    if (node.properties?.[MULTILINE_MANUAL_PROPERTY] === true) {
        delete node.properties[MULTILINE_MANUAL_PROPERTY];
        node.graph?.change?.();
    }
    if (!readHiddenState(node) && node._ggPortListMultilineManualSizeObserved === true) {
        setMultilineManualState(node, false);
    }
    if (featureEnabled && !isNodeCollapsed(node) && readHiddenState(node)) {
        if (node._ggPortListWidgetLayoutCompact !== true) markHiddenLayoutPending(node);
        applyHiddenNodeSize(node);
    }
    else if (!featureEnabled) restoreHiddenNodeSize(node);
    node.setDirtyCanvas?.(true, true);
}

function drawNodeWithPortToggle(node, draw) {
    const hasPorts = cachePortState(node);
    const shouldHide = featureEnabled && !isNodeCollapsed(node) && readHiddenState(node) && hasPorts;
    if (!shouldHide) return draw();

    // ComfyUI's current LGraphNode setter mutates the backing arrays in
    // place. Keep copies; retaining the original references would clear the
    // real slot lists before the restore path can run.
    const originalInputs = Array.isArray(node.inputs) ? [...node.inputs] : [];
    const originalOutputs = Array.isArray(node.outputs) ? [...node.outputs] : [];
    const originalWidgetSlotsDirty = node._widgetSlotsDirty;
    const compactWidgetPositions = Array.isArray(node.widgets)
        ? node.widgets.map((widget) => [widget, widget?.y, widget?.last_y])
        : [];
    applyWidgetLayoutValues(node._ggPortListWidgetLayoutCompactValues, {
        includeComputedHeight: false,
    });
    node._ggPortListDrawingHidden = true;
    try {
        // Only the draw-time arrays are replaced. The node's actual slots and
        // links remain intact for execution and connection editing.
        node.inputs = [];
        node.outputs = [];
        return draw();
    } finally {
        node.inputs = originalInputs;
        node.outputs = originalOutputs;
        if (Array.isArray(node._ggPortListWidgetLayoutCompactValues)) {
            applyWidgetLayoutValues(node._ggPortListWidgetLayoutCompactValues, {
                includeComputedHeight: false,
            });
        } else {
            for (const [widget, y, lastY] of compactWidgetPositions) {
                if (widget && Number.isFinite(Number(y))) {
                    widget.y = y;
                    widget.last_y = Number.isFinite(Number(lastY)) ? lastY : y;
                }
            }
        }
        node._widgetSlotsDirty = originalWidgetSlotsDirty;
        node._ggPortListDrawingHidden = false;
    }
}

function drawNodeWithPortButton(node, ctx, draw) {
    if (isNodes2()) return draw();
    syncCollapsedWidth(node);
    if (!node || node._ggPortListDrawingInProgress === true) return draw();

    // Depending on the ComfyUI version, canvas.drawNode may call node.draw
    // internally. Both hooks are useful for compatibility, but only the
    // outermost hook may project ports or paint the custom title buttons.
    node._ggPortListDrawingInProgress = true;
    try {
        const result = drawNodeWithPortToggle(node, draw);
        if (featureEnabled && !isNodeCollapsed(node)) drawPortListButton(node, ctx);
        drawCollapseButton(node, ctx);
        drawPinButton(node, ctx);
        drawNativeButtonDivider(node, ctx);
        return result;
    } finally {
        node._ggPortListDrawingInProgress = false;
    }
}

function patchCanvasDrawNode(target) {
    if (!target || typeof target.drawNode !== "function") return false;
    const original = target.drawNode;
    if (original[CANVAS_DRAW_NODE_PATCHED]) return true;

    const wrapped = function (node, ctx, ...args) {
        if (!node) return original.call(this, node, ctx, ...args);
        return drawNodeWithPortButton(node, ctx, () => original.call(this, node, ctx, ...args));
    };
    wrapped[CANVAS_DRAW_NODE_PATCHED] = true;
    try {
        target.drawNode = wrapped;
        return true;
    } catch (error) {
        console.warn("[GGPortListToggle] Unable to patch canvas node drawing:", error);
        return false;
    }
}

function patchCanvasDrawing() {
    // Patch the prototype first. Installing the wrapper as an own property on the
    // canvas instance would shadow every prototype-level drawNode patch that is
    // added later (for example the GuliNodes title node), silently disabling it.
    const prototypes = [
        globalThis.LGraphCanvas?.prototype,
        globalThis.LiteGraph?.LGraphCanvas?.prototype,
    ];
    const prototypePatched = prototypes.some((prototype) => patchCanvasDrawNode(prototype));

    // Still patch the instance when it owns a drawNode of its own, so the port
    // list stays outermost without breaking the prototype chain for others.
    const canvas = app.canvas || globalThis.LGraphCanvas?.active_canvas;
    const canvasPatched = Boolean(canvas && patchCanvasDrawNode(canvas));

    return prototypePatched || canvasPatched;
}

function scheduleCanvasDrawingPatch() {
    if (patchCanvasDrawing() || canvasPatchTimer != null) return;
    let attempts = 0;
    const tick = () => {
        attempts += 1;
        if (patchCanvasDrawing() || attempts >= 80) {
            canvasPatchTimer = null;
            return;
        }
        canvasPatchTimer = globalThis.setTimeout(tick, 150);
    };
    canvasPatchTimer = globalThis.setTimeout(tick, 0);
}


function syncVueTitle(node, enabled = isNodes2()) {
    syncCollapsedWidth(node);
    const element = document.querySelector('.lg-node[data-node-id="' + CSS.escape(String(node.id)) + '"]');
    if (!element) return;
    if (!enabled) {
        element.classList.remove("gg-vue-ports-hidden", "gg-vue-collapse-width");
        element.querySelector(".gg-vue-title-actions")?.remove();
        return;
    }
    element.classList.toggle("gg-vue-ports-hidden", featureEnabled && readHiddenState(node));
    element.classList.toggle("gg-vue-collapse-width", collapseFeatureEnabled && isNodeCollapsed(node));
    element.style.setProperty("--gg-collapsed-width", collapseFixedWidth + "px");
    const header = element.querySelector(".lg-node-header > div");
    if (!header) return;
    let actions = header.querySelector(".gg-vue-title-actions");
    if (!actions) {
        ensureGGDesign();
        actions = document.createElement("span");
        actions.className = "gg-surface gg-vue-title-actions";
        applySurface(actions);
        Object.assign(actions.style, { display: "inline-flex", gap: "3px", flex: "0 0 auto" });
        const add = (name, icon, action) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "gg-icon-btn";
            button.dataset.ggAction = name;
            button.innerHTML = ggIcon(icon, 13);
            Object.assign(button.style, { width: "20px", height: "20px", padding: "2px" });
            button.addEventListener("pointerdown", event => event.stopPropagation());
            button.addEventListener("dblclick", event => event.stopPropagation());
            button.addEventListener("click", event => {
                event.stopPropagation();
                action();
                syncVueTitle(node);
            });
            actions.append(button);
        };
        add("ports", "eye", () => setHiddenState(node, !readHiddenState(node)));
        add("pin", "pin", () => setNodePinned(node, !isNodePinned(node)));
        header.append(actions);
    }
    const ports = actions.querySelector('[data-gg-action="ports"]');
    ports.style.display = featureEnabled && nodeHasPorts(node) && !isNodeCollapsed(node) ? "" : "none";
    ports.title = readHiddenState(node) ? "显示端口列表" : "隐藏端口列表";
    ports.setAttribute("aria-label", ports.title);
    ports.setAttribute("aria-pressed", String(readHiddenState(node)));
    const pin = actions.querySelector('[data-gg-action="pin"]');
    pin.style.display = pinFeatureEnabled ? "" : "none";
    pin.title = isNodePinned(node) ? "取消置顶" : "置顶节点";
    pin.setAttribute("aria-label", pin.title);
    pin.setAttribute("aria-pressed", String(isNodePinned(node)));
}

function installVueTitle(node) {
    if (!document.getElementById("gg-vue-title-style")) {
        const style = document.createElement("style");
        style.id = "gg-vue-title-style";
        // Visibility preserves the native link anchors and never mutates slots.
        style.textContent = ".gg-vue-ports-hidden .lg-slot{visibility:hidden;pointer-events:none}" +
          ".lg-node.gg-vue-collapse-width{--node-width:var(--gg-collapsed-width)!important;--min-node-width:var(--gg-collapsed-width)!important}";
        document.head.append(style);
    }
    watchNodeState(node, "title-actions", enabled => syncVueTitle(node, enabled));
}

function installNode(node) {
    if (!node || node._ggPortListToggleInstalled) return;
    node._ggPortListToggleInstalled = true;
    installVueTitle(node);
    node._ggPortListHidden = readHiddenState(node);
    cachePortState(node);

    const originalSetSize = node.setSize;
    if (typeof originalSetSize === "function" && !originalSetSize[NODE_RESIZE_PATCHED]) {
        const wrappedSetSize = function (...args) {
            const result = originalSetSize.apply(this, args);
            if (!this._ggPortListApplyingSize) markManualResizeIfNeeded(this);
            return result;
        };
        wrappedSetSize[NODE_RESIZE_PATCHED] = true;
        node.setSize = wrappedSetSize;
    }

    const originalOnResize = node.onResize;
    if (typeof originalOnResize === "function" && !originalOnResize[NODE_RESIZE_PATCHED]) {
        const wrappedOnResize = function (...args) {
            if (isNodes2()) return originalOnResize.apply(this, args);
            const canvas = app.canvas || globalThis.LGraphCanvas?.active_canvas;
            const userResizing = !this._ggPortListApplyingSize && canvas?.resizing_node === this;
            if (userResizing) {
                this._ggPortListUserResizeGesture = true;
                this._ggPortListUserResizeGestureAt = Date.now();
                // Any drag that touches a node with textareas changes what the
                // textareas will look like afterwards, so the "user owns the
                // size" flag applies in both layouts; it only blocks the
                // before-hide size restore, never the compact layout itself.
                if (isMultilineLayoutActive(this) && getMultilineWidgets(this).length > 0) {
                    setMultilineManualState(this, true);
                }
            }
            if (!this._ggPortListApplyingSize) markManualResizeIfNeeded(this);
            const result = originalOnResize.apply(this, args);
            if (userResizing && isMultilineLayoutActive(this)) {
                // During the drag the textareas track the node-height delta
                // from the anchor set at gesture start. Growing and shrinking
                // both work live, so the node's minimum height (which is
                // derived from the textarea heights) relaxes as the user
                // drags back down — the textareas can never be pinned by a
                // stale remembered height.
                ensureMultilineWidgetLayout(this);
                beginManualResizeAnchor(this);
                trackManualResize(this);
                if (nodeHasPorts(this)) {
                    compactVisibleWidgets(this);
                    rememberCompactWidgetLayout(this);
                }
            }
            if (this._ggPortListUserResizeGesture === true && canvas?.resizing_node !== this) {
                this._ggPortListUserResizeGesture = false;
                this._ggPortListUserResizeGestureAt = undefined;
                // The drag just finished: hand the height change over to the
                // text widgets once, then let the remembered height stay put.
                settleManualMultilineHeight(this);
            }
            return result;
        };
        wrappedOnResize[NODE_RESIZE_PATCHED] = true;
        node.onResize = wrappedOnResize;
    }

    const originalComputeSize = node.computeSize;
    if (typeof originalComputeSize === "function" && !originalComputeSize[NODE_COMPUTE_SIZE_PATCHED]) {
        node._ggPortListOriginalComputeSize = originalComputeSize;
        const wrappedComputeSize = function (...args) {
            const computed = originalComputeSize.apply(this, args);
            if (isNodes2()) return computed;
            const canvas = app.canvas || globalThis.LGraphCanvas?.active_canvas;
            const resizing = canvas?.resizing_node === this
                || this._ggPortListUserResizeGesture === true;
            if (
                resizing
                && !isNodeCollapsed(this)
                && getMultilineWidgets(this).length > 0
            ) {
                // LiteGraph asks computeSize for the resize clamp before it
                // calls onResize. Use the true textarea minimum for every
                // multiline node during that gesture; a remembered hidden-port
                // height must never prevent a visible node from shrinking.
                const minimumHeight = getMultilineResizeMinimumHeight(this);
                if (Number.isFinite(minimumHeight)) {
                    return [
                        Number(computed?.[0]) || Number(this.size?.[0]) || 0,
                        Math.max(MIN_NODE_HEIGHT, minimumHeight),
                    ];
                }
            }
            const lockedSize = this._ggPortListAutoSized && this._ggPortListLastPluginSize;
            if (!shouldLockHiddenNodeSize({
                featureEnabled,
                hidden: readHiddenState(this),
                collapsed: isNodeCollapsed(this),
                manualSizeObserved: this._ggPortListManualSizeObserved === true,
                lockedSize,
            })) {
                return computed;
            }
            if (!computed || typeof computed.length !== "number" || computed.length < 2) return computed;
            return [Number(computed[0]) || lockedSize[0], lockedSize[1]];
        };
        wrappedComputeSize[NODE_COMPUTE_SIZE_PATCHED] = true;
        node.computeSize = wrappedComputeSize;
    }

    const originalDraw = node.draw;
    if (typeof originalDraw === "function") {
        if (originalDraw[NODE_DRAW_PATCHED]) return;
        node.draw = function (...args) {
            return drawNodeWithPortButton(this, args[0], () => originalDraw.apply(this, args));
        };
        node.draw[NODE_DRAW_PATCHED] = true;
    }

    const originalMouseDown = node.onMouseDown;
    node.onMouseDown = function (...args) {
        const event = args[0];
        const position = args[1];
        const buttonRects = getNodeButtonRects(this);
        if (pinFeatureEnabled && isInsideRect(buttonRects.pin, position, event)) {
            setNodePinned(this, !isNodePinned(this));
            this._ggPortListNodeHovered = true;
            this._ggPortListPinButtonHovered = true;
            event?.stopPropagation?.();
            return true;
        }
        if (collapseFeatureEnabled && isInsideRect(buttonRects.collapse, position, event)) {
            setNodeCollapsed(this, !isNodeCollapsed(this));
            this._ggPortListNodeHovered = true;
            this._ggPortListCollapseButtonHovered = true;
            event?.stopPropagation?.();
            return true;
        }
        if (featureEnabled && !isNodeCollapsed(this) && nodeHasPorts(this) && isInsideRect(buttonRects.port, position, event)) {
            setHiddenState(this, !readHiddenState(this));
            this._ggPortListNodeHovered = true;
            this._ggPortListButtonHovered = true;
            event?.stopPropagation?.();
            return true;
        }
        if (featureEnabled && nodeHasPorts(this)) {
            this._ggPortListNodeHovered = true;
            this.setDirtyCanvas?.(true, false);
        }
        return originalMouseDown?.apply(this, args);
    };

    const originalMouseEnter = node.onMouseEnter;
    node.onMouseEnter = function (...args) {
        if (collapseFeatureEnabled || pinFeatureEnabled || featureEnabled && nodeHasPorts(this)) {
            this._ggPortListNodeHovered = true;
            this.setDirtyCanvas?.(true, false);
        }
        return originalMouseEnter?.apply(this, args);
    };

    const originalMouseMove = node.onMouseMove;
    node.onMouseMove = function (...args) {
        const event = args[0];
        const position = args[1];
        const hasPorts = featureEnabled && !isNodeCollapsed(this) && nodeHasPorts(this);
        const rects = getNodeButtonRects(this);
        const hovered = hasPorts && isInsideRect(rects.port, position, event);
        const collapseHovered = collapseFeatureEnabled && isInsideRect(rects.collapse, position, event);
        const pinHovered = pinFeatureEnabled && isInsideRect(rects.pin, position, event);
        const nodeHovered = (collapseFeatureEnabled || pinFeatureEnabled || hasPorts) && (
            isInsideNode(this, position, event) || getCanvasHoveredNode() === this
        );
        const stateChanged = hovered !== (this._ggPortListButtonHovered === true)
            || collapseHovered !== (this._ggPortListCollapseButtonHovered === true)
            || pinHovered !== (this._ggPortListPinButtonHovered === true)
            || nodeHovered !== (this._ggPortListNodeHovered === true);
        this._ggPortListButtonHovered = hovered;
        this._ggPortListCollapseButtonHovered = collapseHovered;
        this._ggPortListPinButtonHovered = pinHovered;
        this._ggPortListNodeHovered = nodeHovered;
        if (pinHovered) {
            showButtonTooltip(isNodePinned(this) ? "取消固定" : "固定节点", event);
        } else if (collapseHovered) {
            showButtonTooltip(isNodeCollapsed(this) ? "恢复节点" : "折叠节点", event);
        } else if (hovered) {
            showButtonTooltip(readHiddenState(this) ? "显示输入输出列表" : "隐藏输入输出列表", event);
        } else {
            hideButtonTooltip();
        }
        if (stateChanged) this.setDirtyCanvas?.(true, false);
        if (collapseHovered || hovered || pinHovered) return true;
        return originalMouseMove?.apply(this, args);
    };

    const originalMouseLeave = node.onMouseLeave;
    node.onMouseLeave = function (...args) {
        if (this._ggPortListButtonHovered || this._ggPortListCollapseButtonHovered || this._ggPortListPinButtonHovered || this._ggPortListNodeHovered) {
            this._ggPortListButtonHovered = false;
            this._ggPortListCollapseButtonHovered = false;
            this._ggPortListPinButtonHovered = false;
            this._ggPortListNodeHovered = false;
            hideButtonTooltip();
            this.setDirtyCanvas?.(true, false);
        }
        return originalMouseLeave?.apply(this, args);
    };

    // 设计稿 4:259：标题栏按钮被降级收起时，对应功能收进右键菜单，
    // 保证 <180px 等窄节点仍能触达（只补「被收起」的那几枚，避免与标题栏重复）。
    const originalGetExtraMenuOptions = node.getExtraMenuOptions;
    node.getExtraMenuOptions = function (event, options) {
        // 原生 getExtraMenuOptions 在某些节点类型（如广播节点）内部会再调用
        // getExtraMenuOptions 自身作为「链式 super」，这会导致我们包好的函数被
        // 重入并重复追加菜单项。用一次性重入标志打断这条回环：内层调用直接把
        // options 原样交回，由外层那次统一补菜单项，既防死循环也防重复。
        if (this._ggExtraMenuReentrant) return options;
        this._ggExtraMenuReentrant = true;
        try {
            let opts = options;
            if (typeof originalGetExtraMenuOptions === "function") {
                try {
                    const result = originalGetExtraMenuOptions.call(this, event, opts);
                    if (Array.isArray(result)) opts = result;
                } catch (menuError) {
                    console.warn("[GGPortListToggle] native getExtraMenuOptions failed:", menuError);
                }
            }
            if (!Array.isArray(opts)) opts = [];
            const has = (content) => opts.some((o) => o && o.content === content);
            const rects = computeTitleButtons(this);
            const hasPorts = featureEnabled && !isNodeCollapsed(this) && nodeHasPorts(this);
            const collapseLabel = isNodeCollapsed(this) ? "恢复节点" : "折叠节点";
            const portLabel = readHiddenState(this) ? "显示输入输出列表" : "隐藏输入输出列表";
            const pinLabel = isNodePinned(this) ? "取消固定节点" : "固定节点";
            if (collapseFeatureEnabled && !rects.collapse && !has(collapseLabel)) {
                opts.push({
                    content: collapseLabel,
                    callback: () => {
                        setNodeCollapsed(this, !isNodeCollapsed(this));
                        this.setDirtyCanvas?.(true, true);
                    },
                });
            }
            if (hasPorts && !rects.port && !has(portLabel)) {
                opts.push({
                    content: portLabel,
                    callback: () => {
                        setHiddenState(this, !readHiddenState(this));
                        this.setDirtyCanvas?.(true, true);
                    },
                });
            }
            if (pinFeatureEnabled && !rects.pin && !has(pinLabel)) {
                opts.push({
                    content: pinLabel,
                    callback: () => {
                        setNodePinned(this, !isNodePinned(this));
                        this.setDirtyCanvas?.(true, true);
                    },
                });
            }
            return opts;
        } finally {
            this._ggExtraMenuReentrant = false;
        }
    };
}

function getGraphNodes() {
    const graph = app.canvas?.graph || app.graph;
    const nodes = graph?._nodes || [];
    return Array.isArray(nodes) ? nodes : Object.values(nodes);
}

function refreshAllNodes() {
    scheduleCanvasDrawingPatch();
    for (const node of getGraphNodes()) {
        installNode(node);
        refreshNode(node);
    }
    app.canvas?.setDirty?.(true, true);
}

function updateTopButton() {
    if (!topButton) return;
    const title = featureEnabled ? "关闭节点输入输出列表按钮" : "启用节点输入输出列表按钮";
    topButton.title = title;
    topButton.setAttribute("aria-label", title);
    topButton.setAttribute("aria-pressed", featureEnabled ? "true" : "false");
    topButton.classList.toggle("active", featureEnabled);
    topButton.classList.toggle("gg-state-on", featureEnabled);
    topButton.classList.toggle("gg-state-off", !featureEnabled);
    // 颜色由设计层按 `active` / `gg-state-*` 决定，这里不再逐个改 style：
    // 以前这三行把「关」写成 `rgba(255,255,255,0.94)`，深色主题里就是一块白板。
    topButton.innerHTML = ggIcon("portList", 18);
}

function updateCollapseTopButton() {
    if (!collapseTopButton) return;
    const title = collapseFeatureEnabled ? "关闭节点折叠按钮" : "启用节点折叠按钮";
    collapseTopButton.title = title;
    collapseTopButton.setAttribute("aria-label", title);
    collapseTopButton.setAttribute("aria-pressed", collapseFeatureEnabled ? "true" : "false");
    collapseTopButton.classList.toggle("active", collapseFeatureEnabled);
    collapseTopButton.classList.toggle("gg-state-on", collapseFeatureEnabled);
    collapseTopButton.classList.toggle("gg-state-off", !collapseFeatureEnabled);
    collapseTopButton.innerHTML = ggIcon(collapseFeatureEnabled ? "nodeCollapse" : "nodeExpand", 18);
}

function placeTopButton() {
    if (!topButton) return;
    if (window.__ggMountTopGroup?.(topButton)) return;
    const host = document.getElementById("gg-toolbar-top-switch");
    if (host) {
        if (topButton.parentElement !== host) host.appendChild(topButton);
        topButton.style.position = "";
        topButton.style.top = "";
        topButton.style.right = "";
        topButton.style.zIndex = "";
        topButton.classList.remove("gg-port-list-floating");
        if (topHostObserver) {
            topHostObserver.disconnect();
            topHostObserver = null;
        }
        return;
    }

    if (topButton.parentElement !== document.body) document.body.appendChild(topButton);
    topButton.classList.add("gg-port-list-floating");
    topButton.style.position = "fixed";
    topButton.style.top = "18px";
    topButton.style.right = "clamp(54px, 16vw, 330px)";
    topButton.style.zIndex = "100002";
}

function placeCollapseTopButton() {
    if (!collapseTopHost || !collapseTopButton) return;
    if (window.__ggMountTopGroup?.(collapseTopHost)) return;
    const host = document.getElementById("gg-toolbar-top-switch");
    if (host) {
        if (collapseTopHost.parentElement !== host) host.appendChild(collapseTopHost);
        collapseTopHost.style.position = "";
        collapseTopHost.style.top = "";
        collapseTopHost.style.right = "";
        collapseTopHost.style.zIndex = "";
        return;
    }
    if (collapseTopHost.parentElement !== document.body) document.body.appendChild(collapseTopHost);
    collapseTopHost.style.position = "fixed";
    collapseTopHost.style.top = "18px";
    collapseTopHost.style.right = "clamp(100px, 20vw, 380px)";
    collapseTopHost.style.zIndex = "100002";
}

function updatePinTopButton() {
    if (!pinTopButton) return;
    const title = pinFeatureEnabled ? "关闭节点固定按钮" : "启用节点固定按钮";
    pinTopButton.title = title;
    pinTopButton.setAttribute("aria-label", title);
    pinTopButton.setAttribute("aria-pressed", pinFeatureEnabled ? "true" : "false");
    pinTopButton.classList.toggle("active", pinFeatureEnabled);
    pinTopButton.classList.toggle("gg-state-on", pinFeatureEnabled);
    pinTopButton.classList.toggle("gg-state-off", !pinFeatureEnabled);
    pinTopButton.innerHTML = ggIcon(pinFeatureEnabled ? "nodePin" : "nodePinOff", 18);
}

function placePinTopButton() {
    if (!pinTopHost || !pinTopButton) return;
    if (window.__ggMountTopGroup?.(pinTopHost)) return;
    const host = document.getElementById("gg-toolbar-top-switch");
    if (host) {
        if (pinTopHost.parentElement !== host) host.appendChild(pinTopHost);
        pinTopHost.style.position = "";
        pinTopHost.style.top = "";
        pinTopHost.style.right = "";
        pinTopHost.style.zIndex = "";
        return;
    }
    if (pinTopHost.parentElement !== document.body) document.body.appendChild(pinTopHost);
    pinTopHost.style.position = "fixed";
    pinTopHost.style.top = "18px";
    pinTopHost.style.right = "clamp(140px, 24vw, 430px)";
    pinTopHost.style.zIndex = "100002";
}

// 顶栏这几个按钮只声明「尺寸 + 动效」，颜色/边框/圆角/四态全部交给设计层
// （`.gg-ui-top-button`，见 gg-ui-icons.js）。以前每个按钮各写一份白底 + 各写一遍
// `style.background = 开 ? 蓝 : 白`，深色主题下「关」态就是一块白板。
const TOP_BUTTON_CSS = [
    "width: 40px",
    "min-width: 40px",
    "height: 40px",
    "padding: 0",
    "display: inline-flex",
    "align-items: center",
    "justify-content: center",
    "cursor: pointer",
    "box-shadow: var(--gg-top-switch-shadow, 0 8px 22px rgba(15,23,42,0.14))",
    "transition: transform 0.16s ease, background-color 0.16s ease, border-color 0.16s ease, opacity 0.16s ease",
].join(";");

function createTopButton() {
    if (topButton) return;
    topButton = document.createElement("button");
    topButton.id = TOP_BUTTON_ID;
    topButton.type = "button";
    topButton.className = "gg-toolbar-top-button gg-ui-top-button gg-port-list-top-button";
    topButton.style.cssText = TOP_BUTTON_CSS;
    topButton.addEventListener("mouseenter", () => { topButton.style.transform = "scale(1.08)"; });
    topButton.addEventListener("mouseleave", () => { topButton.style.transform = "none"; });
    topButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = !featureEnabled;
        applyFeatureEnabled(next);
        await setSettingValue(SETTING_ID, next);
    });
    document.body.appendChild(topButton);
    updateTopButton();
    placeTopButton();

    if (document.getElementById("gg-toolbar-top-switch")) return;
    let placeTimer = null;
    const schedulePlace = () => {
        if (placeTimer) clearTimeout(placeTimer);
        placeTimer = setTimeout(() => {
            placeTimer = null;
            placeTopButton();
            placeCollapseTopButton();
            placePinTopButton();
        }, 200);
    };
    topHostObserver = new MutationObserver(schedulePlace);
    topHostObserver.observe(document.body, { childList: true, subtree: true });
}

function installCollapseSettingsStyles() {
    if (document.getElementById("gg-node-collapse-settings-style")) return;
    const style = document.createElement("style");
    style.id = "gg-node-collapse-settings-style";
    // 外壳（底色 / 描边 / 圆角 / 阴影）交给设计层的 `.gg-popover`，
    // 这里只留「这一个面板特有」的定位与内容排版。
    style.textContent = `
        #${COLLAPSE_SETTINGS_PANEL_ID} {
            display: none;
            width: ${COLLAPSE_SETTINGS_PANEL_WIDTH}px;
            padding: 10px;
            box-sizing: border-box;
        }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-settings-title {
            padding-bottom: 8px; margin-bottom: 10px;
            border-bottom: 1px solid var(--gg-divider);
            font-size: 13px; font-weight: 700;
        }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-width-label,
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-preview-label {
            margin: 10px 0 6px; color: var(--gg-muted); font-size: 11px; font-weight: 650;
        }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-width-presets {
            display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px;
        }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-width-preset {
            width: 100%; height: 42px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
            padding: 3px 4px; border-radius: 8px; font-size: 11px; font-weight: 600;
        }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-width-preset small { color: var(--gg-muted); font-size: 10px; font-weight: 500; }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-width-preset[aria-pressed="true"] small { color: var(--gg-accent); }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-width-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-width-row label { flex: 0 0 auto; color: var(--gg-ink); font-size: 12px; font-weight: 600; }
        #${COLLAPSE_SETTINGS_PANEL_ID} input[type="range"] { flex: 1 1 auto; min-width: 0; accent-color: var(--gg-accent); }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-settings-value { flex: 0 0 auto; min-width: 36px; text-align: right; color: var(--gg-ink); font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-width-ends { display: flex; justify-content: space-between; margin: 2px 43px 0 76px; color: var(--gg-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 10px 0 6px; }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-preview-head .gg-collapse-preview-label { margin: 0; }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-preview-size { color: var(--gg-muted); font-size: 10.5px; font-variant-numeric: tabular-nums; }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-preview-stage { display: flex; align-items: center; min-height: 44px; padding: 5px; border: 1px solid var(--gg-divider); border-radius: 8px; background: var(--gg-field); box-sizing: border-box; overflow: hidden; }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-preview-node { width: 158px; max-width: 100%; height: 34px; display: grid; grid-template-columns: 7px minmax(0, 1fr) 7px 16px; align-items: center; gap: 5px; padding: 0 4px 0 6px; border: 1px solid var(--gg-divider); border-radius: 6px; background: var(--gg-card); color: var(--gg-ink); box-sizing: border-box; transition: width .12s ease; }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-preview-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--gg-faint); }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-preview-title { min-width: 0; overflow: hidden; color: var(--gg-ink); font-size: 10px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-preview-port { width: 7px; height: 7px; border: 1px solid var(--gg-accent); border-radius: 50%; box-sizing: border-box; }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-preview-action { display: inline-flex; align-items: center; justify-content: center; color: var(--gg-accent); }
        #${COLLAPSE_SETTINGS_PANEL_ID} .gg-collapse-settings-hint { margin-top: 8px; font-size: 10.5px; color: var(--gg-muted); line-height: 1.4; }
    `;
    document.head.appendChild(style);
}

function syncCollapseSettingsPanel() {
    if (!collapseSettingsPanel) return;
    const slider = collapseSettingsPanel.querySelector("input[type=range]");
    const value = collapseSettingsPanel.querySelector(".gg-collapse-settings-value");
    const preview = collapseSettingsPanel.querySelector(".gg-collapse-preview-node");
    const previewSize = collapseSettingsPanel.querySelector(".gg-collapse-preview-size");
    if (slider) slider.value = String(collapseFixedWidth);
    if (value) value.textContent = String(collapseFixedWidth);
    if (preview) preview.style.width = `${collapseFixedWidth}px`;
    if (previewSize) previewSize.textContent = `${collapseFixedWidth} × 34`;
    for (const button of collapseSettingsPanel.querySelectorAll(".gg-collapse-width-preset")) {
        const selected = Number(button.dataset.collapseWidth) === collapseFixedWidth;
        button.setAttribute("aria-pressed", selected ? "true" : "false");
        button.classList.toggle("is-active", selected);
    }
}

function createCollapseSettingsPanel() {
    if (collapseSettingsPanel) return;
    installCollapseSettingsStyles();
    const panel = document.createElement("div");
    panel.id = COLLAPSE_SETTINGS_PANEL_ID;
    panel.className = "gg-surface gg-popover";
    ensureGGDesign();
    applySurface(panel);
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "节点折叠设置");
    panel.innerHTML = `
        <div class="gg-collapse-settings-title">节点折叠设置</div>
        <div class="gg-collapse-width-label">宽度预设</div>
        <div class="gg-collapse-width-presets" role="group" aria-label="折叠宽度预设">
            ${COLLAPSE_WIDTH_PRESETS.map(({ value, label }) => `
                <button type="button" class="gg-btn gg-collapse-width-preset" data-collapse-width="${value}" aria-pressed="false">
                    <span>${label}</span><small>${value}px</small>
                </button>
            `).join("")}
        </div>
        <div class="gg-collapse-width-row">
            <label for="gg-collapse-width-slider">自定义宽度</label>
            <input id="gg-collapse-width-slider" type="range" min="${COLLAPSE_WIDTH_MIN}" max="${COLLAPSE_WIDTH_MAX}" step="1" aria-label="自定义折叠宽度">
            <span class="gg-collapse-settings-value">${collapseFixedWidth}</span>
        </div>
        <div class="gg-collapse-width-ends" aria-hidden="true"><span>${COLLAPSE_WIDTH_MIN}</span><span>${COLLAPSE_WIDTH_MAX}</span></div>
        <div class="gg-collapse-preview-head">
            <span class="gg-collapse-preview-label">预览</span>
            <span class="gg-collapse-preview-size">${collapseFixedWidth} × 34</span>
        </div>
        <div class="gg-collapse-preview-stage">
            <div class="gg-collapse-preview-node" style="width:${collapseFixedWidth}px" aria-label="折叠节点预览，宽度 ${collapseFixedWidth} 像素">
                <span class="gg-collapse-preview-dot"></span>
                <span class="gg-collapse-preview-title">GG 图像缩放 V2</span>
                <span class="gg-collapse-preview-port"></span>
                <span class="gg-collapse-preview-action">${ggIcon("nodeExpand", 13)}</span>
            </div>
        </div>
        <div class="gg-collapse-settings-hint">折叠后所有节点统一这个宽度；标题超出会截断，过短则右侧留白。</div>
    `;
    const slider = panel.querySelector("input[type=range]");
    slider.addEventListener("input", () => {
        const value = normalizeCollapseWidth(slider.value);
        applyCollapseWidthValue(value);
        void setSettingValue(COLLAPSE_WIDTH_SETTING_ID, value);
    });
    for (const button of panel.querySelectorAll(".gg-collapse-width-preset")) {
        button.addEventListener("click", () => {
            const value = normalizeCollapseWidth(button.dataset.collapseWidth);
            applyCollapseWidthValue(value);
            void setSettingValue(COLLAPSE_WIDTH_SETTING_ID, value);
        });
    }
    panel.addEventListener("click", (event) => event.stopPropagation());
    document.body.appendChild(panel);
    collapseSettingsPanel = panel;
    syncCollapseSettingsPanel();
}

// 登记二级页面板保证器：菜单内打开折叠设置前，顶栏会先调用它确保面板已建好
// （键盘 Enter 打开二级页也走这条；用待注册队列规避与 toolbar 的加载顺序竞态）
if (window.__ggRegisterTopDetailEnsurer) {
    window.__ggRegisterTopDetailEnsurer("gg-node-collapse-button", () => {
        createCollapseSettingsPanel();
        applySurface(collapseSettingsPanel);
        return true;
    });
} else {
    (window.__ggPendingTopDetailEnsurers ||= []).push(["gg-node-collapse-button", () => {
        createCollapseSettingsPanel();
        applySurface(collapseSettingsPanel);
        return true;
    }]);
}

function positionCollapseSettingsPanel() {
    if (!collapseSettingsPanel || !collapseSettingsButton) return;
    if (collapseSettingsPanel.dataset.ggTopDetailPanel === "true") return;
    const rect = collapseSettingsButton.getBoundingClientRect();
    const width = COLLAPSE_SETTINGS_PANEL_WIDTH;
    const left = Math.min(window.innerWidth - width - 10, Math.max(10, rect.right - width));
    const top = Math.min(window.innerHeight - collapseSettingsPanel.offsetHeight - 10, Math.max(10, rect.bottom + 8));
    collapseSettingsPanel.style.left = `${left}px`;
    collapseSettingsPanel.style.top = `${top}px`;
}

function closeCollapseSettingsPanel() {
    if (!collapseSettingsPanel) return;
    // 面板正挂在二级页里：交给顶栏收掉二级页（顺带复位面板到 body 并隐藏）
    if (collapseSettingsPanel.dataset.ggTopDetailPanel === "true") {
        window.__ggToggleTopDetailSubpage?.(COLLAPSE_TOP_BUTTON_ID);
        return;
    }
    collapseSettingsPanel.style.display = "none";
    collapseSettingsButton?.classList.remove("active");
}

function toggleCollapseSettings(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    // 齿轮位于顶栏菜单内时，二级页侧滑由顶栏统一接管（设计稿 5 ·03 / ·07）。
    // 本模块已在上方 stopPropagation，事件不会冒泡到顶栏委托处理器，故这里直接委托，
    // 避免「点了没反应」。确保面板已建好（不依赖顶栏 ensure 注册时序，避免加载竞态）。
    if (window.__ggTopToolsMenuOpen?.() === true && event?.target?.closest?.("#gg-top-tools-nav")) {
        if (!collapseSettingsPanel) { createCollapseSettingsPanel(); applySurface(collapseSettingsPanel); }
        window.__ggToggleTopDetailSubpage?.(COLLAPSE_TOP_BUTTON_ID);
        return;
    }
    const menuOpen = window.__ggTopToolsMenuOpen?.() === true;
    if (menuOpen) {
        createCollapseSettingsPanel();
        applySurface(collapseSettingsPanel);
        window.__ggToggleTopDetailSubpage?.(COLLAPSE_TOP_BUTTON_ID);
        collapseSettingsButton?.classList.add("active");
        return;
    }
    createCollapseSettingsPanel();
    const opening = collapseSettingsPanel.style.display !== "block";
    if (opening) {
        applySurface(collapseSettingsPanel);
        collapseSettingsPanel.style.display = "block";
        positionCollapseSettingsPanel();
        syncCollapseSettingsPanel();
        collapseSettingsButton?.classList.add("active");
    } else {
        closeCollapseSettingsPanel();
    }
}

function createCollapseTopButton() {
    if (collapseTopButton) return;
    // 折叠功能在顶部工具箱里做成一个按钮组：开关按钮 + 设置按钮（仿节点光效）。
    // 组容器带 TOP_TOOL_GROUPS 里登记的 id，工具箱据此把整组放进对应行。
    const host = document.createElement("div");
    host.id = COLLAPSE_TOP_BUTTON_ID;
    host.style.cssText = "display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;";
    collapseTopHost = host;

    collapseTopButton = document.createElement("button");
    collapseTopButton.type = "button";
    collapseTopButton.className = "gg-toolbar-top-button gg-ui-top-button gg-node-collapse-top-button";
    collapseTopButton.style.cssText = TOP_BUTTON_CSS;
    collapseTopButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = !collapseFeatureEnabled;
        applyCollapseFeatureEnabled(next);
        await setSettingValue(COLLAPSE_SETTING_ID, next);
    });

    collapseSettingsButton = document.createElement("button");
    collapseSettingsButton.type = "button";
    collapseSettingsButton.className = "gg-toolbar-top-button gg-ui-top-button gg-node-collapse-settings-button";
    collapseSettingsButton.title = "节点折叠设置";
    collapseSettingsButton.setAttribute("aria-label", "节点折叠设置");
    collapseSettingsButton.style.cssText = TOP_BUTTON_CSS;
    collapseSettingsButton.innerHTML = ggIcon("settings", 18);
    collapseSettingsButton.addEventListener("click", toggleCollapseSettings);

    host.append(collapseTopButton, collapseSettingsButton);
    document.body.appendChild(collapseTopHost);
    updateCollapseTopButton();
    placeCollapseTopButton();
}

function createPinTopButton() {
    if (pinTopButton) return;
    const host = document.createElement("div");
    host.id = PIN_TOP_BUTTON_ID;
    host.style.cssText = "display:inline-flex;align-items:center;flex:0 0 auto;";
    pinTopHost = host;

    pinTopButton = document.createElement("button");
    pinTopButton.type = "button";
    pinTopButton.className = "gg-toolbar-top-button gg-ui-top-button gg-node-pin-top-button";
    pinTopButton.style.cssText = TOP_BUTTON_CSS;
    pinTopButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = !pinFeatureEnabled;
        applyPinFeatureEnabled(next);
        await setSettingValue(PIN_SETTING_ID, next);
    });

    host.append(pinTopButton);
    document.body.appendChild(pinTopHost);
    updatePinTopButton();
    placePinTopButton();
}

function applyFeatureEnabled(value) {
    featureEnabled = value !== false;
    updateTopButton();
    refreshAllNodes();
}

function applyCollapseFeatureEnabled(value) {
    collapseFeatureEnabled = value !== false;
    updateCollapseTopButton();
    for (const node of getGraphNodes()) {
        if (!collapseFeatureEnabled) {
            node._ggPortListNodeHovered = false;
            node._ggPortListCollapseButtonHovered = false;
        }
    }
    refreshAllNodes();
}

function applyPinFeatureEnabled(value) {
    pinFeatureEnabled = value !== false;
    updatePinTopButton();
    for (const node of getGraphNodes()) {
        if (!pinFeatureEnabled) node._ggPortListPinButtonHovered = false;
    }
    refreshAllNodes();
}

window.__ggApplyPortListToggle = applyFeatureEnabled;
window.__ggApplyNodeCollapseButton = applyCollapseFeatureEnabled;
window.__ggApplyNodePinButton = applyPinFeatureEnabled;

// 折叠宽度改变时：给所有当前折叠的节点装上（或沿用）统一宽度 getter，
// getter 读取实时的 collapseFixedWidth，所以已装的节点自动跟随，只需重绘。
function applyCollapseWidthValue(value) {
    collapseFixedWidth = normalizeCollapseWidth(value);
    for (const node of getGraphNodes()) {
        if (isNodeCollapsed(node)) forceCollapsedWidth(node);
    }
    app.canvas?.setDirty?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    refreshAllNodes();
    syncCollapseSettingsPanel();
}

window.__ggApplyNodeCollapseWidthPadding = applyCollapseWidthValue;

app.registerExtension({
    name: "ComfyUI.GuliNodes.PortListToggle",

    async setup() {
        featureEnabled = getSettingValue(SETTING_ID, false) !== false;
        collapseFeatureEnabled = getSettingValue(COLLAPSE_SETTING_ID, true) !== false;
        pinFeatureEnabled = getSettingValue(PIN_SETTING_ID, true) !== false;
        collapseFixedWidth = normalizeCollapseWidth(
            getSettingValue(COLLAPSE_WIDTH_SETTING_ID, COLLAPSE_WIDTH_DEFAULT),
        );
        scheduleCanvasDrawingPatch();
        createTopButton();
        createCollapseTopButton();
        createPinTopButton();
        refreshAllNodes();

        document.addEventListener("pointerdown", (event) => {
            if (!collapseSettingsPanel || collapseSettingsPanel.style.display !== "block") return;
            if (collapseSettingsPanel.dataset.ggTopDetailPanel === "true") return;
            if (collapseSettingsPanel.contains(event.target) || collapseSettingsButton?.contains(event.target)) return;
            closeCollapseSettingsPanel();
        });
        window.addEventListener("resize", () => {
            if (collapseSettingsPanel?.style.display === "block" && collapseSettingsPanel.dataset.ggTopDetailPanel !== "true") positionCollapseSettingsPanel();
        });
    },

    nodeCreated(node) {
        scheduleCanvasDrawingPatch();
        installNode(node);
        refreshNode(node);
    },

    loadedGraphNode(node) {
        scheduleCanvasDrawingPatch();
        installNode(node);
        refreshNode(node);
    },

    afterConfigureGraph() {
        scheduleCanvasDrawingPatch();
        refreshAllNodes();
    },
});
