import { app } from "../../scripts/app.js";
import { registerRowLayout, refreshRowLayout, paintCapsuleBase, widgetBaseColors, skinColorsFor } from "./gg-widget-rows.js";
import { isWidgetSkinEnabled } from "./gg-skin-scope.js";

// ==================================================================
// GG LoRA组加载 —— 一个节点里维护多组 LoRA，选中哪组就只让哪组生效。
//
// 组配置存 node.properties.ggLoraGroups（JSON 字符串），随 UI 工作流一起序列化；
// LoRA1..20 这套控件始终只装「当前组」的值，所以后端不必声明
// 「组数 × 每组槽数」个控件（widgets_values 会被撑成几百位、组数一变全错位）。
// 切组流程：先把当前控件快照写回旧组，再把目标组的值灌进控件 ——
// 这样 widgets_values 天然就是当前组，提交 / 读档都不会错位。
//
// 视觉与交互沿用「GG LoRA自定义加载」：三列等比胶囊、启用格自绘带六点拖拽手柄、
// 「新增LoRA」按钮居中、强度点击编辑。本模块自带一套捕获阶段 pointer 处理，
// 只认本节点类，与旧节点的监听器互不干扰。
//
// 2026-11-06 视觉调整：
//   · 去掉「当前生效」提示条 —— 选中哪组就是哪组，标签的高亮本身就是状态；
//   · 节点高度锁死贴合内容（lockHeightToContent）：不与用户拖出的高度做持久化，
//     根治「内容没变却留一大片空白、像节点自己在变高」；「新增LoRA」按钮因此
//     自然落在最后一行 LoRA 下方、紧贴底边，不再需要 rowY 居中 hack；
//   · 拖拽手柄与启用勾选框拆成两个胶囊，中间留可见空白；
//   · 「新增组」改成 ➕ 小圆钮，和组删除按钮一样只在悬浮组条时出现；
//   · 默认宽度下手柄 / 启用 / 强度必须完整显示，只有中间名称列允许省略：
//     模型后缀（.safetensors 等）不展示，长文件名用「左右各保留一段」的中间
//     省略，鼠标左右滚轮可平移看全文。只改绘制文本，widget.value 仍是原名。
// ==================================================================

const TARGET_CLASS = "GGLoRAGroupLoader";
const COUNT_WIDGET_NAME = "LoRA数量";
const GROUP_INDEX_WIDGET = "当前组";
const ADD_LORA_BUTTON = "新增LoRA";
const HINT_WIDGET = "gg_lora_group_hint";
const TABS_WIDGET = "gg_lora_group_tabs";
const HIDDEN_TAG = "ggHiddenLoRAGroup";
const PROP_GROUPS = "ggLoraGroups";
const PROP_INDEX = "ggLoraGroupIndex";

const MAX_LORAS = 20;
const MAX_GROUPS = 30;
const ENABLE_SUFFIX = "启用";
const NAME_SUFFIX = "名称";
const STRENGTH_SUFFIX = "强度";

// 列矩形含两侧 SIDE 内衬，胶囊形状只占 [col.x+SIDE, col.x+col.w-SIDE]。
const SIDE = 15;
const STRENGTH_STEP = 0.05;
const ROW_GAP = 4;      // 与 gg-widget-rows.js 的 ROW_GAP 同源
const BOTTOM_PAD = 6;   // 节点底边留白，按钮不许贴到边

// 启用列拆成「手柄胶囊 + 空白 + 勾选胶囊」三段的比例（按形状宽算）。
const CAPSULE_GAP_RATIO = 0.12;
const CAPSULE_GAP_MIN = 6;
const CAPSULE_GAP_MAX = 12;
const HANDLE_RATIO = 0.42;
const HANDLE_MIN_W = 18;
const HANDLE_MAX_W = 34;
const CHECK_BOX = 18;

const TABS_H = 34;
const TAB_W = 92;
const TAB_GAP = 20; // 组按钮右侧留 16px 给「悬浮才出现」的删除按钮
const DELETE_W = 16;
const ARROW_W = 18;
// 「＋ 新增组」原来常驻占 88px，视觉上压掉一大截标签视口；改成悬浮才出现的
// ➕ 小圆钮后只留一个 26px 的位置，多出来的 60px 全部还给标签滚动区。
const ADD_GROUP_W = 26;
const ADD_GLYPH = "➕";
const NAME_SCROLL_STEP = 1;
const FONT = '12px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const SMALL_FONT = '11px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

const pointerState = { drag: null, press: null, scroll: null };
const widgetState = new Map();
const groupCache = new WeakMap();

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

function getWidget(node, name) {
    return node?.widgets?.find((widget) => widget?.name === name) ?? null;
}

function widgetHeight(widget) {
    return Number(widget?.computedHeight) || 24;
}

function markDirty(node) {
    node?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

// ------------------------------------------------------------------
// 主题色：与 gg-widget-rows.js 共用同一套皮肤取色（含节点自定义颜色），
// 节点改色后组标签 / 名称格 / 启用格跟着同步，不再固定成深色。
// ------------------------------------------------------------------
function canvasIsDark() {
    const raw = String(app.canvas?.clear_background_color ?? "");
    const match = raw.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (!match) {
        return true;
    }
    return 0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3]) < 128;
}

function theme(node, widget) {
    if (!isWidgetSkinEnabled(node)) {
        const colors = widgetBaseColors(widget);
        return {
            dark: canvasIsDark(), ink: colors.ink, muted: colors.muted,
            divider: colors.divider, accent: colors.ink, btn: colors.field,
            btnHover: colors.field, pickedBg: colors.field, danger: colors.ink,
        };
    }
    const skin = skinColorsFor(node);
    return {
        dark: canvasIsDark(),
        ink: skin.ink,
        muted: skin.muted,
        divider: skin.divider,
        accent: skin.accent,
        btn: skin.btn,
        btnHover: skin.btnHover,
        pickedBg: skin.pickedBg,
        danger: "#E05555",
    };
}

// ------------------------------------------------------------------
// 组数据：properties 里存 JSON，读档时以 widgets_values（当前组控件值）
// 为准回写一次，避免「用户没切组就直接保存工作流」丢失最后的编辑。
// ------------------------------------------------------------------
function emptyLora() {
    return { enable: true, name: "None", strength: 1.0 };
}

function normalizeLora(raw) {
    let enable = true;
    if (typeof raw?.enable === "boolean") {
        enable = raw.enable;
    } else if (raw?.enable != null) {
        enable = !["false", "0", "off", ""].includes(String(raw.enable).trim().toLowerCase());
    }
    const strength = Number(raw?.strength);
    return {
        enable,
        name: String(raw?.name ?? "None"),
        strength: Number.isFinite(strength) ? strength : 1.0,
    };
}

