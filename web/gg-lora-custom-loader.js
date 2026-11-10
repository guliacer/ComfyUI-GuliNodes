import { app } from "../../scripts/app.js";
import { registerRowLayout, refreshRowLayout, paintCapsuleBase } from "./gg-widget-rows.js";

const TARGET_CLASS = "GGLoRACustomLoader";
const COUNT_WIDGET_NAME = "LoRA数量";
const ADD_BUTTON_NAME = "新增LoRA";
const HIDDEN_TAG = "ggHiddenLoRA";
const MAX_LORAS = 20;
const widgetState = {};

// 一行三个：启用开关 / LoRA 名称 / 强度。
// 启用列必须能拆成「独立拖拽胶囊 + 空白间隔 + 独立启用胶囊」；强度列必须能完整显示
// 形如 1.00 的数值。因此不能再把启用列压到 9%，也不能让强度列跟着等比缩到 37px。
// 采用与 GG LoRA组加载 相同的启用几何，默认 460 宽下仍让名称列占主要空间。
// 新增按钮保持按内容宽贴紧并居中。启用列是自绘控件，左侧带拖拽手柄。
const ENABLE_SUFFIX = "启用";
const STRENGTH_SUFFIX = "强度";
const NAME_SUFFIX = "名称";
// 列矩形的形状区间 = [col.x + SIDE, col.x + col.w - SIDE]，SIDE 与引擎里一致。
const SIDE = 15;
const STRENGTH_STEP = 0.05;
const CAPSULE_GAP_RATIO = 0.12;
const CAPSULE_GAP_MIN = 6;
const CAPSULE_GAP_MAX = 12;
const HANDLE_RATIO = 0.42;
const HANDLE_MIN_W = 18;
const HANDLE_MAX_W = 34;
const CHECK_BOX = 18;

// 当前拖拽状态（模块级，绘制层与 pointer 层共用）。
const pointerState = { drag: null, press: null };

function loraRows(node) {
  const rows = node?._ggRowLayout?.rows ?? [];
  // 最后一行是「新增LoRA」按钮（单控件行），不参与重排。
  return rows.filter((row) => Array.isArray(row) && row.length > 1);
}

function findInRow(row, suffix) {
  return row?.find((widget) => String(widget?.name ?? "").endsWith(suffix)) ?? null;
}

function widgetHeight(widget) {
  return Number(widget?.computedHeight) || 24;
}

