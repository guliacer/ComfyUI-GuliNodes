import { app } from "../../scripts/app.js";
import { paletteVars, detectHostTheme } from "./gg-ui-design.js";
import { isWidgetSkinEnabled, onWidgetSkinScopeChange } from "./gg-skin-scope.js";

// 单行多列布局引擎
// ------------------------------------------------------------------
// ComfyUI 的 canvas 渲染里，widget 是竖向堆的：`_arrangeWidgets` 给每个 widget
// 依次分配递增的 y，`drawWidgets` 按 `widget.y` 画，`getWidgetOnPos` 用
// `last_y` + `size[0]` 做整行命中。所以想「一行放三个控件」不能靠 CSS，
// 只能同时接管这三处：
//
//   1. `_arrangeWidgets` —— 让同一行的 widget 拿到相同的 y，并记下列偏移；
//   2. `drawWidgets` —— 画每个 widget 前 ctx.translate(列偏移)，宽度传列宽；
//   3. `getWidgetOnPos` —— 按列矩形命中，而不是整行。
//
// 还有第四处：concrete widget 的 onClick/onDrag 内部按 `e.canvasX - node.pos[0]`
// 算「控件内的相对 x」（左 40px 减一、右 40px 加一）。列里的控件如果直接用，
// 这个相对 x 会是整条节点的宽度，点哪都判成「加一」。所以派发点击时临时把
// node.pos[0] 左移列偏移，让控件自己算出来的相对坐标落在列内，调用完立刻还原。
//
// 这四个点都在同一个模块里，其余节点只要登记一份列配置即可复用。

const ENGINE_KEY = "_ggRowLayout";
const ROW_GAP = 4;      // 行距：和 ComfyUI 默认 widget 间距一致
const COL_GAP = 8;      // 列距
const SIDE = 15;        // 控件形状左右内边距 = BaseWidget.margin（前端源码里就是 15）
const HIT_PAD = 4;      // 命中区比形状略宽一点，贴着列边走也能点到

// 列宽估算用的字宽缓存。控件文字在这个前端固定是 12px Inter（画布文字层
// 用 14px，控件内部自己降到 12px），换主题字号也不会变，所以写死并缓存。
const TEXT_FONT = "12px Inter, sans-serif";

// ------------------------------------------------------------------
// 画布控件统一皮肤：field 底 + divider 边 + 圆角 6，标签 muted 左、值 ink 右。
// 颜色全部取自 gg-ui-design 的 --gg-* 令牌，主题跟随宿主画布明暗，按秒缓存。
// 只改观感：命中区完全沿用官方语义（数值左右 40px 增量、toggle/button 整格点击）。
// ------------------------------------------------------------------
let skinCache = null;
let skinCacheAt = 0;

function skin() {
    const now = Date.now();
    if (skinCache && now - skinCacheAt < 1000) {
        return skinCache;
    }
    const mode = detectHostTheme();
    const vars = paletteVars(mode);
    const dark = mode !== "light";
    const pick = (name, fallback) => vars[name] ?? fallback;
    // fallback 与 gg-ui-design.js 的 PALETTES 定稿值同源（2026-11-08 设计稿落地）。
    // 只在 CSS 变量尚未注入时生效，但两处不同步会让首帧出现旧蓝 / 新蓝混色。
    skinCache = {
        field: pick("--gg-field", dark ? "#0F131B" : "#FFFFFF"),
        divider: pick("--gg-divider", dark ? "#262F3D" : "#DDE5F0"),
        ink: pick("--gg-ink", dark ? "#EEF2F8" : "#16202E"),
        muted: pick("--gg-muted", dark ? "#97A3B6" : "#4A5A72"),
        faint: pick("--gg-faint", dark ? "#6B7688" : "#6B7A90"),
        accent: pick("--gg-accent", dark ? "#4C8DFF" : "#2563EB"),
        btn: pick("--gg-btn", dark ? "#222C3E" : "#EEF2F8"),
        btnHover: pick("--gg-btn-hover", dark ? "#2C384C" : "#E1E8F4"),
        // 参数名（提示侧）的独立底：比 field 亮一档，和右侧实际取值拉开层次。
        labelBg: pick("--gg-btn", dark ? "#222C3E" : "#EEF2F8"),
        // 胶囊投影：浅色用冷灰软影，深色用纯黑软影，都只往下偏移，读起来像浮起一层。
        shadow: dark ? "rgba(0,0,0,0.55)" : "rgba(28,40,62,0.24)",
        highlight: dark ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.85)",
        pickedBg: pick("--gg-picked-bg", dark ? "#1B3466" : "#DCE9FD"),
        ok: pick("--gg-ok", dark ? "#3DD68C" : "#059669"),
    };
    skinCacheAt = now;
    return skinCache;
}

// 可皮肤化的控件：canvas 自绘、单行、无 DOM 元素。多行文本 / 图像预览 /
// gg_* 自绘块 / 带 element 的控件一律交回官方绘制，视觉与交互都不碰。
// `color` 必须包含：ComfyUI 的 ColorWidget 是单行 canvas 自绘（无 DOM element），
// 官方画法是 20px 高扁灰条 + 40×14 色块，和 24px 胶囊完全不是一套。漏掉它就会
// 出现「整节点只有这一行是灰扁条」的错漏，且动态显隐的 color 更容易被漏测。
const SKINNABLE_TYPES = new Set(["combo", "number", "toggle", "button", "text", "color"]);

function skinnable(widget) {
    if (!widget || widget.element || widget.inputEl) {
        return false;
    }
    const type = String(widget.type ?? "").toLowerCase();
    if (!SKINNABLE_TYPES.has(type)) {
        return false;
    }
    // 高度只用来挡「明显是多行」的误判，不该决定换不换肤：官方
    // NODE_WIDGET_HEIGHT=20，但标准单行控件的 computedHeight 普遍是 24，个别
    // （对比 2 张的 Mode）是 32。沿用旧的 <= 20*1.4=28 会把这些控件挡掉，
    // 于是整节点只有这几行还画官方 20px 灰扁条。真正的多行控件都有 element /
    // inputEl 或 type 不在白名单，前面已经挡掉了，这里放宽到 2.5 倍兜底即可。
    const height = widget.computedHeight ?? widget.computeSize?.(400)?.[1] ?? widgetHeight();
    return Number.isFinite(height) && height <= widgetHeight() * 2.5;
}

function truncateToWidth(ctx, text, maxW) {
    if (maxW <= 0) {
        return "";
    }
    if (ctx.measureText(text).width <= maxW) {
        return text;
    }
    let value = text;
    while (value.length > 1 && ctx.measureText(`${value}…`).width > maxW) {
        value = value.slice(0, -1);
    }
    return `${value}…`;
}

// 颜色值归一成 #rrggbb：ColorWidget 可能存 #RGB / r,g,b / 0~255 整数，
// 画色块和显示十六进制文本都必须先归一，否则 fillStyle 拿到非法值会整块不画。
function normalizeHexColor(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
    }
    const text = String(value ?? "").trim();
    const rgb = /^\(?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)?$/.exec(text);
    if (rgb) {
        const body = rgb.slice(1, 4).map((part) => Math.min(255, Math.max(0, Math.round(Number(part))))
            .toString(16).padStart(2, "0")).join("");
        return `#${body}`;
    }
    if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) {
        let body = text.replace(/^#/, "").toLowerCase();
        if (body.length === 3) {
            body = body.split("").map((ch) => ch + ch).join("");
        }
        return `#${body}`;
    }
    return "#000000";
}

// 「提示」侧：参数名单独铺一块底 + 右缘细线，与右半边的实际取值拉开层次。
// maxTextW 由调用方按「值文字宽」算好，chip 自己再截断一次，保证不越出形状。
function paintLabelChip(ctx, C, x, y, w, h, label, maxTextW, padX) {
    const text = truncateToWidth(ctx, label, maxTextW);
    const chipW = Math.min(
        Math.max(16, ctx.measureText(text).width + 12),
        Math.max(16, w - padX - 6),
    );
    const body = truncateToWidth(ctx, text, chipW - 12);
    const chipX = x + padX - 6;
    const chipY = y + 3;
    const chipH = Math.max(8, h - 6);
    ctx.beginPath();
    ctx.roundRect(chipX, chipY, chipW, chipH, 4);
    ctx.fillStyle = C.labelBg;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(chipX + chipW, chipY + 3);
    ctx.lineTo(chipX + chipW, chipY + chipH - 3);
    ctx.strokeStyle = C.divider;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = C.muted;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(body, chipX + 6, y + h / 2 + 1);
    // 返回提示块右缘：取值文字必须从这里往右画，长文件名才不会压到提示块上。
    return chipX + chipW;
}

// 胶囊底格：field 填充 + 投影 + 描边 + 顶边高光。
// 单独导出给「自绘列」复用（LoRA 启用列的手柄 + 勾选框就是自绘的），
// 否则那一列会绕过皮肤、变成三列里唯一没有底格和阴影的一格。
// 只画底：调用方自己 save/restore 管后续文字，字体由外层保证。
export function widgetBaseColors(widget) {
    const lite = globalThis.LiteGraph;
    return {
        field: widget?.background_color ?? lite?.WIDGET_BGCOLOR ?? "#222222",
        divider: widget?.getOutlineColor?.() ?? lite?.WIDGET_OUTLINE_COLOR ?? "#666666",
        ink: widget?.text_color ?? lite?.WIDGET_TEXT_COLOR ?? "#dddddd",
        muted: widget?.secondary_text_color ?? lite?.WIDGET_SECONDARY_TEXT_COLOR ?? "#999999",
    };
}

export function paintCapsuleBase(ctx, x, y, w, h, showText, emphasize = false, node = null, widget = null) {
    if (!isWidgetSkinEnabled(node)) {
        const C = widgetBaseColors(widget);
        const height = Math.min(h, globalThis.LiteGraph?.NODE_WIDGET_HEIGHT ?? 20);
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.beginPath();
        ctx.roundRect(x, y + (h - height) / 2, w, height, height / 2);
        ctx.fillStyle = C.field;
        ctx.fill();
        ctx.strokeStyle = C.divider;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
        return;
    }
    const C = skin();
    ctx.save();
    ctx.font = TEXT_FONT;
    ctx.save();
    ctx.shadowColor = showText ? C.shadow : "rgba(0,0,0,0)";
    ctx.shadowBlur = showText ? 7 : 0;
    ctx.shadowOffsetY = showText ? 2 : 0;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.fillStyle = C.field;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.lineWidth = 1;
    ctx.strokeStyle = emphasize ? C.accent : C.divider;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + 7, y + 1);
    ctx.lineTo(x + w - 7, y + 1);
    ctx.strokeStyle = C.highlight;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
}