function readGroups(node) {
    node.properties ??= {};
    const raw = node.properties[PROP_GROUPS];
    const cached = groupCache.get(node);
    if (cached && cached.raw === raw) {
        return cached.value;
    }
    let parsed = null;
    try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
        parsed = null;
    }
    if (!Array.isArray(parsed) || !parsed.length) {
        parsed = [{ id: 1, name: "LoRA组1", loras: [emptyLora()] }];
    }
    const groups = parsed.slice(0, MAX_GROUPS).map((group, index) => ({
        id: Number(group?.id) || index + 1,
        name: String(group?.name || `LoRA组${index + 1}`),
        loras: (Array.isArray(group?.loras) ? group.loras : [])
            .slice(0, MAX_LORAS)
            .map(normalizeLora),
    }));
    groupCache.set(node, { raw, value: groups });
    return groups;
}

function writeGroups(node, groups) {
    node.properties ??= {};
    node.properties[PROP_GROUPS] = JSON.stringify(groups);
    groupCache.delete(node);
}

function currentIndex(node, groups = readGroups(node)) {
    const stored = Number(node.properties?.[PROP_INDEX]);
    const widget = getWidget(node, GROUP_INDEX_WIDGET);
    const fallback = Number(widget?.value);
    const raw = Number.isFinite(stored)
        ? stored
        : (Number.isFinite(fallback) ? fallback - 1 : 0);
    return clamp(Math.round(raw), 0, groups.length - 1);
}

function persistIndex(node, index) {
    node.properties ??= {};
    node.properties[PROP_INDEX] = index;
    const widget = getWidget(node, GROUP_INDEX_WIDGET);
    if (widget) {
        widget.value = index + 1;
    }
}

function getVisibleCount(node) {
    const value = Number(getWidget(node, COUNT_WIDGET_NAME)?.value);
    return clamp(Number.isFinite(value) ? Math.trunc(value) : 0, 0, MAX_LORAS);
}

function setVisibleCount(node, count) {
    const widget = getWidget(node, COUNT_WIDGET_NAME);
    const value = Number(count);
    if (widget) {
        // 刻意不调 callback：数量控件是隐藏的，回调在这里没有副作用，
        // 但调了会把 compactSlots / 组数据带进递归。
        widget.value = clamp(Number.isFinite(value) ? Math.trunc(value) : 0, 0, MAX_LORAS);
    }
}

function writeWidget(node, name, value) {
    const widget = getWidget(node, name);
    if (widget) {
        widget.value = value;
    }
}

function snapshotSlots(node) {
    const count = getVisibleCount(node);
    const slots = [];
    for (let index = 1; index <= count; index += 1) {
        slots.push(normalizeLora({
            enable: getWidget(node, `LoRA${index}${ENABLE_SUFFIX}`)?.value,
            name: getWidget(node, `LoRA${index}${NAME_SUFFIX}`)?.value,
            strength: getWidget(node, `LoRA${index}${STRENGTH_SUFFIX}`)?.value,
        }));
    }
    return slots;
}

function saveCurrentGroup(node) {
    const groups = readGroups(node);
    const index = currentIndex(node, groups);
    const loras = snapshotSlots(node);
    groups[index] = { ...groups[index], loras: loras.length ? loras : [emptyLora()] };
    writeGroups(node, groups);
}

// 选到 None 的空槽自动收掉：与「GG LoRA自定义加载」同一行为。
// 启用状态跟着槽位一起前移，最后写回当前组，切组 / 读档都不会把空槽带回来。
function compactSlots(node) {
    const active = [];
    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const { enable, name, strength } = getPair(node, index);
        const loraName = String(name?.value ?? "None");
        if (loraName === "None") {
            continue;
        }
        active.push({
            enable: enable ? Boolean(enable.value) : true,
            name: loraName,
            strength: strength?.value ?? 1.0,
        });
    }
    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const slot = active[index - 1];
        writeWidget(node, `LoRA${index}${NAME_SUFFIX}`, slot?.name ?? "None");
        writeWidget(node, `LoRA${index}${STRENGTH_SUFFIX}`, slot ? slot.strength : 1.0);
        writeWidget(node, `LoRA${index}${ENABLE_SUFFIX}`, slot ? slot.enable : true);
    }
    setVisibleCount(node, active.length);
    updateSlotVisibility(node);
    saveCurrentGroup(node);
}

function applyGroup(node, group) {
    const loras = group.loras.length ? group.loras : [emptyLora()];
    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const slot = loras[index - 1];
        writeWidget(node, `LoRA${index}${NAME_SUFFIX}`, slot?.name ?? "None");
        writeWidget(node, `LoRA${index}${STRENGTH_SUFFIX}`, slot ? slot.strength : 1.0);
        writeWidget(node, `LoRA${index}${ENABLE_SUFFIX}`, slot ? slot.enable : true);
    }
    setVisibleCount(node, loras.length);
}

function ensureTabVisible(node, index) {
    const geometry = tabsGeometry(node);
    if (!geometry) {
        return;
    }
    const stride = TAB_W + TAB_GAP;
    const left = index * stride;
    const right = left + TAB_W;
    let scroll = Number(node._ggGroupScroll) || 0;
    if (left < scroll) {
        scroll = left;
    } else if (right > scroll + geometry.viewportW) {
        scroll = right - geometry.viewportW;
    }
    node._ggGroupScroll = clamp(scroll, 0, geometry.maxScroll);
}

function switchGroup(node, index) {
    saveCurrentGroup(node);
    const groups = readGroups(node);
    const next = clamp(index, 0, groups.length - 1);
    persistIndex(node, next);
    applyGroup(node, groups[next]);
    ensureTabVisible(node, next);
    updateSlotVisibility(node);
    refreshRowLayout(node);
    markDirty(node);
}

function addGroup(node) {
    saveCurrentGroup(node);
    const groups = readGroups(node);
    if (groups.length >= MAX_GROUPS) {
        return;
    }
    const nextId = groups.reduce((max, group) => Math.max(max, Number(group.id) || 0), 0) + 1;
    groups.push({ id: nextId, name: `LoRA组${nextId}`, loras: [emptyLora()] });
    writeGroups(node, groups);
    const index = groups.length - 1;
    persistIndex(node, index);
    applyGroup(node, groups[index]);
    ensureTabVisible(node, index);
    updateSlotVisibility(node);
    refreshRowLayout(node);
    markDirty(node);
}

function deleteGroup(node, index) {
    const groups = readGroups(node);
    if (!groups.length) {
        return;
    }
    const current = currentIndex(node, groups);
    // 不调 saveCurrentGroup：当前控件属于「即将被删的那一组」时，
    // 写回去只会把内容又塞进被删前的索引里。
    groups.splice(index, 1);
    if (!groups.length) {
        groups.push({ id: 1, name: "LoRA组1", loras: [emptyLora()] });
    }
    writeGroups(node, groups);
    let next = current;
    if (index < current) {
        next = current - 1;
    } else if (index === current) {
        next = Math.min(current, groups.length - 1);
    }
    next = clamp(next, 0, groups.length - 1);
    persistIndex(node, next);
    applyGroup(node, groups[next]);
    node._ggGroupScroll = 0;
    ensureTabVisible(node, next);
    updateSlotVisibility(node);
    refreshRowLayout(node);
    markDirty(node);
}