// 控件形状区（节点局部坐标），与 drawSkinned / getWidgetOnPos 同一套口径。
function shapeRect(widget) {
  const col = widget?._ggCol;
  if (!col) return null;
  return {
    left: col.x + SIDE,
    right: col.x + col.w - SIDE,
    top: Number(widget.y) || 0,
    bottom: (Number(widget.y) || 0) + widgetHeight(widget),
  };
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

// 启用列的一份几何同时服务绘制和命中，确保中间间隔是真空白。
function enableGeometry(widget) {
  const shape = shapeRect(widget);
  if (!shape) return null;
  let gap = clamp(shape.right - shape.left > 0 ? (shape.right - shape.left) * CAPSULE_GAP_RATIO : 0,
    CAPSULE_GAP_MIN, CAPSULE_GAP_MAX);
  let handleW = clamp((shape.right - shape.left - gap) * HANDLE_RATIO, HANDLE_MIN_W, HANDLE_MAX_W);
  let toggleW = Math.max(CHECK_BOX + 4, shape.right - shape.left - gap - handleW);
  const total = handleW + gap + toggleW;
  if (total > shape.right - shape.left) {
    const scale = (shape.right - shape.left) / total;
    handleW = Math.max(12, handleW * scale);
    gap = Math.max(3, gap * scale);
    toggleW = Math.max(12, shape.right - shape.left - handleW - gap);
  }
  return {
    shape,
    handle: { left: shape.left, right: shape.left + handleW, top: shape.top, bottom: shape.bottom },
    toggle: { left: shape.left + handleW + gap, right: shape.right, top: shape.top, bottom: shape.bottom },
    gap,
  };
}

function handleRect(widget) {
  return enableGeometry(widget)?.handle ?? null;
}

function inRect(x, y, rect) {
  return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// 启用列：左侧独立拖拽胶囊 + 中间空白 + 右侧独立启用胶囊。
function drawEnableCell({ ctx, node, widget, y, height, showText }) {
  if (!String(widget?.name ?? "").endsWith(ENABLE_SUFFIX)) return false;
  const rows = loraRows(node);
  const rowIndex = rows.findIndex((row) => row.includes(widget));
  const drag = pointerState.drag;
  const isSource = !!drag && drag.node === node && drag.from === rowIndex;
  const isTarget = !!drag && drag.node === node && drag.to === rowIndex && drag.from !== drag.to;
  const geo = enableGeometry(widget);
  if (!geo) return false;

  widget._ggEnableGeometry = geo;
  // drawCustomColumn 已经把 ctx 平移到列内；这里回到节点局部绝对坐标，
  // 让两个胶囊、命中区域和其它列共享同一套 x 坐标。
  ctx.save();
  ctx.translate(-(Number(widget._ggCol?.x) || 0), 0);
  paintCapsuleBase(ctx, geo.handle.left, y, geo.handle.right - geo.handle.left, height,
    showText !== false, isSource || isTarget, node, widget);
  paintCapsuleBase(ctx, geo.toggle.left, y, geo.toggle.right - geo.toggle.left, height,
    showText !== false, false, node, widget);

  const box = Math.min(CHECK_BOX, geo.toggle.right - geo.toggle.left - 4);
  const boxLeft = geo.toggle.left + ((geo.toggle.right - geo.toggle.left) - box) / 2;
  const top = y + (height - box) / 2;
  const dotX = geo.handle.left + (geo.handle.right - geo.handle.left) / 2 - 2.5;
  const on = Boolean(widget.value);

  if (isSource || isTarget) {
    ctx.beginPath();
    ctx.roundRect(geo.handle.left + 1, y + 3, geo.handle.right - geo.handle.left - 2, height - 6, 4);
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
  ctx.beginPath();
  ctx.roundRect(boxLeft, top, box, box, 4);
  ctx.fillStyle = on ? "#3f8f4a" : "rgba(120,120,120,0.16)";
  ctx.strokeStyle = on ? "#7ee08a" : "rgba(105,105,105,0.9)";
  ctx.fill();
  ctx.stroke();
  if (on) {
    ctx.beginPath();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.moveTo(boxLeft + box * 0.24, top + box * 0.52);
    ctx.lineTo(boxLeft + box * 0.44, top + box * 0.74);
    ctx.lineTo(boxLeft + box * 0.78, top + box * 0.26);
    ctx.stroke();
  }
  ctx.restore();
  return true;
}

registerRowLayout(TARGET_CLASS, {
  minWidth: 460,
  // 高度永远贴合内容行：不接收用户拖出来的额外高度，也不随工作流持久化。
  // 与 GG LoRA组加载 同一套根治「内容行数没变却留一大片空白」的机制
  // （引擎层 lockHeightToContent，每帧 applyHeight 吃掉外部残留高度）。
  lockHeightToContent: true,
  drawColumn: drawEnableCell,
  // 启用列拆成两个独立胶囊后，不能再使用 9% 的窄列；强度列也保留可读宽度。
  // 这组权重与 GG LoRA组加载 对齐：启用列可放下手柄/间隔/开关，强度值 1.00
  // 在默认最小宽度下完整显示，名称列仍占主要空间。
  pack: false,
  weights: { 3: [18, 73, 9], 2: [14, 86] },
  // 「新增LoRA」按钮按内容宽贴紧（通栏 620px 只有 60px 文字，中间全是死空白），
  // 再按节点宽度居中，不再靠左悬着。
  compactSingle(widget) {
    return String(widget?.type ?? "") === "button";
  },
  centerSingle(widget) {
    return String(widget?.type ?? "") === "button";
  },
  rows(node) {
    const count = Math.min(MAX_LORAS, Math.max(0, Number(getWidget(node, COUNT_WIDGET_NAME)?.value) || 0));
    const rows = [];
    for (let index = 1; index <= count; index += 1) {
      const enable = getWidget(node, `LoRA${index}${ENABLE_SUFFIX}`);
      const name = getWidget(node, `LoRA${index}名称`);
      const strength = getWidget(node, `LoRA${index}强度`);
      // 列里空间只够放值：控件标签会跟值挤在一行（"LoRA1强度 … 1.00"），
      // 同一行已经有勾选框和下拉，位置本身就能说明是哪个参数，标签留空更清爽。
      // displayName 是 `label || name` 的兜底，写空字符串会被 name 顶回来，所以给一个空格。
      for (const widget of [name, strength]) {
        if (widget && widget.label !== " ") {
          widget.label = " ";
        }
      }
      const row = [enable, name, strength].filter(Boolean);
      if (row.length) {
        rows.push(row);
      }
    }
    const addButton = getWidget(node, ADD_BUTTON_NAME);
    if (addButton) {
      rows.push([addButton]);
    }
    return rows;
  },
});

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget?.name === name) ?? null;
}

function getPair(node, index) {
    return {
        enable: getWidget(node, `LoRA${index}${ENABLE_SUFFIX}`),
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
    // 显示时必须先恢复 type:前端在当前 type 属于隐藏类型时会丢弃 hidden 写入。
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
            || /^LoRA\d+(名称|强度|启用)$/.test(widget.name)
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

function refreshNode(node) {
    cleanupHiddenSlots(node);

    if (typeof node.computeSize === "function") {
        const [width, height] = node.computeSize();
        const nextWidth = Math.max(Number(node.size?.[0]) || 0, width);
        const nextHeight = height;
        if (typeof node.setSize === "function") {
            node.setSize([nextWidth, nextHeight]);
        } else if (node.size?.length === 2) {
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
        const { enable, name, strength } = getPair(node, index);
        const show = index <= visibleCount;
        toggleWidget(node, enable, show);
        toggleWidget(node, name, show);
        toggleWidget(node, strength, show);
    }

    // 先同步一帧内布局，再在 rAF 里收一次，覆盖其他扩展的延后 fit。
    refreshNode(node);
    refreshRowLayout(node);
    requestAnimationFrame(() => {
        refreshNode(node);
        refreshRowLayout(node);
    });
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
    // 按钮本身不需要存档：它排在启用开关前面，一旦写进 widgets_values 就会把后面的
    // 开关整体顶掉一位（老工作流里 LoRA1启用 变成 "新增LoRA" 就是这么来的）。
    button.serialize = false;
    node._ggAddButtonInstalled = true;
}

// ------------------------------------------------------------------
// 强度编辑 + 拖拽重排：统一走一套捕获阶段的全局 pointer 事件。
//
// 为什么不挂 widget.onClick：
//   · 引擎的 patchPointerHandlers 已经包装过 onClick（临时右移 node.pos 把坐标
//     换成列内坐标），再包一层容易把换算弄丢；
//   · 强度列形状只有 ~37px，官方 number 控件把整格都判成「右侧 40px 增量区」，
//     点了只会 ±0.01 或干脆没反应，弹不出输入框。
// 自己在捕获阶段命中形状区并 stopImmediatePropagation，命中区与 drawSkinned /
// getWidgetOnPos 用的是同一套内缩区间，绘制和交互不会再对不上。
// ------------------------------------------------------------------

function clampStrength(widget, value) {
  const min = Number(widget?.options?.min);
  const max = Number(widget?.options?.max);
  const safeMin = Number.isFinite(min) ? min : -10;
  const safeMax = Number.isFinite(max) ? max : 10;
  return Math.min(safeMax, Math.max(safeMin, value));
}

function setStrength(node, widget, value) {
  const next = clampStrength(widget, Number(value));
  if (!Number.isFinite(next)) {
    return;
  }
  widget.value = next;
  widget.callback?.(next);
  node.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
}

function promptStrength(node, widget, event) {
  const done = (text) => {
    const parsed = Number(String(text ?? "").trim());
    if (Number.isFinite(parsed)) {
      setStrength(node, widget, parsed);
    }
  };
  if (typeof app.canvas?.prompt === "function") {
    // LiteGraph / ComfyUI 官方的数值输入浮层，风格与画布一致。
    app.canvas.prompt("强度", String(widget.value), done, event);
  } else {
    const text = globalThis.prompt?.("强度", String(widget.value));
    if (text != null) {
      done(text);
    }
  }
}

function reorderLoras(node, from, to) {
  const rows = loraRows(node);
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) {
    return false;
  }
  // 只搬值、不搬控件对象：LoRA1/2/3… 的控件名和 widgets_values 槽位保持不变，
  // 存档读回来天然就是用户排好的顺序，不需要额外的持久化字段。
  const snapshots = rows.map((row) => ({
    enable: findInRow(row, ENABLE_SUFFIX)?.value,
    name: findInRow(row, NAME_SUFFIX)?.value,
    strength: findInRow(row, STRENGTH_SUFFIX)?.value,
  }));
  const [moved] = snapshots.splice(from, 1);
  snapshots.splice(to, 0, moved);
  snapshots.forEach((snap, index) => {
    const enable = findInRow(rows[index], ENABLE_SUFFIX);
    const name = findInRow(rows[index], NAME_SUFFIX);
    const strength = findInRow(rows[index], STRENGTH_SUFFIX);
    if (enable && snap.enable !== undefined) enable.value = snap.enable;
    if (name && snap.name !== undefined) name.value = snap.name;
    if (strength && snap.strength !== undefined) strength.value = snap.strength;
  });
  // 刻意不调 name.callback：值为 "None" 时会触发 compactSlots 把空槽压到末尾，
  // 把用户刚排好的顺序又打乱。值已经写进控件，序列化时会带走。
  refreshNode(node);
  refreshRowLayout(node);
  return true;
}

function eventToGraph(event) {
  const canvas = app.canvas;
  if (typeof canvas?.convertEventToCanvasOffset !== "function") {
    return null;
  }
  const pos = canvas.convertEventToCanvasOffset(event);
  return Array.isArray(pos) && pos.length >= 2 ? pos : null;
}

function locatePointer(event) {
  const pos = eventToGraph(event);
  if (!pos) {
    return null;
  }
  for (const node of app.graph?._nodes ?? []) {
    if (node?.comfyClass !== TARGET_CLASS || !node.pos) {
      continue;
    }
    const lx = pos[0] - node.pos[0];
    const ly = pos[1] - node.pos[1];
    const rows = loraRows(node);
    for (let index = 0; index < rows.length; index += 1) {
      const enable = findInRow(rows[index], ENABLE_SUFFIX);
      const strength = findInRow(rows[index], STRENGTH_SUFFIX);
      if (inRect(lx, ly, handleRect(enable))) {
        return { kind: "drag", node, rows, index };
      }
      if (inRect(lx, ly, shapeRect(strength))) {
        return { kind: "strength", node, widget: strength, rect: shapeRect(strength) };
      }
    }
  }
  return null;
}

function markDirty(node) {
  node?.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function onPointerDown(event) {
  if (event.button !== 0) {
    return;
  }
  const hit = locatePointer(event);
  if (!hit) {
    return;
  }
  // 拦在官方 canvas 处理之前：否则节点会被顺手拖走、强度格会走官方增量逻辑。
  event.stopImmediatePropagation();
  event.preventDefault();
  if (hit.kind === "drag") {
    pointerState.drag = { node: hit.node, from: hit.index, to: hit.index, rows: hit.rows };
  } else {
    pointerState.press = { node: hit.node, widget: hit.widget, rect: hit.rect };
  }
  markDirty(hit.node);
}

function onPointerMove(event) {
  const drag = pointerState.drag;
  if (!drag) {
    return;
  }
  const pos = eventToGraph(event);
  if (!pos) {
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
  const next = Math.max(0, Math.min(drag.rows.length - 1, target));
  if (next !== drag.to) {
    drag.to = next;
    markDirty(drag.node);
  }
  event.preventDefault();
}

function onPointerUp(event) {
  const drag = pointerState.drag;
  const press = pointerState.press;
  if (!drag && !press) {
    return;
  }
  event.stopImmediatePropagation();
  event.preventDefault();

  if (drag) {
    if (drag.from !== drag.to) {
      reorderLoras(drag.node, drag.from, drag.to);
    }
    pointerState.drag = null;
    markDirty(drag.node);
    return;
  }

  pointerState.press = null;
  const { node, widget, rect } = press;
  const pos = eventToGraph(event);
  const lx = pos ? pos[0] - node.pos[0] : (rect.left + rect.right) / 2;
  const ratio = Math.max(0, Math.min(1, (lx - rect.left) / Math.max(1, rect.right - rect.left)));
  const step = Number(widget?.options?.step) || STRENGTH_STEP;
  if (ratio < 0.25) {
    setStrength(node, widget, Number(widget.value) - step);
  } else if (ratio > 0.75) {
    setStrength(node, widget, Number(widget.value) + step);
  } else {
    promptStrength(node, widget, event);
  }
  markDirty(node);
}

function installPointerHandlers() {
  const canvas = app.canvas?.canvas;
  if (!canvas || canvas._ggLoraPointerInstalled) {
    return;
  }
  canvas._ggLoraPointerInstalled = true;
  canvas.addEventListener("pointerdown", onPointerDown, true);
  // move/up 挂 window：指针拖出画布外也要能结算，别把节点卡在拖拽态。
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
}

function installStrengthPrecision(node) {
  for (let index = 1; index <= MAX_LORAS; index += 1) {
    const { strength } = getPair(node, index);
    if (!strength) {
      continue;
    }
    if (!strength.options || typeof strength.options !== "object") {
      strength.options = {};
    }
    // 紧凑数值格按 precision 决定小数位：强度显示 1.00 而不是 1。
    if (!Number.isFinite(Number(strength.options.precision))) {
      strength.options.precision = 2;
    }
  }
}

function syncInitialState(node) {
    if (node._ggLoraInitialSyncDone) {
        return;
    }

    node._ggLoraInitialSyncDone = true;

    // 老工作流的 widgets_values 里，「新增LoRA」按钮的值排在启用开关前面，
    // 加载后会被塞进 LoRA1启用（值变成 "新增LoRA"）。这里统一修回布尔值。
    for (let index = 1; index <= MAX_LORAS; index += 1) {
        const { enable } = getPair(node, index);
        if (enable && typeof enable.value !== "boolean") {
            enable.value = true;
        }
    }

    const activeCount = Array.from({ length: MAX_LORAS }, (_, offset) => offset + 1).filter((index) => {
        const { name } = getPair(node, index);
        return (name?.value ?? "None") !== "None";
    }).length;

    // 至少留一行：刚拖出来的节点只有一个「新增」按钮会显得像坏了。
    // 只在 0 行时补，不能强制等于 activeCount——否则存了 3 行还没选文件的布局会被压成 0 行。
    if (getVisibleCount(node) < 1) {
        setVisibleCount(node, 1);
    } else if (activeCount > getVisibleCount(node)) {
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
    toggleWidget(node, countWidget, false);
    installSlotCallbacks(node);
    installAddButton(node);
    installStrengthPrecision(node);
    installPointerHandlers();
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