// 统一形态绘制。hovered 由 drawWidgets 用画布指针位置算好传进来。
function drawSkinned(ctx, node, widget, column, showText, hovered) {
    if (!isWidgetSkinEnabled(node) || !skinnable(widget)) {
        return false;
    }
    const C = skin();
    const type = String(widget.type ?? "").toLowerCase();
    // 列矩形两侧各带一个 margin（SIDE），形状本体只占中间那段 need：
    //   rect.x = cursor - SIDE, rect.w = need + SIDE*2, cursor += need + colGap
    // 所以真正不重叠的绘制区间是 [x+SIDE, x+w-SIDE]，相邻两格之间正好留 colGap。
    // 之前这里直接拿整个列矩形 roundRect，左右各多吃 15px，两列必叠
    // (SIDE*2 - colGap) = 22px；getWidgetOnPos 的命中区也一直按内缩后的形状算，
    // 绘制与命中对不上。这里统一成同一套坐标。
    const x = column.x + SIDE;
    const w = Math.max(20, column.w - SIDE * 2);
    const y = widget.y;
    // 胶囊统一按本前端标准控件高度（24）：个别控件申报 32（对比 2 张的 Mode），
    // 直接照它画会比同节点其它胶囊高一截。钳到 24 后仍落在官方 32 的槽里，
    // 命中区继续按 widget.computedHeight 走官方语义，点击不受影响。
    const h = Math.min(widget.computedHeight ?? widgetHeight(), Math.max(widgetHeight(), 24));
    const label = showText ? String(widget.displayName ?? widget.label ?? widget.name ?? "").trim() : "";
    const value = showText ? displayValue(widget) : "";

    ctx.save();
    ctx.font = TEXT_FONT;
    // 底格与投影统一走 paintCapsuleBase：描边/文字在它之后画，边框和字不发糊。
    paintCapsuleBase(ctx, x, y, w, h, showText, hovered && type !== "button", node, widget);

    const padX = 10;
    if (type === "button") {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 6);
        ctx.fillStyle = hovered ? C.btnHover : C.btn;
        ctx.fill();
        if (showText) {
            ctx.fillStyle = C.ink;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(truncateToWidth(ctx, label || value, w - 20), x + w / 2, y + h / 2 + 1);
        }
        ctx.restore();
        return true;
    }

    if (type === "toggle") {
        // 胶囊开关贴右：开 = pickedBg 底 + accent 点，关 = 灰底 + faint 点
        const knobH = h - 8;
        const knobW = knobH * 2 - 2;
        const kx = x + w - knobW - 6;
        const ky = y + 4;
        const on = widget.value === true;
        ctx.beginPath();
        ctx.roundRect(kx, ky, knobW, knobH, knobH / 2);
        ctx.fillStyle = on ? C.pickedBg : "rgba(127,138,156,0.18)";
        ctx.fill();
        ctx.strokeStyle = on ? C.accent : C.divider;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(on ? kx + knobW - knobH / 2 : kx + knobH / 2, y + h / 2, knobH / 2 - 3, 0, Math.PI * 2);
        ctx.fillStyle = on ? C.accent : C.faint;
        ctx.fill();
        if (label) {
            paintLabelChip(ctx, C, x, y, w, h, label, w - knobW - 24, padX);
        }
        ctx.restore();
        return true;
    }

    if (type === "color") {
        // 颜色格沿用胶囊：左参数名提示块、中间十六进制值、最右色块。
        // 官方 ColorWidget 自己画的是 20px 扁灰条 + 40×14 色块，这里全部接管，
        // 不改 widget 的 onClick / 序列化，点击仍走系统取色器或 gg-solid-color 的编辑器。
        const hex = normalizeHexColor(widget.value);
        const swatchW = Math.min(40, Math.max(24, w * 0.2));
        const swatchH = Math.max(10, h - 10);
        const swatchX = x + w - swatchW - 8;
        const valueRight = swatchX - 8;
        if (showText && label) {
            paintLabelChip(ctx, C, x, y, w, h, label,
                Math.max(20, valueRight - (x + padX) - ctx.measureText(hex).width - 16), padX);
        }
        if (showText) {
            ctx.fillStyle = C.ink;
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillText(truncateToWidth(ctx, hex, Math.max(12, valueRight - (x + padX) - 8)),
                valueRight, y + h / 2 + 1);
        }
        ctx.beginPath();
        ctx.roundRect(swatchX, y + (h - swatchH) / 2, swatchW, swatchH, 4);
        ctx.fillStyle = hex;
        ctx.fill();
        ctx.strokeStyle = C.divider;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
        return true;
    }

    // 窄列数值格（LoRA 强度这种 9% 权重列，形状只有 ~37px）：
    // 通用画法给左侧 10px padding、右侧 24px 增量箭头，值可用宽会算成负数，
    // 整格显示空白；官方 onClick 也会把整格当成「右侧 40px 增量区」不弹输入框。
    // 这里改成紧凑画法：不画标签块、不留箭头、值居中，胶囊底/描边/投影照常。
    // 触发条件：列太窄，或标签本来就是空（LoRA 强度格把 label 设成空格）。
    // 节点被拉很宽时强度列也会变宽，仍走紧凑画法，视觉保持一致。
    if (type === "number" && (w < 80 || !label)) {
        const precision = Number(widget?.options?.precision);
        const digits = Number.isFinite(precision) && precision >= 0
            ? Math.min(4, precision)
            : null;
        const raw = Number(widget?.value);
        const text = digits !== null && Number.isFinite(raw)
            ? raw.toFixed(digits)
            : displayValue(widget);
        if (showText && text) {
            ctx.fillStyle = C.ink;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            // LoRA 强度等空标签紧凑数值是状态本身，不能省略成「1…」。
            // 必要时缩小字体以完整呈现，保留数值而不是截断。
            const baseFont = ctx.font;
            const maxWidth = Math.max(1, w - 8);
            const measured = ctx.measureText(text).width;
            if (measured > maxWidth && measured > 0) {
                const sizeMatch = /([\\d.]+)px/.exec(baseFont);
                const baseSize = Number(sizeMatch?.[1]) || 12;
                ctx.font = baseFont.replace(/[\\d.]+px/, `${Math.max(7, baseSize * maxWidth / measured)}px`);
            }
            ctx.fillText(text, x + w / 2, y + h / 2 + 1);
            ctx.font = baseFont;
        }
        ctx.restore();
        return true;
    }

    // combo / number / text：标签 muted 左，值 ink 右对齐
    let valueRight = x + w - padX;
    if (type === "combo") {
        // 下拉小三角（faint）占右侧 14px，值给它让位
        ctx.beginPath();
        ctx.moveTo(x + w - 16, y + h / 2 - 3);
        ctx.lineTo(x + w - 10, y + h / 2 - 3);
        ctx.lineTo(x + w - 13, y + h / 2 + 2);
        ctx.closePath();
        ctx.fillStyle = C.faint;
        ctx.fill();
        valueRight = x + w - 24;
    } else if (type === "number") {
        // 增量命中区沿用官方左右 40px 语义；右箭头只在悬停行显现
        if (hovered) {
            ctx.beginPath();
            ctx.moveTo(x + w - 14, y + h / 2 - 4);
            ctx.lineTo(x + w - 8, y + h / 2);
            ctx.lineTo(x + w - 14, y + h / 2 + 4);
            ctx.closePath();
            ctx.fillStyle = C.muted;
            ctx.fill();
        }
        valueRight = x + w - 24;
    }
    // 取值文字的左边界从提示块右缘算起，而不是胶囊左内边距：长模型文件名
    // 右对齐画过来时会一直顶到 x+padX，把提示块的字盖住（提示词增强的两个
    // PE 模型下拉就是这么糊成一团的）。
    let valueLeft = x + padX;
    if (showText && label) {
        // 长取值（模型文件名 / 路径）本来就要截断，不能拿它的**完整**宽度去挤
        // 提示块，否则「文生图PE模型」会被压成「文…」。按「值最多占半格」留位，
        // 提示块尽量显示完整标签，剩下的空间才交给取值文字自己截断。
        const labelTextW = ctx.measureText(label).width;
        const valueTextW = Math.min(ctx.measureText(value).width, w * 0.5);
        const labelMax = Math.max(20, Math.min(labelTextW + 12,
            valueRight - (x + padX) - valueTextW - 8));
        valueLeft = paintLabelChip(ctx, C, x, y, w, h, label, labelMax, padX) + 6;
    }
    if (showText && value) {
        ctx.fillStyle = C.ink;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(truncateToWidth(ctx, value, Math.max(12, valueRight - valueLeft - 4)),
            valueRight, y + h / 2 + 1);
    }
    ctx.restore();
    return true;
}
// 一行里「文字之外」的开销，抄前端 BaseWidget.drawTruncatingText 的口径：
//   可用文字宽 = width - (margin*2 + leftPadding 5) - margin*2 - rightPadding 20
//              = width - 85        （margin = 15）
//   需要文字宽 = 标签 + labelValueGap 5 + 数值
// 于是传给控件的 width 得 >= 「标签 + 数值 + 90」。
// 但我们传给 widget.draw 的是 column.w，它已经 = 列宽 need + SIDE*2 = need + 30
// （见 packedRects / columnRects：列矩形两侧各多带一个 margin，形状本身才是 need）。
// 代进去：need + 30 >= 标签 + 数值 + 90  →  need >= 标签 + 数值 + 60。
// 之前按 90 算，等于每个控件白多撑 30px，一行 3~4 个就是 90~120px 的空白。
const TEXT_CHROME = 60;
// BooleanWidget 不走 drawTruncatingText：drawLabel 从 x=margin*2 画标签，
// drawValue 把值右对齐到 width-40（右侧还要让给那个小圆点）。
//   中间空白 = width - 70 - 标签 - 数值
// 代入 width = need + 30：空白 = need - 40 - 标签 - 数值。
// need 取「标签 + 数值 + 46」时空白 6px；沿用 60 会白留 20px（截图里
// 「清内存    true」那一大片就是这么来的）。
const BOOL_CHROME = 46;
// 数值/文本控件里装的是模型名、文件路径这种长字符串时，不要按它撑列宽，
// 否则一个 `qwen\qwen3.5_9b_qwen_ima` 就能把节点顶到 1200px。超出的部分由控件
// 自己截断（这也是 ComfyUI 原生的处理方式），给的宽度到上限为止。
// 下拉的取值是模型文件名，长得有意义、`主 …` 那种被切掉标签的样子更不能接受，
// 所以下拉/数值给 220px 的额度；自由文本（路径、提示词）给 130px。
const MAX_TEXT_VALUE_PX = 130;
const MAX_CHOICE_VALUE_PX = 220;
// autoWrap 节点的宽度搜索区间：从窄往宽找「刚好放得下这么多行」的那条线。
// 上限 640 是「再宽就不像节点、像面板」的那条线：控件多的节点宁肯多一行，
// 也别横着拖出去把小节点挤到画布外。
const AUTO_MIN_WIDTH = 260;
const AUTO_MAX_WIDTH = 640;
// 「两行方案」如果撑到这条线以上，就宁可多一行换来更窄的节点。
// 420 是画布上一个节点横着不挡路的宽度；超过它，三行比两行更顺眼。
const PREFERRED_MAX_WIDTH = 420;
// 内容宽再小也不让节点窄过这条线：标题栏的文字、右侧输出圆点需要地方。
// 实测最短标题约 120px、加 38 内衬后 158，180 足够；再窄标题自己会被截。
const MIN_NODE_WIDTH = 180;
// gg-node-autofit.js 在用户真的拖过节点边时，把尺寸记在这个字段上。
// 有这个标记就说明宽度是用户自己定的，行布局不再把节点撑回内容宽。
const MANUAL_SIZE_FLAG = "_ggAutoFitManualSize";
// 少数节点被 autofit 排除（GGImageSuperResolution 等），不会写上面那个字段，
// 行布局自己补记一份，保证「拖窄留得住」对所有登记过的节点都成立。
const MANUAL_WIDTH_FLAG = "_ggRowLayoutManualWidth";
// 用户真的把节点拖高过：高度由用户说了算，applyHeight 不许再按内容缩回去。
const MANUAL_HEIGHT_FLAG = "_ggRowLayoutManualHeight";
/** comfyClass → 布局配置 */
const LAYOUTS = new Map();