// ------------------------------------------------------------------
// 组标签条几何：绘制与命中检测共用同一份计算，避免「画在这儿、点在那儿」。
// ctx 已被 drawCustomColumn translate(column.x, 0)，所以这里 x 从 SIDE 起。
// ------------------------------------------------------------------
function clampScroll(node, maxScroll, value) {
    const next = clamp(Number.isFinite(value) ? value : (Number(node._ggGroupScroll) || 0),
        0, Math.max(0, maxScroll));
    node._ggGroupScroll = next;
    return next;
}

function tabsGeometry(node) {
    const widget = getWidget(node, TABS_WIDGET);
    const column = widget?._ggCol;
    if (!column) {
        return null;
    }
    const left = column.x + SIDE;
    const width = Math.max(60, column.w - SIDE * 2);
    const right = left + width;
    const top = Number(widget.y) || 0;
    const height = Number(widget.computedHeight) || TABS_H;
    const pad = 5;

    const arrowL = { x: left + pad, y: top + 4, w: ARROW_W, h: height - 8 };
    const arrowR = { x: right - pad - ARROW_W, y: top + 4, w: ARROW_W, h: height - 8 };
    const addGroup = {
        x: arrowR.x - 6 - ADD_GROUP_W,
        y: top + 4,
        w: ADD_GROUP_W,
        h: height - 8,
    };
    const viewportL = arrowL.x + ARROW_W + 6;
    const viewportR = addGroup.x - 8;
    const viewportW = Math.max(24, viewportR - viewportL);

    const groups = readGroups(node);
    const stride = TAB_W + TAB_GAP;
    const maxScroll = Math.max(0, groups.length * stride - TAB_GAP - viewportW);
    const scroll = clampScroll(node, maxScroll);

    const tabs = [];
    for (let index = 0; index < groups.length; index += 1) {
        const x = viewportL + index * stride - scroll;
        const tab = {
            index,
            group: groups[index],
            x,
            y: top + 4,
            w: TAB_W,
            h: height - 8,
        };
        tab.deleteRect = { x: x + TAB_W + 2, y: top + 6, w: DELETE_W, h: height - 12 };
        tab.visibleL = Math.max(x, viewportL);
        tab.visibleR = Math.min(x + TAB_W, viewportR);
        if (tab.visibleR > tab.visibleL) {
            tabs.push(tab);
        }
    }
    const geometry = {
        left, right, top, width, height,
        // 整条组标签条的命中矩形：➕ 和删除按钮都只在指针进到这条里才出现。
        bar: { x: left, y: top, w: width, h: height },
        arrowL, arrowR, addGroup,
        addVisible: node._ggGroupBarHover === true,
        addGlyph: ADD_GLYPH,
        viewportL, viewportR, viewportW,
        maxScroll, scroll, tabs,
    };
    // 调试/回归共用同一份几何：绘制、命中检测、验证脚本都读它，
    // 不另写一套坐标公式，避免「画在这儿、点在那儿」的假 PASS。
    node._ggGroupGeometry = geometry;
    return geometry;
}

function inRect(x, y, rect) {
    return !!rect && x >= rect.x && x <= rect.x + rect.w
        && y >= rect.y && y <= rect.y + rect.h;
}

function hitGroupBar(node, lx, ly) {
    const geometry = tabsGeometry(node);
    if (!geometry || ly < geometry.top || ly > geometry.top + geometry.height) {
        return null;
    }
    if (geometry.maxScroll > 0 && inRect(lx, ly, geometry.arrowL)) {
        return { kind: "group-arrow", dir: -1 };
    }
    if (geometry.maxScroll > 0 && inRect(lx, ly, geometry.arrowR)) {
        return { kind: "group-arrow", dir: 1 };
    }
    // ➕ 只在悬浮组条时可见，也只在那时可点；平时这块位置不响应，
    // 免得「看不见的按钮」把标签右端的点击吞掉。
    if (geometry.addVisible && inRect(lx, ly, geometry.addGroup)) {
        return { kind: "group-add" };
    }
    if (lx < geometry.viewportL || lx > geometry.viewportR) {
        return null;
    }
    for (const tab of geometry.tabs) {
        if (inRect(lx, ly, tab.deleteRect)) {
            return { kind: "group-delete", index: tab.index };
        }
        if (inRect(lx, ly, tab)) {
            return { kind: "group-select", index: tab.index };
        }
    }
    return { kind: "group-scroll" };
}

// ------------------------------------------------------------------
// 绘制：组标签条 + 名称列 + 启用列（自绘）。
// 「当前生效」提示条已按用户要求去掉：选中的组标签本身带高亮边框和底色，
// 标签就是状态，不需要再占一整行写「当前生效：xxx · 共 N 组」。
// 强度 / 新增按钮仍交给引擎的 drawSkinned 统一换肤。
// ------------------------------------------------------------------
let measureCtx = null;

function measureName(text) {
    if (!measureCtx) {
        measureCtx = document.createElement("canvas").getContext("2d");
        measureCtx.font = FONT;
    }
    return measureCtx.measureText(String(text ?? "")).width;
}

function nameDisplayValue(widget) {
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

// 名称格只展示文件名主体：`.safetensors` 之类后缀没有辨识度，却会吃掉
// 大半格宽度。这里**只改绘制文本**，widget.value / widgets_values 与提交给
// 后端的仍是带后缀的原名；滚轮平移看的也是这份去后缀文本。
const MODEL_SUFFIX_RE = /\.(?:safetensors|ckpt|pt|pth|bin|gguf|onnx|sft|lora)$/i;

function nameVisibleText(widget) {
    return nameDisplayValue(widget).replace(MODEL_SUFFIX_RE, "");
}

// 长模型名用「左右各留一段」的中间省略：既看得到文件名主体，也看得到
// .safetensors 后缀。只有名称列允许被省略，手柄 / 勾选 / 强度都完整显示。
function middleEllipsis(ctx, text, maxW) {
    const full = String(text ?? "");
    if (!full || maxW <= 8 || ctx.measureText(full).width <= maxW) {
        return full;
    }
    const budget = Math.max(0, maxW - ctx.measureText("…").width);
    const half = budget / 2;
    let head = "";
    let tail = "";
    let left = 0;
    let right = full.length;
    while (left < right) {
        let grew = false;
        if (ctx.measureText(head).width < half) {
            const next = head + full[left];
            if (ctx.measureText(next).width <= half) {
                head = next;
                left += 1;
                grew = true;
            }
        }
        if (left < right && ctx.measureText(tail).width < half) {
            const next = full[right - 1] + tail;
            if (ctx.measureText(next).width <= half) {
                tail = next;
                right -= 1;
                grew = true;
            }
        }
        if (!grew) {
            break;
        }
    }
    return `${head}…${tail}`;
}

// 名称列自绘：胶囊底 + 左右省略 / 滚轮平移 + 右侧下拉三角。
// 命中区仍是整格，点击照常走官方 combo 下拉，滚轮只用来左右看长名字。
function drawNameCell({ ctx, node, widget, width, y, height, showText }) {
    if (!String(widget?.name ?? "").endsWith(NAME_SUFFIX)) {
        return false;
    }
    // drawCustomColumn 已经 translate(column.x, 0)。这里反平移回去，整列改用
    // 节点局部绝对坐标画：绘制、命中、覆盖率探针因此共用同一份几何口径
    // （verify_skin_coverage 按 col.x+SIDE / widget.y 匹配 24px 胶囊底格，
    //  相对坐标会让第二列以后的自绘列假 FAIL）。
    const column = widget._ggCol;
    const originX = Number(column?.x) || 0;
    ctx.translate(-originX, 0);
    const x = originX + SIDE;
    const w = Math.max(20, (Number(width) || 0) - SIDE * 2);
    const h = Math.min(Number(height) || 24, 24);
    const gm = app.canvas?.graph_mouse;
    const lx = gm && node.pos ? gm[0] - node.pos[0] : null;
    const ly = gm && node.pos ? gm[1] - node.pos[1] : null;
    const hovered = lx != null && lx >= x && lx <= x + w
        && ly >= y - 2 && ly <= y + h + 2;
    paintCapsuleBase(ctx, x, y, w, h, showText !== false, hovered, node, widget);

    const C = theme(node, widget);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + w - 16, y + h / 2 - 3);
    ctx.lineTo(x + w - 10, y + h / 2 - 3);
    ctx.lineTo(x + w - 13, y + h / 2 + 2);
    ctx.closePath();
    ctx.fillStyle = C.muted;
    ctx.fill();
    if (showText) {
        const text = nameVisibleText(widget);
        const clipX = x + 8;
        const clipW = Math.max(10, w - 30);
        const maxScroll = Math.max(0, measureName(text) - clipW);
        const scroll = clamp(Number(widget._ggNameScroll) || 0, 0, maxScroll);
        widget._ggNameScroll = scroll;
        ctx.font = FONT;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = C.ink;
        ctx.save();
        ctx.beginPath();
        ctx.rect(clipX, y + 1, clipW, h - 2);
        ctx.clip();
        ctx.fillText(scroll > 0 ? text : middleEllipsis(ctx, text, clipW),
            clipX - scroll, y + h / 2 + 1);
        ctx.restore();
    }
    ctx.restore();
    return true;
}

function roundRectPath(ctx, x, y, w, h, radius) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
}

function drawTab(ctx, C, tab, selected, hovered, showDelete) {
    const rect = tab;
    ctx.save();
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 6);
    ctx.fillStyle = selected ? C.pickedBg : (hovered ? C.btnHover : C.btn);
    ctx.fill();
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? C.accent : C.divider;
    ctx.stroke();

    ctx.font = SMALL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = selected ? C.accent : C.ink;
    let label = String(tab.group?.name ?? `LoRA组${tab.index + 1}`);
    while (ctx.measureText(label).width > rect.w - 14 && label.length > 2) {
        label = `${label.slice(0, -2)}…`;
    }
    ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.restore();

    if (!showDelete) {
        return;
    }
    const d = tab.deleteRect;
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    const radius = Math.min(8, d.w / 2, d.h / 2);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = C.danger;
    ctx.fill();
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy - 3);
    ctx.lineTo(cx + 3, cy + 3);
    ctx.moveTo(cx + 3, cy - 3);
    ctx.lineTo(cx - 3, cy + 3);
    ctx.stroke();
    ctx.restore();
}

function drawTabsColumn({ ctx, node, widget, width, y, height, showText }) {
    const x = SIDE;
    const w = Math.max(60, (Number(width) || 0) - SIDE * 2);
    paintCapsuleBase(ctx, x, y, w, height, showText !== false, false, node, widget);

    const geometry = tabsGeometry(node);
    if (!geometry) {
        return true;
    }
    const C = theme(node, widget);
    const selected = currentIndex(node, readGroups(node));
    const hovered = node._ggGroupHover;

    ctx.save();
    ctx.beginPath();
    ctx.rect(geometry.viewportL, geometry.top + 2,
        geometry.viewportW, geometry.height - 4);
    ctx.clip();
    for (const tab of geometry.tabs) {
        drawTab(ctx, C, tab, tab.index === selected, tab.index === hovered,
            tab.index === hovered);
    }
    ctx.restore();

    // 两端翻页箭头：只有内容真的溢出时才可点，否则画成淡占位。
    const drawArrow = (rect, text, active) => {
        ctx.save();
        roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 4);
        ctx.fillStyle = active ? C.btn : "rgba(128,128,128,0.06)";
        ctx.fill();
        ctx.font = FONT;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = active ? C.ink : C.muted;
        ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h / 2);
        ctx.restore();
    };
    drawArrow(geometry.arrowL, "‹", geometry.maxScroll > 0 && geometry.scroll > 0);
    drawArrow(geometry.arrowR, "›",
        geometry.maxScroll > 0 && geometry.scroll < geometry.maxScroll);

    // 「新增组」改成 ➕ 小圆钮，和组删除按钮一样只在悬浮组条时出现。
    // 平时这块位置完全不画，标签视口因此多出 60 多像素；用 roundRect 画圆
    // 而不是 ctx.arc，避免与「删除按钮出现」的回归探针混在一起。
    if (geometry.addVisible) {
        const add = geometry.addGroup;
        const size = Math.min(add.w, add.h);
        const radius = size / 2;
        const cx = add.x + add.w / 2;
        const cy = add.y + add.h / 2;
        ctx.save();
        roundRectPath(ctx, cx - radius, cy - radius, size, size, radius);
        ctx.fillStyle = C.accent;
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(cx - 4, cy);
        ctx.lineTo(cx + 4, cy);
        ctx.moveTo(cx, cy - 4);
        ctx.lineTo(cx, cy + 4);
        ctx.stroke();
        ctx.restore();
    }
    return true;
}

function loraRows(node) {
    const rows = node?._ggRowLayout?.rows ?? [];
    // 提示条 / 组标签条 / 「新增LoRA」按钮都是单控件行，过滤掉只留三列 LoRA 行。
    return rows.filter((row) => Array.isArray(row) && row.length > 1);
}

function findInRow(row, suffix) {
    return row?.find((widget) => String(widget?.name ?? "").endsWith(suffix)) ?? null;
}

function shapeRect(widget) {
    const column = widget?._ggCol;
    if (!column) {
        return null;
    }
    const top = Number(widget.y) || 0;
    return {
        x: column.x + SIDE,
        y: top,
        w: Math.max(10, column.w - SIDE * 2),
        h: widgetHeight(widget),
    };
}

// 启用列一分为二的唯一几何来源：绘制、命中检测、回归脚本都读它。
// originX = 0 返回节点局部绝对坐标（给指针命中用）；drawColumn 里 ctx 已被
// translate(column.x, 0)，传 column.x 就得到列内相对坐标（给绘制用）。
function enableGeometry(widget, originX = 0) {
    const shape = shapeRect(widget);
    if (!shape) {
        return null;
    }
    let gap = clamp(shape.w * CAPSULE_GAP_RATIO, CAPSULE_GAP_MIN, CAPSULE_GAP_MAX);
    let handleW = clamp((shape.w - gap) * HANDLE_RATIO, HANDLE_MIN_W, HANDLE_MAX_W);
    let toggleW = Math.max(CHECK_BOX + 4, shape.w - gap - handleW);
    const total = handleW + gap + toggleW;
    if (total > shape.w) {
        const scale = shape.w / total;
        handleW = Math.max(12, handleW * scale);
        gap = Math.max(3, gap * scale);
        toggleW = Math.max(12, shape.w - handleW - gap);
    }
    const base = { y: shape.y, h: shape.h };
    return {
        shape: { x: shape.x - originX, y: shape.y, w: shape.w, h: shape.h },
        handle: { ...base, x: shape.x - originX, w: handleW },
        toggle: { ...base, x: shape.x + handleW + gap - originX, w: toggleW },
        gap,
    };
}