export function registerRowLayout(comfyClass, config) {
    if (!comfyClass || !config) {
        return;
    }
    LAYOUTS.set(comfyClass, config);
}

export function hasRowLayout(comfyClass) {
    return LAYOUTS.has(comfyClass);
}

function widgetHeight() {
    return globalThis.LiteGraph?.NODE_WIDGET_HEIGHT ?? 24;
}

let measureCtx = null;
const textWidthCache = new Map();

function textWidth(text) {
    const key = String(text ?? "");
    const cached = textWidthCache.get(key);
    if (cached !== undefined) {
        return cached;
    }
    if (!measureCtx) {
        measureCtx = document.createElement("canvas").getContext("2d");
        measureCtx.font = TEXT_FONT;
    }
    const width = measureCtx.measureText(key).width;
    // 数值会变，缓存加上限，别让它无限长
    if (textWidthCache.size > 600) {
        textWidthCache.clear();
    }
    textWidthCache.set(key, width);
    return width;
}

// 控件真正画出来的取值文本。NumberWidget 的 _displayValue 是
// `toFixed(options.precision)`：value=1 / precision=1 会显示 "1.0"，
// value=0.9 / precision=2 会显示 "0.90"，比 String(value) 长 8~11px。
// 按 value 量宽就会把标签挤成省略号（实测 GGZImageSampler 的「引导」「降噪」）。
// ComboWidget 的 getOptionLabel 也走同一个 getter，所以这里一律以它为准。
function displayValue(widget) {
    try {
        const shown = widget?._displayValue;
        if (shown !== undefined && shown !== null) {
            return String(shown);
        }
    } catch {
        // getter 在控件还没挂到节点上时可能抛，退回原始值
    }
    return String(widget?.value ?? "");
}

// 一个控件排成一行时不压缩、也要完整显示，需要多宽（含内边距与箭头）。
// uncapped = true 时不吃「取值额度」：用在「节点被拉宽、富余宽度补给长取值」的场合。
function requiredWidth(widget, uncapped = false) {
    if (!widget) {
        return 0;
    }
    const label = String(widget.displayName ?? widget.label ?? widget.name ?? "").trim();
    const value = displayValue(widget);
    const type = String(widget.type ?? "").toLowerCase();
    // 按钮只画一次文字（居中），label 和 value 是同一个字符串，按两份量会虚胖一倍。
    if (type === "button") {
        return Math.ceil(Math.max(textWidth(label), textWidth(value)) + 44);
    }
    const isChoice = type === "combo" || type === "number" || Array.isArray(widget.options?.values);
    const cap = uncapped
        ? Number.POSITIVE_INFINITY
        : (isChoice ? MAX_CHOICE_VALUE_PX : MAX_TEXT_VALUE_PX);
    const valueWidth = Math.min(textWidth(value), cap);
    const chrome = type === "toggle" ? BOOL_CHROME : TEXT_CHROME;
    return Math.ceil(textWidth(label) + valueWidth + chrome);
}

// 配置里可以给控件换个更短的显示名（只改 label，不动 name 与序列化）。
function applyLabels(node, config) {
    const labels = config?.labels;
    if (!labels) {
        return;
    }
    for (const widget of node.widgets ?? []) {
        // DynamicCombo 的子控件名字是「宽高方式.宽高比例」，按最后一段匹配
        const key = String(widget.name ?? "").split(".").pop();
        const label = labels[key];
        if (label && widget.label !== label) {
            widget.label = label;
        }
    }
}

function hasConnectedWidgetInput(node, widget) {
    const name = widget?.name;
    if (!name || !Array.isArray(node?.inputs)) {
        return false;
    }
    return node.inputs.some((input) => input?.widget?.name === name && input.link != null);
}

// 「布局外控件」：DOM 预览一类的控件由宿主自己定位并分配高度，不进我们的行布局。
// 判据由业务扩展打标（见 gg-image-compress-save.js 的 $$canvas-image-preview），
// 不在引擎里硬编码控件名，换前端版本也不用回来改。注意它仍然要被绘制，
// 所以只从「分行」里剔除，不从 isWidgetShown 里剔除。
function isLayoutOutside(widget) {
    return widget?._ggRowLayoutOutside === true;
}

function isWidgetShown(node, widget) {
    if (!widget || String(widget.type ?? "").startsWith("ggHidden")) {
        return false;
    }
    if (widget.hidden && !hasConnectedWidgetInput(node, widget)) {
        return false;
    }
    try {
        return node.isWidgetRowVisible ? node.isWidgetRowVisible(widget) : true;
    } catch {
        return true;
    }
}

// 每行放几个、按什么权重分宽度，由节点自己决定；没写就均分。
function resolveRows(node, config, shownOverride = null) {
    const shown = shownOverride
        ?? (node.widgets ?? []).filter((widget) => isWidgetShown(node, widget));
    if (typeof config.rows === "function") {
        return config.rows(node, shown).filter((row) => Array.isArray(row) && row.length);
    }

    const fullWidth = config.fullWidth ?? (() => false);
    const columns = Math.max(1, config.columns ?? 3);
    const rows = [];
    let current = [];
    for (const widget of shown) {
        if (fullWidth(widget, node)) {
            if (current.length) {
                rows.push(current);
                current = [];
            }
            rows.push([widget]);
            continue;
        }
        current.push(widget);
        if (current.length >= columns) {
            rows.push(current);
            current = [];
        }
    }
    if (current.length) {
        rows.push(current);
    }
    return rows;
}

// 「3 个挤一行 + 1 个孤零零」很难看，把前一行末尾那个挪到后一行凑成 2+2。
function nudgeTail(parts, available, gap = COL_GAP) {
    for (let index = 0; index < parts.length - 1; index += 1) {
        const head = parts[index];
        const tail = parts[index + 1];
        if (head.length < 3 || tail.length !== 1) {
            continue;
        }
        const candidate = head[head.length - 1];
        const width = tail.reduce((sum, widget) => sum + requiredWidth(widget), 0)
            + requiredWidth(candidate)
            + gap * tail.length;
        if (width <= available) {
            head.pop();
            tail.unshift(candidate);
        }
    }
    return parts;
}

// 把一串控件切成若干行。两步 DP：
//   ① 先求最少要几行（每行宽度 = 各控件所需宽之和 + 列距）；
//   ② 在「行数已经最少」的前提下，让最宽那行尽量窄 —— 也就是尽量均分，
//      免得出现 `[A,B,C] / [D]` 这种一头沉。
// 单个控件本身就比可用宽度还宽时（标签特别长），允许它独占一行硬塞，
// 否则 DP 会算成无解。
function partition(items, available, gap = COL_GAP) {
    const count = items.length;
    if (count <= 1) {
        return [items.slice()];
    }
    const needs = items.map((widget) => requiredWidth(widget));
    const rowWidth = (start, end) => {
        let sum = gap * (end - start - 1);
        for (let index = start; index < end; index += 1) {
            sum += needs[index];
        }
        return sum;
    };

    const INF = Number.POSITIVE_INFINITY;
    const minRows = new Array(count + 1).fill(INF);
    minRows[0] = 0;
    for (let end = 1; end <= count; end += 1) {
        for (let start = 0; start < end; start += 1) {
            if (minRows[start] === INF) {
                continue;
            }
            if (end - start > 1 && rowWidth(start, end) > available) {
                continue;
            }
            minRows[end] = Math.min(minRows[end], minRows[start] + 1);
        }
    }
    const rowsCount = minRows[count] === INF ? count : minRows[count];

    const widest = Array.from({ length: count + 1 }, () => new Array(rowsCount + 1).fill(INF));
    const from = Array.from({ length: count + 1 }, () => new Array(rowsCount + 1).fill(-1));
    widest[0][0] = 0;
    for (let used = 1; used <= rowsCount; used += 1) {
        for (let end = 1; end <= count; end += 1) {
            for (let start = 0; start < end; start += 1) {
                if (widest[start][used - 1] === INF) {
                    continue;
                }
                const width = rowWidth(start, end);
                if (end - start > 1 && width > available) {
                    continue;
                }
                const candidate = Math.max(widest[start][used - 1], width);
                if (candidate < widest[end][used]) {
                    widest[end][used] = candidate;
                    from[end][used] = start;
                }
            }
        }
    }

    if (from[count][rowsCount] < 0) {
        return [items.slice()];
    }
    const parts = [];
    let end = count;
    for (let used = rowsCount; used > 0; used -= 1) {
        const start = from[end][used];
        parts.unshift(items.slice(start, end));
        end = start;
    }
    return parts;
}

// autoWrap 的入口：把 resolveRows 分出来的各组摊平成一串，统一按宽度重新切行。
// 独占整行的控件（多行文本、图像预览、自绘块）保持原样，不参与摊平。
function wrapRows(rows, available, alone, gap = COL_GAP) {
    const parts = [];
    let pending = [];
    const flush = () => {
        if (pending.length) {
            parts.push(...partition(pending, available, gap));
            pending = [];
        }
    };
    for (const row of rows) {
        for (const widget of row) {
            if (alone(widget)) {
                flush();
                parts.push([widget]);
                continue;
            }
            pending.push(widget);
        }
    }
    flush();
    return nudgeTail(parts, available, gap);
}

/**
 * 流式（flex-wrap）分行：按声明顺序从头往右塞，塞不下就换行，不回头重排。
 * 节点默认很窄时每行只有一个控件；用户拉宽，后面的控件就逐个被提到同一行，
 * 行数自然变少。和 partition 的「先求最少行数再均分」不是一套口径。
 */
function flowRows(rows, available, alone, gap = COL_GAP, maxColumns = Number.POSITIVE_INFINITY) {
    const parts = [];
    let current = [];
    let used = 0;
    const flush = () => {
        if (current.length) {
            parts.push(current);
            current = [];
            used = 0;
        }
    };
    for (const row of rows) {
        for (const widget of row) {
            if (alone(widget)) {
                flush();
                parts.push([widget]);
                continue;
            }
            const need = Math.max(40, requiredWidth(widget));
            const extra = current.length ? gap + need : need;
            // 单个控件比整行还宽也让它独占一行硬塞，别让 DP/贪心算成无解。
            // maxColumns 让「拉宽一格才多并进来一个配置」，默认宽度下严格单列。
            if (current.length && (used + extra > available || current.length >= maxColumns)) {
                flush();
            }
            current.push(widget);
            used += current.length > 1 ? gap + need : need;
        }
    }
    flush();
    return parts;
}