function handleRect(widget) {
    return enableGeometry(widget)?.handle ?? null;
}

function drawEnableCell({ ctx, node, widget, width, y, height, showText }) {
    if (!String(widget?.name ?? "").endsWith(ENABLE_SUFFIX)) {
        return false;
    }
    const rowsOfNode = loraRows(node);
    const rowIndex = rowsOfNode.findIndex((row) => row.includes(widget));
    const drag = pointerState.drag;
    const isSource = !!drag && drag.node === node && drag.from === rowIndex;
    const isTarget = !!drag && drag.node === node && drag.to === rowIndex && drag.from !== drag.to;
    // 与名称列同口径：反平移后用节点局部绝对坐标画，绘制 / 命中 / 回归
    // 都读 enableGeometry(widget) 这一份几何，不另写第二套公式。
    const geo = enableGeometry(widget);
    if (!geo) {
        return false;
    }
    widget._ggEnableGeometry = geo;
    ctx.translate(-(Number(widget._ggCol?.x) || 0), 0);

    // 两个独立胶囊，中间是一段什么都不画的空白：手柄与开关不再挤在同一格里。
    paintCapsuleBase(ctx, geo.handle.x, y, geo.handle.w, height,
        showText !== false, isSource || isTarget, node, widget);
    paintCapsuleBase(ctx, geo.toggle.x, y, geo.toggle.w, height,
        showText !== false, false, node, widget);

    const box = Math.min(CHECK_BOX, geo.toggle.w - 4);
    const bx = geo.toggle.x + (geo.toggle.w - box) / 2;
    const top = y + (height - box) / 2;
    const dotX = geo.handle.x + geo.handle.w / 2 - 2.5;
    const on = Boolean(widget.value);

    ctx.save();
    if (isSource || isTarget) {
        roundRectPath(ctx, geo.handle.x + 1, y + 3, geo.handle.w - 2, height - 6, 4);
        ctx.fillStyle = isTarget ? "rgba(59,130,246,0.22)" : "rgba(59,130,246,0.12)";
        ctx.fill();
    }
    ctx.fillStyle = isSource || isTarget ? "#2563EB" : "rgba(105,116,138,0.72)";
    for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 2; col += 1) {
            ctx.beginPath();
            ctx.arc(dotX + col * 5, y + height / 2 - 5 + row * 5, 1.2, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    ctx.lineWidth = 1.5;
    roundRectPath(ctx, bx, top, box, box, 4);
    ctx.fillStyle = on ? "#3f8f4a" : "rgba(120,120,120,0.16)";
    ctx.strokeStyle = on ? "#7ee08a" : "rgba(105,105,105,0.9)";
    ctx.fill();
    ctx.stroke();
    if (on) {
        ctx.beginPath();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2;
        ctx.moveTo(bx + box * 0.24, top + box * 0.52);
        ctx.lineTo(bx + box * 0.44, top + box * 0.74);
        ctx.lineTo(bx + box * 0.78, top + box * 0.26);
        ctx.stroke();
    }
    ctx.restore();
    return true;
}

function drawColumn(args) {
    const name = String(args.widget?.name ?? "");
    if (name === TABS_WIDGET) {
        return drawTabsColumn(args);
    }
    if (name.endsWith(NAME_SUFFIX)) {
        return drawNameCell(args);
    }
    return drawEnableCell(args);
}

function rows(node) {
    const result = [];
    const tabs = getWidget(node, TABS_WIDGET);
    if (tabs) {
        result.push([tabs]);
    }
    const count = getVisibleCount(node);
    for (let index = 1; index <= count; index += 1) {
        const enable = getWidget(node, `LoRA${index}${ENABLE_SUFFIX}`);
        const name = getWidget(node, `LoRA${index}${NAME_SUFFIX}`);
        const strength = getWidget(node, `LoRA${index}${STRENGTH_SUFFIX}`);
        for (const widget of [name, strength]) {
            if (widget && widget.label !== " ") {
                widget.label = " ";
            }
        }
        const row = [enable, name, strength].filter(Boolean);
        if (row.length) {
            result.push(row);
        }
    }
    const addButton = getWidget(node, ADD_LORA_BUTTON);
    if (addButton) {
        result.push([addButton]);
    }
    return result;
}

registerRowLayout(TARGET_CLASS, {
    minWidth: 460,
    // 高度永远贴合内容行：不接收用户拖出来的额外高度，也不随工作流持久化。
    // 根治「内容行数没变却留一大片空白、看着像节点自己在变高」的问题。
    lockHeightToContent: true,
    drawColumn,
    pack: false,
    // 启用列从 9% 提到 18%：拆成「手柄胶囊 + 空白 + 勾选胶囊」后，
    // 默认 460 宽仍能完整放下六点手柄、18px 勾选框和中间那段空白。
    // 强度保持 9%（37px 足够显示 1.00），其余全给名称列让它自己省略。
    weights: { 3: [18, 73, 9], 2: [14, 86] },
    compactSingle(widget) {
        return widget?.name === ADD_LORA_BUTTON;
    },
    centerSingle(widget) {
        return widget?.name === ADD_LORA_BUTTON;
    },
    rows,
});

// ------------------------------------------------------------------
// 隐藏 / 显示槽位：与旧 LoRA 节点同一套做法（type 打隐藏标记 + 收掉
// computeSize / computedHeight / input.pos），保证节点高度贴合可见行数。
// ------------------------------------------------------------------
function getPair(node, index) {
    return {
        enable: getWidget(node, `LoRA${index}${ENABLE_SUFFIX}`),
        name: getWidget(node, `LoRA${index}${NAME_SUFFIX}`),
        strength: getWidget(node, `LoRA${index}${STRENGTH_SUFFIX}`),
    };
}

function isHiddenWidget(widget) {
    return !widget || widget.hidden || String(widget.type ?? "").startsWith(HIDDEN_TAG);
}

function findInputForWidget(node, widget) {
    if (!node?.inputs?.length || !widget?.name) {
        return null;
    }
    return node.inputs.find((input) => input?.widget?.name === widget.name)
        ?? node.inputs.find((input) => input?.name === widget.name)
        ?? null;
}

function ensureWidgetInputBinding(node, widget) {
    const input = findInputForWidget(node, widget);
    if (input && (!input.widget || input.widget.name !== widget.name)) {
        input.widget = { name: widget.name };
    }
    return input;
}

function clearSlotPosition(input) {
    if (input) {
        delete input.pos;
    }
}

function parkHiddenInputSlot(node, widget) {
    const input = ensureWidgetInputBinding(node, widget);
    if (!input) {
        return;
    }
    clearSlotPosition(input);
    input._ggLoraGroupHidden = true;
    if ("alwaysVisible" in input) {
        input.alwaysVisible = false;
    }
}

function restoreInputSlot(node, widget) {
    const input = ensureWidgetInputBinding(node, widget);
    if (!input) {
        return;
    }
    delete input._ggLoraGroupHidden;
    clearSlotPosition(input);
}

function doesInputWithNameLink(node, name, show) {
    return node.inputs
        ? node.inputs.some((input) => input.name === name && input.link != null && !show)
        : false;
}

function toggleWidget(node, widget, show = false, suffix = "") {
    if (!widget || doesInputWithNameLink(node, widget.name, show)) {
        return;
    }
    if (!widgetState.has(widget.name)) {
        widgetState.set(widget.name, {
            origType: widget.type,
            origComputeSize: widget.computeSize,
            origComputedHeight: widget.computedHeight,
        });
    }
    const state = widgetState.get(widget.name);
    if (show) {
        widget.type = state.origType;
        widget.hidden = false;
    } else {
        widget.hidden = true;
        widget.type = `${HIDDEN_TAG}${suffix}`;
    }
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
    widget.linkedWidgets?.forEach((linked) => {
        toggleWidget(node, linked, show, `:${widget.name}`);
    });
}

function cleanupHiddenSlots(node) {
    for (const widget of node.widgets ?? []) {
        if (!widget?.name) {
            continue;
        }
        const isSlot = widget.name === COUNT_WIDGET_NAME
            || widget.name === GROUP_INDEX_WIDGET
            || /^LoRA\d+(名称|强度|启用)$/.test(widget.name);
        if (!isSlot) {
            continue;
        }
        ensureWidgetInputBinding(node, widget);
        if (!isHiddenWidget(widget)) {
            continue;
        }
        widget.hidden = true;
        widget.computedHeight = 0;
        widget.y = 0;
        widget.last_y = 0;
        if (!String(widget.type ?? "").startsWith(HIDDEN_TAG)) {
            if (!widgetState.has(widget.name)) {
                widgetState.set(widget.name, {
                    origType: widget.type,
                    origComputeSize: widget.computeSize,
                    origComputedHeight: widget.computedHeight,
                });
            }
            widget.type = HIDDEN_TAG;
            widget.computeSize = () => [0, -4];
        }
        parkHiddenInputSlot(node, widget);
    }
    for (const input of node.inputs ?? []) {
        if (input?._ggLoraGroupHidden) {
            clearSlotPosition(input);
            if ("alwaysVisible" in input) {
                input.alwaysVisible = false;
            }
        }
    }
}

function refreshNode(node) {
    cleanupHiddenSlots(node);
    if (typeof node.computeSize === "function") {
        const [width, height] = node.computeSize();
        const nextWidth = Math.max(Number(node.size?.[0]) || 0, width);
        if (typeof node.setSize === "function") {
            node.setSize([nextWidth, height]);
        } else if (node.size?.length === 2) {
            node.size[0] = nextWidth;
            node.size[1] = height;
        }
    }
    try {
        node.arrange?.();
    } catch {
        // 节点尚未挂到 graph 时 arrange 不可用
    }
    cleanupHiddenSlots(node);
    markDirty(node);
}

function updateSlotVisibility(node) {
    const visibleCount = getVisibleCount(node);
    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const { enable, name, strength } = getPair(node, index);
        const show = index <= visibleCount;
        toggleWidget(node, enable, show);
        toggleWidget(node, name, show);
        toggleWidget(node, strength, show);
    }
    refreshNode(node);
    refreshRowLayout(node);
    requestAnimationFrame(() => {
        refreshNode(node);
        refreshRowLayout(node);
    });
}

function installCustomWidgets(node) {
    if (!node || !Array.isArray(node.widgets)) {
        return;
    }
    const make = (name, type, rowHeight) => {
        if (getWidget(node, name)) {
            return;
        }
        let widget = null;
        const spec = {
            name,
            type,
            value: null,
            serialize: false,
            computeSize: () => [0, rowHeight],
            draw() {},
        };
        if (typeof node.addCustomWidget === "function") {
            widget = node.addCustomWidget(spec) ?? getWidget(node, name);
        } else if (typeof node.addWidget === "function") {
            widget = node.addWidget(type, name, null, () => {}, { serialize: false });
        }
        if (widget) {
            widget.computedHeight = rowHeight;
            widget.options ??= {};
            widget.serialize = false;
        }
    };
    make(TABS_WIDGET, "gg_lora_group_tabs", TABS_H);
}

function installAddButton(node) {
    if (getWidget(node, ADD_LORA_BUTTON)) {
        return;
    }
    const button = node.addWidget("button", ADD_LORA_BUTTON, ADD_LORA_BUTTON, () => {
        const count = getVisibleCount(node);
        if (count >= MAX_LORAS) {
            return;
        }
        setVisibleCount(node, count + 1);
        updateSlotVisibility(node);
    });
    if (button) {
        button.serializeValue = () => undefined;
        button.serialize = false;
    }
}

function installStrengthPrecision(node) {
    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const widget = getWidget(node, `LoRA${index}${STRENGTH_SUFFIX}`);
        if (!widget) {
            continue;
        }
        widget.options ??= {};
        if (!Number.isFinite(Number(widget.options.precision))) {
            widget.options.precision = 2;
        }
    }
}

function installSlotCallbacks(node) {
    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const { name, strength } = getPair(node, index);
        for (const widget of [name, strength]) {
            if (!widget || widget._ggLoraGroupCallback) {
                continue;
            }
            widget._ggLoraGroupCallback = true;
            const original = widget.callback;
            widget.callback = function (value, ...args) {
                original?.call(this, value, ...args);
                const isName = String(this.name ?? "").endsWith(NAME_SUFFIX);
                // 换了模型名就回到「左右省略」的初始态，别留着上一条的平移量。
                if (isName) {
                    this._ggNameScroll = 0;
                }
                // 选到 None 直接收掉这一行，和「GG LoRA自定义加载」一致。
                if (isName && value === "None") {
                    compactSlots(node);
                    return;
                }
                refreshNode(node);
            };
        }
    }
}

function syncInitialState(node) {
    if (getVisibleCount(node) < 1) {
        setVisibleCount(node, 1);
    }
    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const { enable } = getPair(node, index);
        if (enable && typeof enable.value !== "boolean") {
            enable.value = true;
        }
    }
    const groups = readGroups(node);
    let index = Number(node.properties?.[PROP_INDEX]);
    if (!Number.isFinite(index)) {
        const widgetValue = Number(getWidget(node, GROUP_INDEX_WIDGET)?.value);
        index = Number.isFinite(widgetValue) ? widgetValue - 1 : 0;
    }
    persistIndex(node, clamp(Math.round(index), 0, groups.length - 1));
}