// 一组行排下来「真正需要多宽」：取最宽那一行的内容宽（各列所需宽 + 列距 + 两侧内衬）。
// 独占整行的控件（多行文本、图像预览）不参与 —— 它们本来就该拉满，不该反过来决定节点宽度。
// 返回值就是「再窄就放不下」的那条线，节点宽度直接贴着它，行尾不会留一大截空白。
function contentWidth(rows, gap = COL_GAP, widthOverride = null) {
    let widest = 0;
    for (const row of rows) {
        if (!row || row.length <= 1) {
            continue;
        }
        let sum = gap * (row.length - 1);
        for (const widget of row) {
            sum += Math.max(40, widthOverride?.(widget) ?? requiredWidth(widget));
        }
        widest = Math.max(widest, sum + SIDE * 2);
    }
    return widest;
}

// 「必须独占一行」的判定：多行文本框（高度超过一行的两倍）、图像/预览类、
// 以及插件自己画的自绘控件（gg_* 前缀）。
function isAloneWidget(node, widget, config, nodeWidth) {
    const fullWidth = config?.fullWidth;
    if (typeof fullWidth === "function" && fullWidth(widget, node)) {
        return true;
    }
    const type = String(widget?.type ?? "").toLowerCase();
    if (type === "image" || type === "image_preview") {
        return true;
    }
    if (type.startsWith("gg_") && !type.startsWith("gghidden")) {
        return true;
    }
    const height = widget?.computedHeight
        ?? widget?.computeSize?.(nodeWidth ?? 400)?.[1];
    return Number.isFinite(height) && height > widgetHeight() * 1.4;
}

// 把一行按权重切成一列列矩形。返回的 x/w 已经含左右内边距：
// 形状实际区间是 [x + SIDE, x + w - SIDE]。
// 紧凑排法：每列只拿「自己完整显示需要的宽度」，从左边依次贴紧，剩下的空间留在
// 行尾不用。这样标签和数值之间只隔固定的 35px 内衬，不会被拉成一大片空白。
// 官方控件是「标签左对齐、数值右对齐」，列给宽一格，空白就多一格。
//
// 节点被拉宽时（宽 > 紧凑宽度）多出来的地方有两种用法：
//   · 先补给「取值被额度截断」的列 —— 长模型名、长路径能多露几个字，这才是有用的宽度；
//   · 补完还有剩，就留在行尾不用，绝不摊到所有列去制造空白。
function packedRects(nodeWidth, widgets, gap = COL_GAP, allowSurplus = true, widthOverride = null) {
    const usable = Math.max(40, nodeWidth - SIDE * 2);
    const gaps = gap * Math.max(0, widgets.length - 1);
    // columnWidth 钩子：自绘列（勾选框这类只画一小格的）按它申报的宽度算，
    // 不然官方控件的全套内衬（标签 + 值 + 46/60）会把格子撑出一大截死空白。
    const overridden = (widget) => {
        const value = widthOverride?.(widget);
        return Number.isFinite(value) && value > 0 ? Math.max(40, value) : null;
    };
    const tight = widgets.map((widget) => overridden(widget) ?? Math.max(40, requiredWidth(widget)));
    const full = widgets.map((widget) => overridden(widget) ?? Math.max(40, requiredWidth(widget, true)));
    const needs = tight.slice();

    // flow 节点不补给长取值列：富余一律留在行尾。补宽会把「标签左 / 数值右」
    // 的控件中间重新拉开一大片空白，正是要消掉的东西。
    let surplus = allowSurplus
        ? usable - gaps - tight.reduce((sum, value) => sum + value, 0)
        : 0;
    if (surplus > 0) {
        for (let index = 0; index < needs.length && surplus > 0; index += 1) {
            const room = full[index] - tight[index];
            if (room <= 0) {
                continue;
            }
            const take = Math.min(surplus, room);
            needs[index] += take;
            surplus -= take;
        }
    }

    // 只在「节点比这一行还窄」（用户手动拉窄）时才按比例压一下
    const sum = needs.reduce((total, value) => total + value, 0);
    const scale = sum + gaps > usable ? Math.max(0, usable - gaps) / Math.max(20, sum) : 1;

    const rects = [];
    let cursor = SIDE;
    for (const need of needs) {
        const width = Math.max(20, Math.floor(need * scale));
        rects.push({ x: cursor - SIDE, w: width + SIDE * 2 });
        cursor += width + gap;
    }
    return rects;
}

function columnRects(nodeWidth, count, weights, gap = COL_GAP) {
    const left = SIDE;
    const usable = Math.max(40, nodeWidth - SIDE * 2);
    const gaps = gap * Math.max(0, count - 1);
    const content = Math.max(20, usable - gaps);

    const raw = [];
    for (let index = 0; index < count; index += 1) {
        raw.push(Math.max(0.01, Number(weights?.[index]) || 1));
    }
    const total = raw.reduce((sum, value) => sum + value, 0);

    const rects = [];
    let cursor = left;
    for (let index = 0; index < count; index += 1) {
        const width = Math.floor((content * raw[index]) / total);
        rects.push({ x: cursor - SIDE, w: width + SIDE * 2 });
        cursor += width + gap;
    }
    return rects;
}

// 用户拖过节点边之后留下的宽度。三套标记都认：autofit 排除的节点没有前者，
// 读档刚重建的节点两套内存标记都还没认领，只有 properties 里的持久化副本在。
// 少了第三个来源，configure 里那次 computeSize() 会按默认 minWidth 把节点撑回
// 默认宽（实测拖窄到 224 的节点读档后变 244），之后再认领也只会加宽、不会缩回。
function manualWidthOf(node) {
    const rowManual = Number(node?.[MANUAL_WIDTH_FLAG]) || 0;
    const autoManual = Array.isArray(node?.[MANUAL_SIZE_FLAG])
        ? Number(node[MANUAL_SIZE_FLAG][0]) : 0;
    const savedUser = Array.isArray(node?.properties?._ggRowUserSize)
        ? Number(node.properties._ggRowUserSize[0]) : 0;
    const values = [rowManual, autoManual, savedUser].filter((v) => Number.isFinite(v) && v > 0);
    return values.length ? Math.min(...values) : 0;
}

// 节点可以在布局配置里声明「高度永远贴合内容」：不接受用户拖出来的额外高度，
// 也不让它随工作流持久化。GG LoRA组加载 用 —— 内容行数没变却留一大片空白，
// 用户会以为是节点自己在变高。只影响登记了 lockHeightToContent 的节点。
function heightLockedToContent(node) {
    return node?.[ENGINE_KEY]?.config?.lockHeightToContent === true;
}