function setupNode(node) {
    if (!node || node.comfyClass !== TARGET_CLASS) {
        return;
    }
    if (!getWidget(node, COUNT_WIDGET_NAME)) {
        return;
    }
    installCustomWidgets(node);
    // 兼容旧会话里已经挂过提示条的节点：不再画它，也不让它占一行高度。
    const legacyHint = getWidget(node, HINT_WIDGET);
    if (legacyHint) {
        toggleWidget(node, legacyHint, false);
    }
    installAddButton(node);
    installSlotCallbacks(node);
    installStrengthPrecision(node);
    installPointerHandlers();
    toggleWidget(node, getWidget(node, COUNT_WIDGET_NAME), false);
    toggleWidget(node, getWidget(node, GROUP_INDEX_WIDGET), false);
    syncInitialState(node);
    // 以 widgets_values 为准回写当前组：用户没切组就保存工作流时，
    // properties 里那份旧数据不会把最后的编辑盖掉。
    saveCurrentGroup(node);
    updateSlotVisibility(node);
    refreshRowLayout(node);
}

// ------------------------------------------------------------------
// 交互：捕获阶段统一处理组标签条（选中 / 删除 / 新增 / 翻页 / 横向滑动）、
// LoRA 行拖拽重排、强度点击编辑。命中区与绘制共用 tabsGeometry / shapeRect。
// ------------------------------------------------------------------
function eventToGraph(event) {
    const canvas = app.canvas;
    if (typeof canvas?.convertEventToCanvasOffset !== "function") {
        return null;
    }
    const pos = canvas.convertEventToCanvasOffset(event);
    return Array.isArray(pos) && pos.length >= 2 ? pos : null;
}

function groupNodes() {
    return (app.graph?._nodes ?? []).filter((node) => node?.comfyClass === TARGET_CLASS && node.pos);
}

function locatePointer(event) {
    const pos = eventToGraph(event);
    if (!pos) {
        return null;
    }
    for (const node of groupNodes()) {
        const lx = pos[0] - node.pos[0];
        const ly = pos[1] - node.pos[1];
        const groupHit = hitGroupBar(node, lx, ly);
        if (groupHit) {
            return { ...groupHit, node, lx, ly };
        }
        const rowsOfNode = loraRows(node);
        for (let index = 0; index < rowsOfNode.length; index += 1) {
            const enable = findInRow(rowsOfNode[index], ENABLE_SUFFIX);
            const strength = findInRow(rowsOfNode[index], STRENGTH_SUFFIX);
            if (inRect(lx, ly, handleRect(enable))) {
                return { kind: "drag", node, rows: rowsOfNode, index };
            }
            const strengthRect = shapeRect(strength);
            if (strengthRect && inRect(lx, ly, {
                x: strengthRect.x, y: strengthRect.y,
                w: strengthRect.w, h: strengthRect.h,
            })) {
                return { kind: "strength", node, widget: strength, rect: strengthRect };
            }
        }
    }
    return null;
}

function updateHover(event) {
    const pos = eventToGraph(event);
    if (!pos) {
        return;
    }
    let changed = false;
    for (const node of groupNodes()) {
        const lx = pos[0] - node.pos[0];
        const ly = pos[1] - node.pos[1];
        // 先更新「指针是否在这条组标签条里」：➕ 的显隐与可点性都读它，
        // 顺序反了会出现「悬浮第一帧点不动」。
        const geometry = tabsGeometry(node);
        const barHover = !!geometry && inRect(lx, ly, geometry.bar);
        if (node._ggGroupBarHover !== barHover) {
            node._ggGroupBarHover = barHover;
            changed = true;
        }
        const hit = hitGroupBar(node, lx, ly);
        const next = hit && (hit.kind === "group-select" || hit.kind === "group-delete")
            ? hit.index : null;
        if (node._ggGroupHover !== next) {
            node._ggGroupHover = next;
            changed = true;
        }
    }
    if (changed) {
        app.canvas?.setDirty?.(true, true);
    }
}

function clampStrength(widget, value) {
    const min = Number(widget?.options?.min);
    const max = Number(widget?.options?.max);
    return Math.min(Number.isFinite(max) ? max : 10,
        Math.max(Number.isFinite(min) ? min : -10, value));
}

function setStrength(node, widget, value) {
    const next = clampStrength(widget, Number(value));
    if (!Number.isFinite(next)) {
        return;
    }
    widget.value = next;
    widget.callback?.(next);
    markDirty(node);
}

function promptStrength(node, widget, event) {
    const done = (text) => {
        const parsed = Number(String(text ?? "").trim());
        if (Number.isFinite(parsed)) {
            setStrength(node, widget, parsed);
        }
    };
    if (typeof app.canvas?.prompt === "function") {
        app.canvas.prompt("强度", String(widget.value), done, event);
    } else {
        const text = globalThis.prompt?.("强度", String(widget.value));
        if (text != null) {
            done(text);
        }
    }
}

function reorderLoras(node, from, to) {
    const rowsOfNode = loraRows(node);
    if (from === to || from < 0 || to < 0
        || from >= rowsOfNode.length || to >= rowsOfNode.length) {
        return false;
    }
    // 只搬值、不搬控件对象：LoRA1/2/3 的槽位与 widgets_values 位置保持不变。
    const snapshots = rowsOfNode.map((row) => ({
        enable: findInRow(row, ENABLE_SUFFIX)?.value,
        name: findInRow(row, NAME_SUFFIX)?.value,
        strength: findInRow(row, STRENGTH_SUFFIX)?.value,
    }));
    const [moved] = snapshots.splice(from, 1);
    snapshots.splice(to, 0, moved);
    snapshots.forEach((snap, index) => {
        const enable = findInRow(rowsOfNode[index], ENABLE_SUFFIX);
        const name = findInRow(rowsOfNode[index], NAME_SUFFIX);
        const strength = findInRow(rowsOfNode[index], STRENGTH_SUFFIX);
        if (enable && snap.enable !== undefined) enable.value = snap.enable;
        if (name && snap.name !== undefined) name.value = snap.name;
        if (strength && snap.strength !== undefined) strength.value = snap.strength;
    });
    refreshNode(node);
    refreshRowLayout(node);
    return true;
}

function scrollBy(node, delta) {
    const geometry = tabsGeometry(node);
    if (!geometry) {
        return;
    }
    clampScroll(node, geometry.maxScroll, geometry.scroll + delta);
    markDirty(node);
}

// ------------------------------------------------------------------
// 组重命名：右键组标签（或键盘菜单键）弹出改名输入框。
// 右键同时也要挡住画布 / 节点的原生右键菜单，所以 pointerdown 与
// contextmenu 都拦，指针按下时置一个短窗口给紧随其后的 contextmenu。
// ------------------------------------------------------------------
let suppressContextMenuUntil = 0;

function locateGroupTab(event) {
    const pos = eventToGraph(event);
    if (!pos) {
        return null;
    }
    for (const node of groupNodes()) {
        const lx = pos[0] - node.pos[0];
        const ly = pos[1] - node.pos[1];
        const hit = hitGroupBar(node, lx, ly);
        if (hit && (hit.kind === "group-select" || hit.kind === "group-delete")) {
            return { node, index: hit.index };
        }
    }
    return null;
}

function renameGroup(node, index, event) {
    if (!node) {
        return;
    }
    // 先把当前控件写回旧组：用户可能刚改完还没切组，直接序列化会丢这次编辑。
    saveCurrentGroup(node);
    const groups = readGroups(node);
    const group = groups[index];
    if (!group) {
        return;
    }
    const apply = (text) => {
        const name = String(text ?? "").trim().slice(0, 24);
        if (!name) {
            return;
        }
        group.name = name;
        writeGroups(node, groups);
        markDirty(node);
    };
    if (typeof app.canvas?.prompt === "function") {
        app.canvas.prompt("组名称", group.name, apply, event);
    } else {
        const text = globalThis.prompt?.("组名称", group.name);
        if (text != null) {
            apply(text);
        }
    }
}

function onContextMenu(event) {
    if (Date.now() < suppressContextMenuUntil) {
        event.stopImmediatePropagation();
        event.preventDefault();
        return;
    }
    const hit = locateGroupTab(event);
    if (!hit) {
        return;
    }
    event.stopImmediatePropagation();
    event.preventDefault();
    renameGroup(hit.node, hit.index, event);
}

function onPointerDown(event) {
    if (event.button === 2) {
        const hit = locateGroupTab(event);
        if (hit) {
            event.stopImmediatePropagation();
            event.preventDefault();
            suppressContextMenuUntil = Date.now() + 500;
            renameGroup(hit.node, hit.index, event);
        }
        return;
    }
    if (event.button !== 0) {
        return;
    }
    // 触控 / 直接落点没有前置 pointermove 时也保证 ➕ 已经显形。
    updateHover(event);
    const hit = locatePointer(event);
    if (!hit) {
        return;
    }
    event.stopImmediatePropagation();
    event.preventDefault();
    if (hit.kind === "drag") {
        pointerState.drag = { node: hit.node, from: hit.index, to: hit.index, rows: hit.rows };
    } else if (hit.kind === "group-scroll") {
        const geometry = tabsGeometry(hit.node);
        pointerState.scroll = {
            node: hit.node,
            startX: hit.lx,
            startScroll: geometry?.scroll ?? 0,
            maxScroll: geometry?.maxScroll ?? 0,
        };
    } else {
        pointerState.press = hit;
    }
    markDirty(hit.node);
}

function onPointerMove(event) {
    updateHover(event);
    const drag = pointerState.drag;
    const scroll = pointerState.scroll;
    if (!drag && !scroll) {
        return;
    }
    const pos = eventToGraph(event);
    if (!pos) {
        return;
    }
    if (scroll) {
        const lx = pos[0] - scroll.node.pos[0];
        clampScroll(scroll.node, scroll.maxScroll, scroll.startScroll - (lx - scroll.startX));
        markDirty(scroll.node);
        event.preventDefault();
        return;
    }
    const ly = pos[1] - drag.node.pos[1];
    let target = 0;
    for (let index = 0; index < drag.rows.length; index += 1) {
        const first = drag.rows[index][0];
        const center = (Number(first?.y) || 0) + widgetHeight(first) / 2;
        target = index;
        if (ly < center) {
            break;
        }
    }
    const next = clamp(target, 0, drag.rows.length - 1);
    if (next !== drag.to) {
        drag.to = next;
        markDirty(drag.node);
    }
    event.preventDefault();
}

function onPointerUp(event) {
    const drag = pointerState.drag;
    const press = pointerState.press;
    const scroll = pointerState.scroll;
    if (!drag && !press && !scroll) {
        return;
    }
    event.stopImmediatePropagation();
    event.preventDefault();
    pointerState.drag = null;
    pointerState.press = null;
    pointerState.scroll = null;

    if (drag) {
        if (drag.from !== drag.to) {
            reorderLoras(drag.node, drag.from, drag.to);
        }
        markDirty(drag.node);
        return;
    }
    if (scroll) {
        markDirty(scroll.node);
        return;
    }

    const { node } = press;
    switch (press.kind) {
        case "group-arrow":
            scrollBy(node, press.dir * (TAB_W + TAB_GAP));
            break;
        case "group-add":
            addGroup(node);
            break;
        case "group-delete":
            deleteGroup(node, press.index);
            break;
        case "group-select": {
            // 松手时仍在同一个组按钮上才算点击，拖出去不误切组。
            const now = locatePointer(event);
            if (now?.kind === "group-select" && now.node === node && now.index === press.index) {
                switchGroup(node, press.index);
            }
            break;
        }
        case "strength": {
            const pos = eventToGraph(event);
            const lx = pos ? pos[0] - node.pos[0] : (press.rect.x + press.rect.w / 2);
            const ratio = clamp((lx - press.rect.x) / Math.max(1, press.rect.w), 0, 1);
            const step = Number(press.widget?.options?.step) || STRENGTH_STEP;
            if (ratio < 0.25) {
                setStrength(node, press.widget, Number(press.widget.value) - step);
            } else if (ratio > 0.75) {
                setStrength(node, press.widget, Number(press.widget.value) + step);
            } else {
                promptStrength(node, press.widget, event);
            }
            break;
        }
        default:
            break;
    }
    markDirty(node);
}

function onWheel(event) {
    const pos = eventToGraph(event);
    if (!pos) {
        return;
    }
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX : event.deltaY;
    for (const node of groupNodes()) {
        const lx = pos[0] - node.pos[0];
        const ly = pos[1] - node.pos[1];
        const geometry = tabsGeometry(node);
        if (geometry && lx >= geometry.left && lx <= geometry.right
            && ly >= geometry.top && ly <= geometry.top + geometry.height) {
            scrollBy(node, delta);
            // 画布默认拿 wheel 缩放，命中组标签条时必须拦下来。
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
        }
        // 名称列：左右滚轮平移查看被省略的长文件名。只在真的被省略时拦，
        // 否则把 wheel 还给画布；点击下拉完全不受影响。
        for (const row of loraRows(node)) {
            const nameWidget = findInRow(row, NAME_SUFFIX);
            const rect = shapeRect(nameWidget);
            if (!rect || !inRect(lx, ly, rect)) {
                continue;
            }
            const clipW = Math.max(10, rect.w - 30);
            const maxScroll = Math.max(0, measureName(nameVisibleText(nameWidget)) - clipW);
            if (maxScroll <= 0) {
                return;
            }
            nameWidget._ggNameScroll = clamp(
                (Number(nameWidget._ggNameScroll) || 0) + delta * NAME_SCROLL_STEP,
                0, maxScroll,
            );
            markDirty(node);
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
        }
    }
}

function installPointerHandlers() {
    const canvas = app.canvas?.canvas;
    if (!canvas || canvas._ggLoraGroupPointerInstalled) {
        return;
    }
    canvas._ggLoraGroupPointerInstalled = true;
    canvas.addEventListener("pointerdown", onPointerDown, true);
    canvas.addEventListener("contextmenu", onContextMenu, true);
    canvas.addEventListener("wheel", onWheel, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
}

app.registerExtension({
    name: "ComfyUI.GuliNodes.LoRAGroupLoader",

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
        if (node.comfyClass === TARGET_CLASS) {
            setTimeout(() => setupNode(node), 0);
        }
    },

    loadedGraphNode(node) {
        if (node.comfyClass === TARGET_CLASS) {
            setTimeout(() => setupNode(node), 0);
        }
    },

    async afterConfigureGraph() {
        for (const node of groupNodes()) {
            setTimeout(() => setupNode(node), 0);
        }
    },
});