// 用户拖出来的额外高度。内容行数变化时可以往上长，但不许往下缩。
function manualHeightOf(node) {
    if (heightLockedToContent(node)) {
        return 0;
    }
    const value = Number(node?.[MANUAL_HEIGHT_FLAG]) || 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 别的尺寸管理模块（压缩保存的存档尺寸恢复）用它声明「这个高度是用户定的」。 */
export function lockRowLayoutHeight(node, height) {
    const value = Number(height) || 0;
    if (!node || value <= 0) {
        return;
    }
    node[MANUAL_HEIGHT_FLAG] = value;
}

/**
 * 读档时 node.size 里带着上一次保存的高度；比这一帧算出来的内容高度高，
 * 就认定是用户拖出来过的，别在加载后悄悄缩回去。
 */
export function restoreRowLayoutUserHeight(node, storedHeight) {
    const state = node?.[ENGINE_KEY];
    if (!state || !isSizeLike(node.size) || heightLockedToContent(node)) {
        return;
    }
    const stored = Number(storedHeight) || 0;
    if (stored > (Number(state.height) || 0) + 2) {
        node[MANUAL_HEIGHT_FLAG] = stored;
        applyHeight(node, state);
    }
}

// 引擎算出来的 minWidth 只是「默认宽度」，不是硬下限。用户拖过节点边之后，
// 以他自己定的宽度为准：想压多窄就多窄，控件按 packedRects 的 scale 自己缩。
// 没拖过的节点仍由 minWidth 撑住，保证新建 / 读档时内容不被裁。
function effectiveMinWidth(node, state) {
    const min = state.minWidth ?? (Number(state.config.minWidth) || 0);
    const manualWidth = manualWidthOf(node);
    return manualWidth > 0 ? Math.min(min, manualWidth) : min;
}

// 节点自己算出来的「最窄能多窄」：找出让 N 个控件刚好排进 rows 行的宽度。
// 从窄往宽试，第一个既能压到目标行数、又保证每行都不超宽的宽度就是答案。
function widthForRows(items, rowsLimit) {
    if (!items.length) {
        return AUTO_MIN_WIDTH;
    }
    const rowWidth = (row) => {
        let sum = COL_GAP * (row.length - 1);
        for (const widget of row) {
            sum += requiredWidth(widget);
        }
        return sum;
    };
    for (let width = AUTO_MIN_WIDTH; width <= AUTO_MAX_WIDTH; width += 8) {
        const available = width - SIDE * 2;
        const parts = partition(items, available);
        if (parts.length <= rowsLimit && parts.every((row) => rowWidth(row) <= available)) {
            return width;
        }
    }
    return Number.POSITIVE_INFINITY;
}

// 自动定宽：先按「两行」找，两行做不到（控件太多、标签太长）就退一步找三行、
// 四行…… 直到宽度落在可接受区间内。这样短小节点保持窄，大节点最多宽到 760。
function autoMinWidth(node, config, alone, maxRows) {
    const shown = (node.widgets ?? []).filter((widget) => isWidgetShown(node, widget));
    const items = shown.filter((widget) => !alone(widget));
    // 只有一个控件时没必要按两行的口径撑宽，够这一格用就行。
    if (items.length <= 1) {
        return Math.max(MIN_NODE_WIDTH, requiredWidth(items[0]) + SIDE * 2);
    }
    const ceiling = Math.max(2, Number(maxRows) || 2);
    // 先尽量找「够窄」的方案：两行能做到 420 以内就用两行，做不到就三行、四行……
    // 全都超了再退回最窄的那个（仍然不越过 AUTO_MAX_WIDTH）。
    let best = AUTO_MAX_WIDTH;
    for (let rowsLimit = ceiling; rowsLimit <= ceiling + 4; rowsLimit += 1) {
        const width = widthForRows(items, rowsLimit);
        if (width <= PREFERRED_MAX_WIDTH) {
            return width;
        }
        if (width < best) {
            best = width;
        }
    }
    return Math.min(best, AUTO_MAX_WIDTH);
}

function layoutSignature(node) {
    const parts = [];
    for (const widget of node.widgets ?? []) {
        if (!isWidgetShown(node, widget)) {
            continue;
        }
        parts.push(`${widget.name}:${widget.label ?? ""}:${String(widget.value ?? "").slice(0, 24)}`);
    }
    return parts.join("|");
}

// 「控件集合」的签名：只看有哪些控件、显示名是什么，不看取值。
// 用户打字/换下拉会改取值（layoutSignature 会变，要重算宽度），但那时不该顺手
// 把人手动拉宽的节点又收回去，所以收窄只看这一份签名。
function structureSignature(node) {
    const parts = [];
    for (const widget of node.widgets ?? []) {
        if (!isWidgetShown(node, widget)) {
            continue;
        }
        parts.push(`${widget.name}:${widget.label ?? ""}`);
    }
    return parts.join("|");
}

// 老工作流里存下来的宽度可能是 600、800，比现在算出来的紧凑宽度宽一大截；
// 宽度只升不降的话，列就会被摊开、标签和数值之间空出一大片。
// 所以「控件集合变了」或「刚从存档读出来」时收窄一次，收到紧凑宽度为止。
// 之后用户自己拉宽不再干预（拉宽只会把富余补给长取值列，见 packedRects）。
function shrinkToWidth(node, state, allow) {
    // 用户手动定过尺寸的节点不参与自动收窄：他自己拉多宽就留多宽。
    if (!allow || manualWidthOf(node) > 0) {
        return;
    }
    const minWidth = state.minWidth ?? 0;
    if (!Number.isFinite(minWidth) || minWidth <= 0) {
        return;
    }
    if (!isSizeLike(node.size) || node.size[0] <= minWidth + 1) {
        return;
    }
    node.size[0] = minWidth;
    node.setDirtyCanvas?.(true, true);
}

function reflow(node) {
    const state = node[ENGINE_KEY];
    if (!state) {
        return;
    }

    const height = widgetHeight();
    // 显示名先换掉：下面算宽度用的是 label，换晚了会按老名字量。
    applyLabels(node, state.config);

    // 「控件集合变了」才允许收窄一次宽度（见 shrinkToWidth）。
    // 取值变化、用户拖动改宽度都不算，免得打字时节点宽度来回跳。
    const struct = structureSignature(node);
    const structChanged = state.structKey !== struct;
    state.structKey = struct;
    const shrink = state.shrinkPending === true || structChanged;
    state.shrinkPending = false;

    // 有「弹性高度」控件的节点（多行文本框：computeLayoutSize）不排 y，整体交给官方。
    // 官方按剩余空间给它分高度，我们再塞一套自定 y 就会互相压住——实测文本块会
    // 盖到下面那行控件上，还会出现高度每帧翻倍的死循环。
    // 但宽度还是可以给：把「按最宽的那个控件都放得下」算成最小宽度，只调宽不动位置。
    //
    // DOM 预览（$$canvas-image-preview）也带 computeLayoutSize，却不是多行文本框：
    // 它由宿主自己定位，占参数区下方的剩余高度。早期把它和文本框一视同仁，
    // 整个节点就放弃行布局——拉宽到 620，参数控件仍钉在默认 244，右侧空一大片。
    // 业务扩展给这类控件打 _ggRowLayoutOutside，这里把它们从「弹性判定」和
    // 「分行」里同时剔除：普通控件照常通栏铺满，预览留给官方定位。
    const shownAll = (node.widgets ?? []).filter((widget) => isWidgetShown(node, widget));
    const outside = shownAll.filter(isLayoutOutside);
    const laidOut = shownAll.filter((widget) => !isLayoutOutside(widget));
    if (laidOut.some((widget) => typeof widget.computeLayoutSize === "function")) {
        let widest = 0;
        for (const widget of shownAll) {
            widest = Math.max(widest, requiredWidth(widget));
        }
        state.flexible = true;
        state.rows = [];
        state.height = null;
        state.minWidth = widest
            ? Math.min(AUTO_MAX_WIDTH, Math.max(AUTO_MIN_WIDTH, widest + SIDE * 2))
            : 0;
        shrinkToWidth(node, state, shrink);
        return;
    }

    const flow = state.config.flow === true;
    const gap = Math.max(0, Number(state.config.colGap ?? COL_GAP));
    const alone = (widget) => isAloneWidget(node, widget, state.config, node.size?.[0] ?? 400);
    const autoWidth = !flow && state.config.minWidth === "auto";
    // minWidth: "content" —— 单列布局专用：宽度下限 = 最宽控件完整显示所需的宽度。
    // 下面的 contentWidth() 只量多控件行，单列全是一行一个、量出来是 0，只能在这算。
    const contentWidthMode = !flow && state.config.minWidth === "content";
    let minWidth;
    if (flow) {
        // 默认宽度只按第一个控件算：前缀那一格多宽，节点就多宽，其余控件往下排。
        const first = laidOut.find((widget) => !alone(widget));
        minWidth = Math.max(MIN_NODE_WIDTH, (first ? requiredWidth(first) : 0) + SIDE * 2);
    } else {
        minWidth = autoWidth || contentWidthMode ? 0 : (Number(state.config.minWidth) || 0);
        if (autoWidth) {
            // 控件增删（DynamicCombo 换方式、插件自己显隐）会改变所需宽度，
            // 用签名判重，签名没变就不重算。
            const key = layoutSignature(node);
            if (state.autoKey !== key || !state.autoWidth) {
                state.autoKey = key;
                state.autoWidth = autoMinWidth(node, state.config, alone, state.config.maxRows);
            }
            minWidth = state.autoWidth;
        } else if (contentWidthMode) {
            let widest = 0;
            for (const widget of laidOut) {
                widest = Math.max(widest, requiredWidth(widget));
            }
            minWidth = Math.min(AUTO_MAX_WIDTH, Math.max(MIN_NODE_WIDTH, widest + SIDE * 2));
        }
    }

    // flow 节点只在新建立起来时收一次到默认窄宽，之后宽度完全由用户/存档定：
    // 拉多宽留多宽。分行和绘制用同一个实际宽度，不会出现「按 620 分行、按 244 画」。
    if (flow) {
        state.minWidth = minWidth;
        shrinkToWidth(node, state, shrink && !state.widthSeeded);
        state.widthSeeded = true;
    }

    // 非 flow 的分行宽度只认「算出来的紧凑宽度」，不能拿 node.size[0] 去分：新建时
    // 前端给的是 400~640、老存档里可能是拉过的 800，按那个宽度会把控件塞进更少
    // 更宽的行，contentWidth 反过来又把节点撑宽，成了放大回路。
    const wrapWidth = flow
        ? Math.max(80, node.size?.[0] ?? minWidth)
        : Math.max(minWidth, manualWidthOf(node));
    let rows = flow ? [laidOut] : resolveRows(node, state.config, laidOut);
    const startY = state.startY ?? 2;
    // 走到这里说明没有弹性高度控件（有的话上面已经 return 了），普通控件的
    // 位置可以自己写。但若存在「布局外」的 DOM 预览，节点总高度仍归官方：
    // 官方按 computeLayoutSize 把预览塞进参数区下方的剩余空间，我们写死
    // 参数区的高度会把预览挤没。computeSize / applyHeight 都认这个标记。
    state.flexible = outside.length > 0;

    const available = Math.max(80, wrapWidth - SIDE * 2);
    // columnWidth(widget) 钩子：自绘列（drawColumn 画法）申报真实内容宽，
    // 量宽与分配都按它来，别按官方控件的全套内衬撑出死空白。
    const widthOverride = typeof state.config.columnWidth === "function"
        ? (widget) => state.config.columnWidth(widget, node)
        : null;
    if (flow) {
        // 相对「默认窄宽」每多拉出一步，才允许每行多并进来一个配置：
        // 默认严格单列，拉宽一格变两列，再拉宽变三列。不用 available/step 的
        // 绝对口径，否则默认宽度下就会算出 1 列、但拉宽 100px 仍卡在 1 列，
        // 用户会觉得「拉了半天没反应」。宽度够不够仍由 flowRows 逐格判。
        const step = Math.max(60, Number(state.config.flowColumnStep) || 140);
        const maxColumns = 1 + Math.floor(Math.max(0, wrapWidth - minWidth) / step);
        rows = flowRows(rows, available, alone, gap, maxColumns);
    } else if (state.config.autoWrap) {
        rows = wrapRows(rows, available, alone, gap);
    }

    // 分组节标题：配置 groups 时，在每组第一个控件所在行前插一行伪行。
    // 只看每行首个控件定组（单列节点每行一个控件天然成立）。
    state.headers = [];
    if (!flow && Array.isArray(state.config.groups) && state.config.groups.length) {
        const groupOf = new Map();
        state.config.groups.forEach((group, index) => {
            for (const name of group.match ?? []) {
                groupOf.set(name, index);
            }
        });
        const withHeaders = [];
        let lastIndex = -1;
        for (const row of rows) {
            const lead = row[0];
            if (!lead) {
                withHeaders.push(row);
                continue;
            }
            const key = String(lead.name ?? "").split(".").pop();
            const gi = groupOf.has(key) ? groupOf.get(key) : lastIndex;
            if (gi !== lastIndex && gi >= 0) {
                withHeaders.push([{ _ggHeader: state.config.groups[gi].title ?? "" }]);
                lastIndex = gi;
            }
            withHeaders.push(row);
        }
        rows = withHeaders;
    }

    if (!flow) {
        if (state.config.pack === false) {
            // 权重摊满的行是铺满节点宽的，「内容贴紧宽」对它没有意义——量出来的
            // tight 反而会吃掉配置的默认宽。minWidth 直接用配置值，拖窄由
            // effectiveMinWidth 的手动宽语义放行。
            state.minWidth = Math.max(MIN_NODE_WIDTH, Number(state.config.minWidth) || 0);
            shrinkToWidth(node, state, shrink);
        } else {
            // 行分好之后再量「这些行到底要多宽」：配置里的 minWidth 是过去按「摊满」估的，
            // 普遍偏宽；以内容宽为准，节点就能贴着内容收紧，行尾不留空白。
            const tight = contentWidth(rows, gap, widthOverride);
            state.minWidth = tight > 0 ? Math.max(MIN_NODE_WIDTH, tight) : minWidth;
            shrinkToWidth(node, state, shrink);
        }
    }
    // 绘制宽度取实际节点宽：用户拉宽时富余由 packedRects 补给长取值列；
    // 手动压窄时用他给的宽度，列靠 packedRects 的 scale 缩，不硬撑回去。
    const nodeWidth = Math.max(effectiveMinWidth(node, state), node.size?.[0] ?? 200);

    let y = startY;
    rows.forEach((row, rowIndex) => {
        // 节标题伪行：只占一行高度记进 state.headers，由 drawWidgets 画
        if (row.length === 1 && row[0] && row[0]._ggHeader !== undefined) {
            state.headers.push({ title: row[0]._ggHeader, y });
            y += 16 + ROW_GAP;
            return;
        }
        const rowHeight = row.reduce(
            (max, widget) => Math.max(max, widget.computedHeight ?? height),
            height,
        );
        let rects;
        // flow 的单控件行不是「独占整行」：拉满会把标签和数值之间扯出一大片空白，
        // 按它自己需要的宽度贴紧即可。真正的独占控件（多行文本、预览、fullWidth）
        // 仍然占满整行。
        const aloneRow = row.length === 1 && alone(row[0]);
        // 单控件行的贴紧语义：
        // ① flow 节点本来就贴紧（非 alone 时），拉满会把标签和数值扯出死空白；
        // ② 非 flow 节点默认占满整行（单列布局的参数控件通栏是期望形态），
        //    但配置可用 compactSingle(widget) 声明某行贴紧——LoRA 的新增按钮
        //    通栏 620px 只有 60px 文字。贴紧行富余一律留行尾，不回通栏。
        const singleTight = row.length === 1
            && (flow ? !aloneRow
                : !aloneRow
                && typeof state.config.compactSingle === "function"
                && state.config.compactSingle(row[0], node) === true);
        if (row.length === 1 && !singleTight) {
            rects = columnRects(nodeWidth, 1, [1], gap);
        } else if (row.length === 1) {
            // 单控件贴紧行：按内容宽贴紧，富余留行尾（allowSurplus=false）
            rects = packedRects(nodeWidth, row, gap, false, widthOverride);
            // centerSingle：把贴紧后的这一格整体平移到节点水平中线（「新增LoRA」
            // 按钮靠左会显得失衡）。形状占 [rect.x+SIDE, rect.x+rect.w-SIDE]，
            // 中心是 rect.x + rect.w/2，所以 rect.x = (nodeWidth - rect.w)/2。
            if (typeof state.config.centerSingle === "function"
                && state.config.centerSingle(row[0], node) === true
                && rects.length === 1) {
                rects = [{ x: (nodeWidth - rects[0].w) / 2, w: rects[0].w }];
            }
        } else if (state.config.pack === false) {
            // 权重摊满：行内各列按配置的权重等比分节点宽，拉大拉小都等比缩放
            // （LoRA 行的启用/名称/强度就是这个形态，固定像素会有右侧空白或拖不小）。
            const weights = state.config.weightsByRow?.[rowIndex]
                ?? state.config.weights?.[row.length]
                ?? state.config.weights
                ?? null;
            rects = columnRects(nodeWidth, row.length, weights, gap);
        } else {
            // 默认：每列只拿自己需要的宽度，从左贴紧，多余留给长取值列或行尾
            rects = packedRects(nodeWidth, row, gap, !flow, widthOverride);
        }

        // 可选钩子：节点自己决定这一行「实际画在哪」。用于把尾部按钮垂直居中到
        // 「最后一行内容 ↔ 节点底边」的空白里（LoRA 组节点的「新增LoRA」）。
        // 只改 widget.y / last_y，布局游标 y 与 state.height 都不动：绘制、命中区
        // 一起跟着走，而节点高度不会反过来被按钮位置撑大，也就没有回授棘轮。
        let drawY = y;
        if (typeof state.config.rowY === "function") {
            try {
                const custom = state.config.rowY({
                    node, row, rowIndex, rows, y, rowHeight, state,
                });
                if (Number.isFinite(custom)) {
                    drawY = custom;
                }
            } catch {
                drawY = y;
            }
        }

        row.forEach((widget, index) => {
            widget.y = drawY;
            widget.last_y = drawY;
            widget._ggCol = rects[index];
            // 控件的 onClick/onDrag 用 `this.width || node.size[0]` 判断「右端 40px 增量区」，
            // 不写列宽的话它量的是整条节点，点列右端会被当成中间区域（数值控件会弹输入框）。
            widget.width = rects[index].w;
        });
        y += rowHeight + ROW_GAP;
    });

    // 不在任何行里的 widget（被隐藏的槽位）清掉列信息，免得沿用上一轮的偏移。
    const placed = new Set(rows.flat());
    for (const widget of node.widgets ?? []) {
        if (!placed.has(widget)) {
            widget._ggCol = null;
        }
    }
    // 布局外控件（DOM 预览）不占行，但绘制宽度要跟着节点走：它走 drawWidgets
    // 的「无列」分支，宽度取 widget.width，不同步的话拉宽后预览还是默认那一条。
    // y 与 computedHeight 保持官方 _arrangeWidgets 的分配结果，不碰。
    for (const widget of outside) {
        widget.width = Math.max(1, Number(node.size?.[0]) || 0);
    }

    state.height = Math.max(height + startY, y - ROW_GAP + 6);
    state.rows = rows;
}

// 行数变少时节点要跟着矮下去：官方 `_arrangeWidgets` 只在内容超高时 setSize，
// 不会缩，所以这里直接写 size（不用 setSize，避免又触发一轮 arrange 递归）。
// 注意 node.size 是 Float64Array 而不是 Array，`Array.isArray` 会判成 false。
function isSizeLike(value) {
    return !!value && typeof value.length === "number" && value.length === 2;
}

function applyHeight(node, state) {
    if (state.applying || !isSizeLike(node.size)) {
        return;
    }
    // 用户正握着节点边拖：这一刻高度归用户的拉力管。引擎若在拖拽过程中把
    // 高度写回 max(内容, 手动标记)，onResize 记到的就永远是引擎改过的值、
    // 手动标记永远降不下去——节点高度从此只能变大，往下拖多少都被顶回来。
    // 这就是「只能拉高、无法调整到位」反复复发的死锁点，拖拽期间必须停手。
    const liveCanvas = app?.canvas || globalThis.LGraphCanvas?.active_canvas;
    if (liveCanvas?.resizing_node === node) {
        return;
    }
    const height = state.height;
    if (!Number.isFinite(height)) {
        return;
    }
    const minWidth = effectiveMinWidth(node, state);
    const width = minWidth ? Math.max(node.size[0], minWidth) : node.size[0];
    // 用户自己拖出来的高度不许被内容高度缩回去；内容变多时仍然可以继续长高。
    // lockHeightToContent 的节点例外：高度永远就是 state.height，拖高立即收回。
    const contentHeight = heightLockedToContent(node)
        ? height
        : Math.max(height, manualHeightOf(node));
    // 有弹性高度的控件时只管宽度，别去写高度（见 reflow 里的说明）
    const targetHeight = state.flexible ? node.size[1] : contentHeight;
    if (Math.abs(node.size[1] - targetHeight) < 1 && Math.abs(node.size[0] - width) < 1) {
        return;
    }
    state.applying = true;
    try {
        node.size[0] = width;
        node.size[1] = targetHeight;
    } finally {
        state.applying = false;
    }
    node.setDirtyCanvas?.(true, true);
}

function patchPointerHandlers(widget) {    if (!widget || widget._ggPointerPatched) {
        return;
    }
    widget._ggPointerPatched = true;

    for (const key of ["onClick", "onDrag"]) {
        const original = widget[key];
        if (typeof original !== "function") {
            continue;
        }
        widget[key] = function (args) {
            const node = args?.node;
            const column = widget._ggCol;
            if (!column || !node?.pos) {
                return original.call(this, args);
            }
            // 控件内部按 canvasX - node.pos[0] 取相对 x：临时右移节点原点，
            // 相对 x 就变成「列内坐标」，增量按钮/拖拽才落对位置。
            const baseX = node.pos[0];
            node.pos[0] = baseX + column.x;
            try {
                return original.call(this, args);
            } finally {
                node.pos[0] = baseX;
            }
        };
    }
}

// 节点可以自备某一列的画法（比如把布尔控件画成紧凑的勾选框）。
// 返回 true 表示这一格已经画完，引擎不再调官方 drawWidget。
function drawCustomColumn(ctx, node, widget, column, showText) {
    const config = node[ENGINE_KEY]?.config;
    if (typeof config?.drawColumn !== "function") {
        return false;
    }
    ctx.save();
    ctx.translate(column.x, 0);
    if (widget.computedDisabled) {
        ctx.globalAlpha *= 0.5;
    }
    let handled = false;
    try {
        handled = config.drawColumn({
            ctx,
            node,
            widget,
            width: column.w,
            y: widget.y,
            height: widget.computedHeight ?? widgetHeight(),
            showText,
        }) === true;
    } catch {
        handled = false;
    }
    ctx.restore();
    return handled;
}

function drawOne(ctx, node, widget, width, x, showText) {    ctx.save();
    if (x) {
        ctx.translate(x, 0);
    }
    if (widget.computedDisabled) {
        ctx.globalAlpha *= 0.5;
    }
    // Dedicated narrow LoRA value cells keep their readable value in native mode.
    if (!isWidgetSkinEnabled(node) && widget.type === "number" && width - SIDE * 2 < 80
        && !String(widget.displayName ?? widget.label ?? widget.name ?? "").trim()) {
        const w = Math.max(20, width - SIDE * 2);
        const h = widget.computedHeight ?? widgetHeight();
        paintCapsuleBase(ctx, SIDE, widget.y, w, h, showText, false, node, widget);
        if (showText) {
            ctx.font = TEXT_FONT;
            ctx.fillStyle = widgetBaseColors(widget).ink;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(truncateToWidth(ctx, displayValue(widget), w - 8), SIDE + w / 2, widget.y + h / 2 + 1);
        }
        ctx.restore();
        return;
    }
    if (typeof widget.draw === "function") {
        // DOM 预览等「布局外」控件的高度是官方按 computeLayoutSize 分出来的，
        // 传固定 24 会把它压成一条；标准控件的 computedHeight 本来就是 24。
        widget.draw(ctx, node, width, widget.y, widget.computedHeight ?? widgetHeight(), !showText);
    } else if (typeof widget.drawWidget === "function") {
        widget.drawWidget(ctx, { width, showText });
    }
    ctx.restore();
}

// ------------------------------------------------------------------
// 独立皮肤补丁：让「没登记行布局」的节点也吃到同一套胶囊皮肤。
//
// 为什么需要：drawSkinned 原先只挂在 applyRowLayout 的 drawWidgets 补丁里，
// 而扩展只对 LAYOUTS 里的节点安装它。面板型 / 预览型 / 第三方节点走官方
// drawWidgets，一个都吃不到（实测 57 个 GG 节点里 20 个没登记）。
//
// 做法：不重写 node.drawWidgets（保留官方的 alpha、hover、lowQuality 时序），
// 只接管每个「单行 canvas 标准控件」自己的 drawWidget / draw 入口。没有
// _ggCol 时构造整行虚拟列 { x:0, w:width }——drawSkinned 内缩 SIDE 后的
// 形状是 [15, width-15]，与官方 BaseWidget 按 margin=15 内缩的形状完全一致，
// 命中区与点击坐标一点没变。DOM 面板、多行文本、gg_* 自绘控件由 skinnable()
// 挡掉，一律交回官方绘制。
// ------------------------------------------------------------------
const WIDGET_SKIN_FLAG = "_ggWidgetSkinPatched";
const NODE_SKIN_FLAG = "_ggWidgetSkinApplied";

function patchStandaloneWidgetSkin(node, widget) {
    if (!widget || widget[WIDGET_SKIN_FLAG] || !skinnable(widget)) {
        return false;
    }
    const originalDrawWidget = widget.drawWidget;
    const originalDraw = widget.draw;
    if (typeof originalDrawWidget !== "function" && typeof originalDraw !== "function") {
        return false;
    }
    widget[WIDGET_SKIN_FLAG] = true;

    const paint = (ctx, width, showText) => {
        // 已登记行布局的控件会在 drawWidgets 补丁里画，这里不重复接管。
        const column = widget._ggCol ?? { x: 0, w: Math.max(40, Number(width) || 240) };
        try {
            return drawSkinned(ctx, node, widget, column, showText !== false, false);
        } catch {
            return false;
        }
    };

    if (typeof originalDrawWidget === "function") {
        widget.drawWidget = function (ctx, options = {}) {
            const width = Number(options?.width) || widget.width || 240;
            if (paint(ctx, width, options?.showText)) {
                return;
            }
            return originalDrawWidget.call(this, ctx, options);
        };
    }
    if (typeof originalDraw === "function") {
        widget.draw = function (ctx, node, width, y, height, lowQuality) {
            if (paint(ctx, width, !lowQuality)) {
                return;
            }
            return originalDraw.call(this, ctx, node, width, y, height, lowQuality);
        };
    }
    return true;
}

export function applyWidgetSkin(node) {
    // 登记过行布局的节点已经有一整套 drawWidgets 补丁，别叠第二层。
    if (!node || !isWidgetSkinEnabled(node) || node[ENGINE_KEY] || node[NODE_SKIN_FLAG]) {
        return 0;
    }
    node[NODE_SKIN_FLAG] = true;
    let count = 0;
    const scan = () => {
        for (const widget of node.widgets ?? []) {
            if (patchStandaloneWidgetSkin(node, widget)) {
                count += 1;
            }
        }
    };
    scan();

    // 动态显隐 / 后来才 addWidget 的控件（切换模式、接入输入）也要补上。
    // 只做「有没有没打标记的」检查，绘制本身仍完全交回官方循环。
    const originalDrawWidgets = node.drawWidgets;
    if (typeof originalDrawWidgets !== "function") return count;
    node.drawWidgets = function (ctx, ...args) {
        if (!isWidgetSkinEnabled(this)) return originalDrawWidgets.apply(this, [ctx, ...args]);
        for (const widget of this.widgets ?? []) {
            if (!widget[WIDGET_SKIN_FLAG] && skinnable(widget)) {
                scan();
                break;
            }
        }
        return originalDrawWidgets.apply(this, [ctx, ...args]);
    };
    return count;
}

export function applyRowLayout(node) {
    const config = LAYOUTS.get(node?.comfyClass);
    if (!config || node[ENGINE_KEY]) {
        return node?.[ENGINE_KEY] ?? null;
    }

    const state = { config, startY: null, height: null, rows: [] };
    node[ENGINE_KEY] = state;
    // 布局同步入口在下面定义（依赖 captureStart），先在 onResize 里留一个后绑定的引用。
    let syncLayoutWidth = null;

    // 自己记一份手动宽度：autofit 排除的节点（GGImageSuperResolution 等）不会写
    // _ggAutoFitManualSize，只认那个字段会让这类节点拖窄后又被内容宽撑回去。
    // 这里包在实例上，原函数（prototype 上 autofit 的那层）照常调用。
    const originalOnResize = node.onResize;
    node.onResize = function (...args) {
        const canvas = app?.canvas || globalThis.LGraphCanvas?.active_canvas;
        if (canvas?.resizing_node === this && isSizeLike(this.size)) {
            this[MANUAL_WIDTH_FLAG] = Number(this.size[0]) || 0;
            // 只有拖到比内容高才算「用户要的额外空间」；拖回内容高度就撤销，
            // 免得一次误拖之后节点再也收不回贴合高度。
            // （拖拽中 applyHeight / computeSize 已停手，size 就是用户的拉力值。）
            const dragged = Number(this.size[1]) || 0;
            const locked = heightLockedToContent(this);
            if (locked) {
                // 高度锁死贴合内容：这一帧就把拉力收回去，拖不动、也不留下
                // 任何会被读档认领的手动高度标记。宽度仍然归用户。
                delete this[MANUAL_HEIGHT_FLAG];
                this.size[1] = Number(state.height) || dragged;
            } else if (dragged > (Number(state.height) || 0) + 2) {
                this[MANUAL_HEIGHT_FLAG] = dragged;
            } else {
                delete this[MANUAL_HEIGHT_FLAG];
            }
            // 用户尺寸落进 properties 随工作流持久化：读档时节点对象是新建的，
            // 内存标记会经历一轮重建时序，properties 是唯一可靠的恢复来源。
            try {
                if (this.properties && typeof this.properties === "object") {
                    this.properties._ggRowUserSize = [
                        Number(this.size[0]) || 0,
                        locked ? 0 : dragged,
                    ];
                }
            } catch {
                // properties 不可写时退回内存标记路径，不影响拖拽本身
            }
        }
        const result = originalOnResize?.apply(this, args);
        // 拉宽 / 拉窄只走 onResize：真机计数实测 setSize 之后 _arrangeWidgets /
        // computeSize / drawWidgets 一次都不会再调用。不在这里重排，_ggCol 就永远
        // 停在新建时的默认宽度，节点右侧空出一大片（GG 图像压缩保存拉到 620、
        // 参数仍占 244）。只重排布局，不写尺寸——拖拽中写尺寸会变成棘轮。
        syncLayoutWidth?.(this);
        return result;
    };

    const originalArrange = node._arrangeWidgets;
    const originalDrawWidgets = node.drawWidgets;
    const originalGetWidgetOnPos = node.getWidgetOnPos;
    const originalComputeSize = node.computeSize;

    // 记录 ComfyUI 自己算出来的第一个 widget 的 y：输入槽高度之类的前置空间
    // 由官方逻辑负责，我们只在它给的起点上重新排。
    const captureStart = (self) => {
        // 布局外控件（DOM 预览）的 y 归官方，不参与「第一行在哪」的取样：
        // 它常被记成 0，混进来会把参数区整体顶到节点最上沿。
        const shown = (self.widgets ?? []).filter(
            (widget) => isWidgetShown(self, widget) && !isLayoutOutside(widget),
        );
        if (!shown.length) {
            return;
        }
        const first = Math.min(...shown.map((widget) => widget.y ?? 0));
        if (Number.isFinite(first)) {
            state.startY = first;
        }
    };

    // 控件签名 + 节点宽度一起判变化：打字 / 换下拉会改签名，拉宽只改宽度，
    // 两者都要让行布局重算一次。多入口共用，返回「这次是否真的重排了」。
    syncLayoutWidth = (self) => {
        // applyHeight 写 node.size 会回调 onResize，reflow 里的 shrinkToWidth
        // 也可能再写一次；两把闸挡住「尺寸→布局→尺寸」的递归。
        if (state.applying || state.syncing || !isSizeLike(self.size)) {
            return false;
        }
        const key = layoutSignature(self);
        const width = Math.round(Number(self.size[0]) || 0);
        if (state.drawnKey === key && state.drawnWidth === width && state.rows.length) {
            return false;
        }
        state.syncing = true;
        try {
            state.drawnKey = key;
            state.drawnWidth = width;
            captureStart(self);
            reflow(self);
        } finally {
            state.syncing = false;
        }
        return true;
    };
    state.syncWidth = syncLayoutWidth;

    if (typeof originalArrange === "function") {
        node._arrangeWidgets = function (...args) {
            const result = originalArrange.apply(this, args);
            captureStart(this);
            reflow(this);
            applyHeight(this, state);
            return result;
        };
    }

    if (typeof originalComputeSize === "function") {
        node.computeSize = function (out) {
            const size = originalComputeSize.call(this, out);
            if (!state.rows.length) {
                captureStart(this);
                reflow(this);
            }
            // 列布局需要最小宽度：三个控件挤在 169px 里会互相压住，
            // 这里把最小宽度借 computeSize 报出去，refreshNode 的 setSize 才会真的变宽。
            // 用户拖过节点边之后这条下限就撤掉（见 effectiveMinWidth）。
            const minWidth = effectiveMinWidth(this, state);
            // 拖拽进行中：官方 onDrag 拿 computeSize() 当硬下限（l.width / l.height
            // 小于它就把拉力钳回去）。这里**绝不能**带 this.size 或手动标记——
            // 旧值会成为新下限，往窄/往下拖多少都被钳回去（「只能拉大」的最后一把
            // 锁，帧级追踪实锤：LoRA 拖窄全程 computeSize ret=[460,…]、setSize(460)）。
            // 宽度报常数下限 MIN_NODE_WIDTH、高度报内容高：任何往小的拉力都放行；
            // 真实下限由松手后的 applyHeight / effectiveMinWidth（手动宽）收敛。
            const liveCanvas = app?.canvas || globalThis.LGraphCanvas?.active_canvas;
            if (liveCanvas?.resizing_node === this) {
                return [MIN_NODE_WIDTH, Math.min(Number(this.size?.[1]) || size[1], state.height ?? size[1])];
            }
            let height;
            if (state.flexible) {
                height = size[1];
            } else if (heightLockedToContent(this)) {
                height = state.height ?? size[1];
            } else {
                height = Math.max(state.height ?? size[1], manualHeightOf(this));
            }
            return [Math.max(size[0], minWidth), height];
        };
    }

    node.drawWidgets = function (ctx, options = {}) {
        if (!this.widgets) {
            return;
        }
        const { lowQuality = false, editorAlpha = 1 } = options;
        const showText = !lowQuality;
        const nodeWidth = this.renderingSize?.[0] ?? this.size?.[0] ?? 200;

        // 兜底：节点自己把控件藏起来/放出来时（不一定会调用 arrange），
        // 靠每帧一次的签名比对发现变化并立刻重排，否则会留下空槽位。
        // 宽度变化同样算「变了」：拉宽只走 onResize，那里已经重排过一次，
        // 这里再兜一次，保证绘制用的 _ggCol 与 node.size[0] 一致。
        const now = performance.now();
        if (now - (state.checkedAt ?? 0) > 120 && !state.applying) {
            state.checkedAt = now;
            const changed = syncLayoutWidth(this);
            // 高度锁节点：每帧都强制把尺寸收回到内容高度，吃掉「折叠 / 读档 /
            // 手动 setSize」等外部动作留下的残留高度，避免「尺寸→布局→尺寸」
            // 正反馈把底部空白永久顶住。非锁节点只在布局变化时重排/重设高度，
            // 因为手动拖出来的额外高度必须保留。applyHeight 内部对「已在内容高」
            // 是无操作、对拖拽中是早退，所以每帧调用是安全的。
            if (heightLockedToContent(this) || changed) {
                applyHeight(this, state);
            }
        }

        // flow 节点允许被压得比默认窄宽还窄。官方默认策略会「先丢标签、保住取值」，
        // 前缀那一格就只剩路径、看不见「前缀」两个字。画这类节点时临时切成
        // 「先截取值、保住标签」，画完立刻还原，不影响画布上其它节点。
        const lite = globalThis.LiteGraph;
        const flow = state.config.flow === true;
        const previousTruncate = lite?.truncateWidgetValuesFirst;
        if (flow && lite) {
            lite.truncateWidgetValuesFirst = true;
        }

        ctx.save();
        try {
            ctx.globalAlpha = editorAlpha;
            this.updateComputedDisabled?.();

            // 悬停行：画布指针（graph 坐标）换算成节点局部坐标，命中哪行哪行亮
            const gm = app.canvas?.graph_mouse;
            const hoverX = gm && this.pos ? gm[0] - this.pos[0] : null;
            const hoverY = gm && this.pos ? gm[1] - this.pos[1] : null;
            const rowHovered = (widget, column) => {
                if (hoverX == null || !column) {
                    return false;
                }
                const rowH = widget.computedHeight ?? widgetHeight();
                return hoverX >= column.x && hoverX <= column.x + column.w
                    && hoverY >= widget.y - 2 && hoverY <= widget.y + rowH + 2;
            };
            for (const widget of this.widgets) {
                if (!isWidgetShown(this, widget)) {
                    continue;
                }
                // 已接线控件只保留布局行供输入端口锚定，绘制仍交给宿主的端口/连线层。
                if (widget.hidden && hasConnectedWidgetInput(this, widget)) {
                    continue;
                }
                patchPointerHandlers(widget);
                widget.last_y = widget.y;
                const column = widget._ggCol;
                if (column) {
                    const handled = drawCustomColumn(ctx, this, widget, column, showText)
                        || drawSkinned(ctx, this, widget, column, showText, rowHovered(widget, column));
                    if (!handled) {
                        drawOne(ctx, this, widget, column.w, column.x, showText);
                    }
                } else {
                    // 弹性高度节点（含 DOM 多行文本）在 reflow 里直接 return，
                    // 所有 widget 都没有 _ggCol，y 由官方排。宽度不归我们管，
                    // 但**单行标准控件仍要吃胶囊皮肤**：构造整行虚拟列
                    // {x:0,w:width}，内缩后形状 [15,width-15] 与官方 BaseWidget
                    // 的 margin=15 完全一致，不改尺寸 / y / 命中区 / 点击坐标。
                    // 之前这里无条件 drawOne，导致 GGPromptEnhancer 的 11 个
                    // 控件全是官方 20px 扁条，和同节点其它胶囊对不上。
                    const width = widget.width || nodeWidth;
                    const virtual = { x: 0, w: width };
                    const handled = drawCustomColumn(ctx, this, widget, virtual, showText)
                        || drawSkinned(ctx, this, widget, virtual, showText, rowHovered(widget, virtual));
                    if (!handled) {
                        drawOne(ctx, this, widget, width, 0, showText);
                    }
                }
                ctx.globalAlpha = editorAlpha;
            }
            // 分组节标题：11px muted + 通栏 divider 细线
            for (const header of state.headers ?? []) {
                ctx.save();
                ctx.font = TEXT_FONT;
                const colors = isWidgetSkinEnabled(this) ? skin() : widgetBaseColors();
                ctx.fillStyle = colors.muted;
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillText(header.title, 12, header.y + 8);
                const titleW = ctx.measureText(header.title).width;
                ctx.strokeStyle = colors.divider;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(12 + titleW + 8, header.y + 8);
                ctx.lineTo(nodeWidth - 8, header.y + 8);
                ctx.stroke();
                ctx.restore();
            }
        } finally {
            ctx.restore();
            if (flow && lite) {
                lite.truncateWidgetValuesFirst = previousTruncate;
            }
        }
    };

    node.getWidgetOnPos = function (x, y, includeDisabled = false) {
        const { widgets, pos, size } = this;
        if (!widgets?.length) {
            return undefined;
        }
        const localX = x - pos[0];
        const localY = y - pos[1];
        const nodeWidth = size[0];
        const height = widgetHeight();

        for (const widget of widgets) {
            if ((widget.computedDisabled && !includeDisabled) || !this.isWidgetVisible(widget)) {
                continue;
            }
            const rowHeight = widget.computedHeight ?? widget.computeSize?.(nodeWidth)?.[1] ?? height;
            if (widget.last_y === undefined) {
                continue;
            }
            const column = widget._ggCol;
            // 命中区按形状本体算（形状从 column.x + SIDE 开始，宽 column.w - 2*SIDE），
            // 别用带内边距的整格，否则相邻格会有一小段重叠区。
            const left = column ? column.x + SIDE - HIT_PAD / 2 : 6;
            const width = column ? column.w - SIDE * 2 + HIT_PAD : (widget.width || nodeWidth) - 12;
            if (
                localX >= left
                && localX <= left + width
                && localY >= widget.last_y - 2
                && localY <= widget.last_y - 2 + rowHeight
            ) {
                return widget;
            }
        }
        return undefined;
    };

    // 兼容老前端：部分版本没有 _arrangeWidgets，只能靠 arrange 收尾重排。
    if (typeof node.arrange === "function" && typeof originalArrange !== "function") {
        const originalArrangeNode = node.arrange.bind(node);
        node.arrange = function (...args) {
            const result = originalArrangeNode(...args);
            captureStart(this);
            reflow(this);
            return result;
        };
    }

    return state;
}

// 控件集合变了但节点尺寸没变时（典型：执行后宿主挂上 DOM 预览控件），
// 业务扩展用它主动同步一次行布局。只重排，不写尺寸、不改高度归属。
export function syncRowLayout(node) {
    node?.[ENGINE_KEY]?.syncWidth?.(node);
}

export function refreshRowLayout(node) {
    const state = node?.[ENGINE_KEY];
    if (!state) {
        return;
    }
    state.startY = null;
    // 插件自己改显隐、或刚从工作流里读出来 —— 这两种都允许把宽度收回紧凑值
    state.shrinkPending = true;
    try {
        node._arrangeWidgets?.(node.inputs?.length ?? 0);
    } catch {
        // 未挂到 graph 时 arrange 可能不可用，下一帧再排
    }
    if (!state.startY) {
        state.startY = 2;
        reflow(node);
    }
    applyHeight(node, state);
    node.setDirtyCanvas?.(true, true);
}

const SKIN_GRAPH_WATCHED = "_ggWidgetSkinGraphWatched";

function applyWidgetSkinToGraph(graph) {
    if (!graph) return;
    for (const node of graph._nodes ?? []) {
        if (!LAYOUTS.has(node?.comfyClass)) applyWidgetSkin(node);
    }
    for (const child of graph._subgraphs?.values?.() ?? []) {
        applyWidgetSkinToGraph(child);
    }
}

function watchWidgetSkinGraph(graph) {
    if (!graph || graph[SKIN_GRAPH_WATCHED]) return;
    graph[SKIN_GRAPH_WATCHED] = true;
    applyWidgetSkinToGraph(graph);
    // ComfyUI 新版子图由 rootGraph.events 创建并配置，内部节点可能不经过
    // 普通 graph/nodeCreated 回调。监听这个生命周期，确保“适配第三方”
    // 开启时 New Subgraph 及其内部节点也复用同一套控件皮肤。
    graph.events?.addEventListener?.("subgraph-created", ({ subgraph } = {}) => {
        watchWidgetSkinGraph(subgraph);
        // createNormalizedSubgraph 先 dispatch 事件，再 configure 内部节点。
        // 延迟两帧覆盖配置完成和宿主下一轮控件生成，避免只登记到空图。
        const refresh = () => {
            applyWidgetSkinToGraph(subgraph);
            app.canvas?.setDirty?.(true, true);
        };
        refresh();
        requestAnimationFrame(() => {
            refresh();
            requestAnimationFrame(refresh);
        });
    });
}

onWidgetSkinScopeChange(() => {
    skinCacheAt = 0;
    const seen = new Set();
    const visit = (graph) => {
        if (!graph || seen.has(graph)) return;
        seen.add(graph);
        watchWidgetSkinGraph(graph);
        applyWidgetSkinToGraph(graph);
        for (const child of graph._subgraphs?.values?.() ?? []) visit(child);
    };
    visit(app.graph);
});

// 事件监听独立于当前档位：用户之后打开第三方适配时，已经存在的子图也会
// 先被登记，applyWidgetSkinScope 的 listener 再按当前档位实际套用/撤销。
watchWidgetSkinGraph(app.graph);
applyWidgetSkinToGraph(app.graph);

app.registerExtension({
    name: "ComfyUI.GGNodes.WidgetRowLayout",

    setup() {
        watchWidgetSkinGraph(app.graph);
        applyWidgetSkinToGraph(app.graph);
    },

    async nodeCreated(node) {
        if (!node) {
            return;
        }
        // 登记过行布局的走整套排版补丁；其余所有节点（含第三方）只套皮肤，
        // 不动尺寸、不动 y、不动命中区。
        if (LAYOUTS.has(node.comfyClass)) {
            applyRowLayout(node);
        } else {
            applyWidgetSkin(node);
        }
    },

    async loadedGraphNode(node) {
        if (!node) {
            return;
        }
        if (!LAYOUTS.has(node.comfyClass)) {
            applyWidgetSkin(node);
            return;
        }
        applyRowLayout(node);
        // 用户尺寸的持久化副本（onResize 写进 properties 的）优先认领：内存标记
        // 随节点重建会经历官方 refreshNode / autofit 的多轮写入，这里在下一帧
        // 把 properties 里的用户值直接钉回去，不再依赖「存档高恰好多于内容高」。
        const savedUser = Array.isArray(node.properties?._ggRowUserSize)
            ? node.properties._ggRowUserSize
            : null;
        const storedHeight = Number(node.size?.[1]) || 0;
        requestAnimationFrame(() => {
            try {
                refreshRowLayout(node);
                const claimState = node[ENGINE_KEY];
                if (heightLockedToContent(node)) {
                    // 老存档可能带着上次拖出来的大高度：不认领，清掉标记并
                    // 立刻收回内容高度；宽度仍按 savedUser 里那份认领。
                    delete node[MANUAL_HEIGHT_FLAG];
                    if (Array.isArray(node.properties?._ggRowUserSize)) {
                        node.properties._ggRowUserSize[1] = 0;
                        const savedW = Number(node.properties._ggRowUserSize[0]) || 0;
                        if (savedW > 0) {
                            node[MANUAL_WIDTH_FLAG] = savedW;
                        }
                    }
                    if (claimState) {
                        applyHeight(node, claimState);
                    }
                } else if (savedUser) {
                    const savedW = Number(savedUser[0]) || 0;
                    const savedH = Number(savedUser[1]) || 0;
                    if (savedW > 0) {
                        node[MANUAL_WIDTH_FLAG] = savedW;
                    }
                    if (savedH > (Number(claimState?.height) || 0) + 2) {
                        node[MANUAL_HEIGHT_FLAG] = savedH;
                    }
                    if (claimState) {
                        applyHeight(node, claimState);
                    }
                } else {
                    // restore 的判据是「存档高 > 内容高」，但走到这里时官方已经把 size
                    // 压回内容高、storedHeight 捕获到的是被压后的值——它会拿内容高把
                    // 刚认领的用户尺寸覆盖掉。只在没有持久化副本的老存档上兜底。
                    restoreRowLayoutUserHeight(node, storedHeight);
                }
            } catch {
                // 认领失败退回引擎默认行为，不影响节点可用性
            }
        });
    },

    async afterConfigureGraph() {
        for (const node of app.graph?._nodes ?? []) {
            if (!node) {
                continue;
            }
            if (LAYOUTS.has(node.comfyClass)) {
                applyRowLayout(node);
            } else {
                applyWidgetSkin(node);
            }
        }
    },
});
