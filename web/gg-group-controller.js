import { app } from "../../scripts/app.js";

const NODE_NAME_M = "GGGroupControllerM";
const NODE_NAME_S = "GGGroupControllerS";
const ENABLE_WIDGET = "启用";
const ENABLE_HIDDEN_TYPE = "ggHiddenGroupEnable";
const SELECTED_GROUPS_PROPERTY = "selectedGroups";
const GROUP_SLOT_TITLES_PROPERTY = "groupSlotTitles";
const SELECT_PANEL_ID = "ggGroupSelectPanel";
const LEGACY_SELECTION_FLAG = "_ggLegacyGroupSelection";

const SKIP_ALL_INPUT = "全部跳过";
const ENABLE_ALL_INPUT = "全部启用";
const ROW_INPUT_PREFIX = "组启用";
const ROW_INPUT_LABEL = " ";
const ROW_WIDGET_TAG = "__ggGroupRowWidget";
const HEADER_BTN_GAP = 6;

const PAD_X        = 10;
const PAD_Y        = 8;
const HEADER_H     = 38;
const ROW_H        = 32;
const ROW_GAP      = 3;
const BTN_W        = 72;
const BTN_H        = 22;
const MIN_W        = 270;
const DROPDOWN_H   = 28;
const SINGLE_H     = PAD_Y + DROPDOWN_H + 6 + ROW_H + PAD_Y;
const ENABLE_ROW_Y = PAD_Y + DROPDOWN_H + 6 + ROW_H / 2;
const RECOMPUTE_INTERVAL = 300;

function drawRoundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function truncateText(ctx, text, maxWidth) {
  if (!text) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + "…").width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + "…";
}


const DISABLED_MODE = 2;
const BYPASS_MODE = 4;
const ACTIVE_MODE = 0;

function isSkippedMode(mode) {
  return mode === DISABLED_MODE || mode === BYPASS_MODE;
}

function getActiveGraph() {
  return app.canvas?.getCurrentGraph?.() ?? app.graph;
}

function getAllGroups() {
  const graph = getActiveGraph();
  if (!graph) return [];
  const groups = [...(graph._groups ?? [])];
  const subgraphs = graph.subgraphs?.values?.();
  if (subgraphs) {
    for (const sg of subgraphs) {
      if (sg?.groups) groups.push(...sg.groups);
    }
  }
  return groups;
}

function recomputeGroupNodes(group) {
  const graph = group.graph ?? app.graph;
  if (!graph) return;
  const grpBounds = group._bounding;
  if (!grpBounds) return;
  const [gx, gy, gw, gh] = grpBounds;
  const allNodes = graph.nodes ?? graph._nodes ?? [];

  if (group._children instanceof Set) {
    group._children.clear();
    if (!Array.isArray(group.nodes)) group.nodes = [];
    group.nodes.length = 0;
    for (const node of allNodes) {
      let bounds;
      try { bounds = node.getBounding?.(); } catch (_) { continue; }
      if (!bounds) continue;
      const cx = bounds[0] + bounds[2] * 0.5;
      const cy = bounds[1] + bounds[3] * 0.5;
      if (cx >= gx && cx < gx + gw && cy >= gy && cy < gy + gh) {
        group._children.add(node);
        group.nodes.push(node);
      }
    }
    return;
  }
  try { group.recomputeInsideNodes?.(); } catch (_) {}
}

function getGroupNodes(group) {
  if (group._children instanceof Set) {
    return Array.from(group._children).filter(
      (c) => c != null && typeof c === "object" && "mode" in c
    );
  }
  return group.nodes ?? group._nodes ?? [];
}

function setGroupBypass(group, bypass) {
  const nodes = getGroupNodes(group);
  for (const node of nodes) {
    // 与官方及 rgthree Fast Groups Bypasser 一致：跳过用 Bypass(mode=4)，
    // 启用回到 ALWAYS(mode=0)。不再用 Never/静音(mode=2)。
    node.mode = bypass ? BYPASS_MODE : ACTIVE_MODE;
  }
  (group.graph ?? app.graph)?.setDirtyCanvas?.(true, false);
}

function groupTitle(group) {
  return group?.title ?? "";
}

function selectedTitles(node) {
  const titles = node.properties?.[SELECTED_GROUPS_PROPERTY];
  return Array.isArray(titles) ? titles : [];
}

function setSelectedTitles(node, titles) {
  if (!node.properties) node.properties = {};
  node.properties[SELECTED_GROUPS_PROPERTY] = [...new Set(titles)];
  node._lastRecomputeMs = 0;
  // 不依赖下一帧绘制：选择变化后立即同步行接入点（Vue 渲染下没有 draw 回调）。
  if (node._gbcM) syncControlInputs(node, controlGroups(node));
  node.setDirtyCanvas?.(true, true);
  (getActiveGraph() ?? app.graph)?.setDirtyCanvas?.(true, false);
}

function toggleSelectedTitle(node, title) {
  const titles = new Set(selectedTitles(node));
  titles.has(title) ? titles.delete(title) : titles.add(title);
  setSelectedTitles(node, titles);
}

// 当前节点真正控制的编组：只包含用户在「选择组」里勾选过的组。
function controlGroups(node) {
  const titles = new Set(selectedTitles(node));
  if (!titles.size) return [];
  return getAllGroups().filter((group) => titles.has(groupTitle(group)));
}

function applyToControlled(node, bypass) {
  node._lastRecomputeMs = 0;
  const groups = controlGroups(node);
  for (const group of groups) recomputeGroupNodes(group);
  for (const group of groups) setGroupBypass(group, bypass);
  (getActiveGraph() ?? app.graph)?.setDirtyCanvas?.(true, false);
}

function rowInputName(index) {
  return ROW_INPUT_PREFIX + (index + 1);
}

function isRowInput(input) {
  return /^组启用\d+$/.test(input?.name ?? "");
}

function findInputIndex(node, name) {
  return node.inputs?.findIndex((input) => input?.name === name) ?? -1;
}

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget?.name === name) ?? null;
}

function inputLink(node, slot) {
  const link = node.getInputLink?.(slot);
  if (link) return link;
  const id = node.inputs?.[slot]?.link;
  return id == null ? null : (node.graph?.links?.[id] ?? null);
}

function setInputPos(node, name, x, y) {
  const input = node.inputs?.find((slot) => slot?.name === name);
  if (!input) return;
  if (!input.pos || input.pos[0] !== x || input.pos[1] !== y) input.pos = [x, y];
}

// 隐藏的 toggle 控件只是 GG 选项确认的接入点：值仍由自定义按钮/编组状态展示。
function createHiddenToggle(node, name, label, value, callback, tag) {
  const widget = node.addWidget?.("toggle", name, value, callback, {});
  if (!widget) return null;
  widget.label = label;
  widget.serialize = false;
  if (widget.options) widget.options.serialize = false;
  widget[tag] = true;
  widget.hidden = true;
  return widget;
}

function ensureControlInput(node, name) {
  if (findInputIndex(node, name) < 0) {
    node.addInput?.(name, "BOOLEAN", { label: ROW_INPUT_LABEL });
  }
}

function ensureHeaderControls(node) {
  if (!findWidget(node, SKIP_ALL_INPUT)) {
    createHiddenToggle(node, SKIP_ALL_INPUT, SKIP_ALL_INPUT, false, () => {
      if (findWidget(node, SKIP_ALL_INPUT)?.value) applyToControlled(node, true);
    }, "__ggGroupHeader");
  }
  if (!findWidget(node, ENABLE_ALL_INPUT)) {
    createHiddenToggle(node, ENABLE_ALL_INPUT, ENABLE_ALL_INPUT, false, () => {
      if (findWidget(node, ENABLE_ALL_INPUT)?.value) applyToControlled(node, false);
    }, "__ggGroupHeader");
  }
  ensureControlInput(node, SKIP_ALL_INPUT);
  ensureControlInput(node, ENABLE_ALL_INPUT);
}

function syncRowWidgets(node, titles) {
  const desired = titles.map((_, index) => rowInputName(index));
  const widgets = (node.widgets ?? []).filter((widget) => widget?.[ROW_WIDGET_TAG]);
  // 名称永远是「组启用N」，只看名称会漏掉选择变化后行与编组的错位。
  const matched = widgets.length === desired.length
    && widgets.every((widget, index) => (
      widget.name === desired[index] && widget.__ggGroupTitle === titles[index]
    ));

  if (matched) {
    widgets.forEach((widget, index) => {
      widget.label = titles[index] || "未命名编组";
    });
    return;
  }

  for (const widget of widgets) {
    if (typeof node.removeWidget === "function") {
      node.removeWidget(widget);
    } else {
      const index = node.widgets.indexOf(widget);
      if (index >= 0) node.widgets.splice(index, 1);
    }
  }

  titles.forEach((title, index) => {
    const group = getAllGroups().find((candidate) => groupTitle(candidate) === title);
    const nodes = group ? getGroupNodes(group) : [];
    const bypassed = nodes.length > 0 && nodes.every((item) => isSkippedMode(item.mode));
    const widget = createHiddenToggle(node, rowInputName(index), title || "未命名编组", !bypassed, () => {
      const current = findWidget(node, rowInputName(index));
      const target = getAllGroups().find((candidate) => groupTitle(candidate) === title);
      if (!current || !target) return;
      recomputeGroupNodes(target);
      setGroupBypass(target, !current.value);
      node._lastRecomputeMs = 0;
      node.setDirtyCanvas?.(true, true);
    }, ROW_WIDGET_TAG);
    if (widget) widget.__ggGroupTitle = title;
  });
}

// 选中组变化时重建行输入：先按标题记下连线，重建后按标题接回，
// 避免删除中间一行后原有连线错位到别的编组。
function rebuildRowInputs(node, current, desired) {
  const links = new Map();
  current.forEach((title, index) => {
    const slot = findInputIndex(node, rowInputName(index));
    if (slot < 0 || links.has(title)) return;
    const link = inputLink(node, slot);
    if (link) links.set(title, { originId: link.origin_id, originSlot: link.origin_slot });
  });

  for (let index = (node.inputs?.length ?? 0) - 1; index >= 0; index -= 1) {
    if (isRowInput(node.inputs[index])) node.removeInput?.(index);
  }
  node.properties[GROUP_SLOT_TITLES_PROPERTY] = [...desired];

  desired.forEach((_, index) => {
    node.addInput?.(rowInputName(index), "BOOLEAN", { label: ROW_INPUT_LABEL });
  });

  for (const [title, source] of links) {
    const row = desired.indexOf(title);
    const targetSlot = row < 0 ? -1 : findInputIndex(node, rowInputName(row));
    const sourceNode = node.graph?.getNodeById?.(source.originId) ?? null;
    if (targetSlot < 0 || !sourceNode?.connect) continue;
    sourceNode.connect(source.originSlot, node, targetSlot);
  }
}

function positionControlInputs(node, rowCount) {
  const W = node.size?.[0] ?? MIN_W;
  const btnW = (W - PAD_X * 2 - HEADER_BTN_GAP * 2) / 3;
  const headerY = PAD_Y + (HEADER_H - 6) / 2;
  setInputPos(node, SKIP_ALL_INPUT, PAD_X + 11, headerY);
  setInputPos(node, ENABLE_ALL_INPUT, PAD_X + btnW + HEADER_BTN_GAP + 11, headerY);

  const rowX = W - PAD_X - BTN_W - 4 + 10;
  for (let index = 0; index < rowCount; index += 1) {
    setInputPos(
      node,
      rowInputName(index),
      rowX,
      PAD_Y + HEADER_H + index * (ROW_H + ROW_GAP) + ROW_H / 2
    );
  }
}

function syncControlInputs(node, groups) {
  const desired = groups.map(groupTitle);
  const current = [...(node.properties?.[GROUP_SLOT_TITLES_PROPERTY] ?? [])];
  const rowInputs = (node.inputs ?? []).filter(isRowInput);
  const matched = current.length === desired.length
    && rowInputs.length === desired.length
    && desired.every((title, index) => current[index] === title)
    && desired.every((_, index) => findInputIndex(node, rowInputName(index)) >= 0);

  // 先建隐藏控件再重建输入：重连时 GG 选项确认要靠这些控件识别目标类型。
  syncRowWidgets(node, desired);
  if (!matched) rebuildRowInputs(node, current, desired);
  positionControlInputs(node, desired.length);
}

function selectedGroup(node) {
  const title = node.properties?.selectedGroup ?? "";
  return getAllGroups().find((group) => (group.title ?? "") === title) ?? null;
}

function enableWidget(node) {
  return node.widgets?.find((widget) => widget.name === ENABLE_WIDGET) ?? null;
}

function applyEnableFromWidget(node) {
  const widget = enableWidget(node);
  const group = selectedGroup(node);
  if (!widget || !group) return;
  recomputeGroupNodes(group);
  setGroupBypass(group, !widget.value);
  node._lastRecomputeMs = 0;
}

// 后端「启用」控件只作为 GG 选项确认的接入点：隐藏原生控件，
// 但保留输入端口并固定到启停按钮所在行，状态仍由自定义按钮展示。
function syncEnableWidget(node) {
  const widget = enableWidget(node);
  if (!widget) return null;

  if (!widget._ggGroupEnableHidden) {
    widget._ggGroupEnableHidden = true;
    widget.hidden = true;
    widget.type = ENABLE_HIDDEN_TYPE;
    widget.computeSize = () => [0, -4];
  }

  if (!widget._ggGroupEnableBound) {
    widget._ggGroupEnableBound = true;
    const original = widget.callback;
    widget.callback = function (...args) {
      const result = original?.apply(this, args);
      applyEnableFromWidget(node);
      return result;
    };
  }

  const radius = (globalThis.LiteGraph?.NODE_SLOT_HEIGHT ?? 20) / 2;
  widget.y = ENABLE_ROW_Y - radius;

  const input = node.inputs?.find((slot) => slot.widget?.name === ENABLE_WIDGET);
  if (input) {
    input.alwaysVisible = true;
    if (!input.pos || input.pos[0] !== radius || input.pos[1] !== ENABLE_ROW_Y) {
      input.pos = [radius, ENABLE_ROW_Y];
    }
  }

  return widget;
}

function navigateToGroup(group) {
  const canvas = app.canvas;
  if (!canvas || !group?._bounding) return;
  const [gx, gy, gw, gh] = group._bounding;
  const cx = gx + gw / 2;
  const cy = gy + gh / 2;
  const ds = canvas.ds;
  if (ds) {
    const scale = ds.scale || 1;
    const cW = canvas.canvas?.clientWidth  ?? canvas.canvas?.width  ?? 800;
    const cH = canvas.canvas?.clientHeight ?? canvas.canvas?.height ?? 600;
    ds.offset[0] = cW / 2 / scale - cx;
    ds.offset[1] = cH / 2 / scale - cy;
  }
  (typeof canvas.setDirty === "function")
    ? canvas.setDirty(true, true)
    : canvas.setDirtyCanvas?.(true, true);
}

function computeHeightM(groupCount) {
  return PAD_Y + HEADER_H + ROW_GAP
       + Math.max(1, groupCount) * (ROW_H + ROW_GAP)
       + PAD_Y;
}

function ensureStateM(node) {
  if (!node.properties) node.properties = {};
  if (!Array.isArray(node.properties[SELECTED_GROUPS_PROPERTY])) {
    node.properties[SELECTED_GROUPS_PROPERTY] = [];
  }
  if (!Array.isArray(node.properties[GROUP_SLOT_TITLES_PROPERTY])) {
    node.properties[GROUP_SLOT_TITLES_PROPERTY] = [];
  }
  if (!node._gbcM) {
    node._gbcM            = true;
    node._hitRows         = [];
    node._hitHeaderBtns   = [];
    node._lastRecomputeMs = 0;
    node.serialize_widgets = false;
    node.isVirtualNode    = true;
    node.size             = [MIN_W, computeHeightM(0)];
  }
  // 顶部两个按钮的接入点常驻，行接入点随所选编组同步。
  ensureHeaderControls(node);
}

function drawMultiNode(node, ctx) {
  if (node.flags?.collapsed) return;

  const now = Date.now();
  if (now - node._lastRecomputeMs >= RECOMPUTE_INTERVAL) {
    node._lastRecomputeMs = now;
    for (const g of getAllGroups()) recomputeGroupNodes(g);
  }

  const allGroups = getAllGroups();
  const groups    = controlGroups(node);
  syncControlInputs(node, groups);
  const W         = node.size[0];
  const neededH   = computeHeightM(groups.length);
  if (Math.abs(node.size[1] - neededH) > 1) node.size[1] = neededH;

  node._hitRows       = [];
  node._hitHeaderBtns = [];

  let y = PAD_Y;

  const gap  = HEADER_BTN_GAP;
  const btnW = (W - PAD_X * 2 - gap * 2) / 3;
  const btnH = HEADER_H - 6;
  _drawHeaderBtn(node, ctx, PAD_X, y, btnW, btnH, "全部跳过", "#7a1515", "bypass_all", groups.length > 0);
  _drawHeaderBtn(node, ctx, PAD_X + btnW + gap, y, btnW, btnH, "全部启用", "#155c30", "enable_all", groups.length > 0);
  _drawHeaderBtn(node, ctx, PAD_X + (btnW + gap) * 2, y, btnW, btnH, "选择组", "#2f4a63", "select_groups");
  y += HEADER_H;

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_X, y - 4);
  ctx.lineTo(W - PAD_X, y - 4);
  ctx.stroke();
  ctx.restore();

  if (!allGroups.length || !groups.length) {
    ctx.save();
    ctx.fillStyle    = "#666";
    ctx.font         = "italic 12px sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      allGroups.length ? "点击「选择组」勾选要控制的编组" : "工作流中没有编组",
      W / 2,
      y + ROW_H / 2 + 4
    );
    ctx.restore();
    return;
  }

  for (let index = 0; index < groups.length; index += 1) {
    const group    = groups[index];
    const nodes    = getGroupNodes(group);
    const bypassed = nodes.length > 0 && nodes.every((n) => isSkippedMode(n.mode));
    const mixed    = !bypassed && nodes.some((n) => isSkippedMode(n.mode));
    const widget   = findWidget(node, rowInputName(index));
    if (widget && widget.value !== !bypassed) widget.value = !bypassed;
    node._hitRows.push({ group, y, bypassed, mixed });
    _drawGroupRow(ctx, group, y, bypassed, mixed, nodes.length, W);
    y += ROW_H + ROW_GAP;
  }
}

function _drawHeaderBtn(node, ctx, x, y, w, h, label, color, action, enabled = true) {
  node._hitHeaderBtns.push({ x, y, w, h, action, enabled });
  ctx.save();
  ctx.globalAlpha = enabled ? 1 : 0.4;
  ctx.fillStyle = color;
  ctx.beginPath();
  drawRoundRect(ctx, x, y, w, h, 5);
  ctx.fill();
  ctx.fillStyle    = "rgba(255,255,255,0.88)";
  ctx.font         = "bold 12px sans-serif";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.restore();
}

function _drawGroupRow(ctx, group, y, bypassed, mixed, nodeCount, W) {
  ctx.save();
  ctx.fillStyle = bypassed ? "rgba(122,21,21,0.18)" : "rgba(255,255,255,0.04)";
  ctx.beginPath();
  drawRoundRect(ctx, PAD_X, y + 1, W - PAD_X * 2, ROW_H - 2, 4);
  ctx.fill();

  let textStartX = PAD_X + 8;
  if (group.color) {
    ctx.fillStyle = group.color;
    ctx.beginPath();
    drawRoundRect(ctx, PAD_X + 5, y + (ROW_H - 16) / 2, 6, 16, 3);
    ctx.fill();
    textStartX += 14;
  }

  const btnX = W - PAD_X - BTN_W - 4;
  const btnY = y + (ROW_H - BTN_H) / 2;

  ctx.fillStyle = bypassed ? "#7a1515" : (mixed ? "#7a4c15" : "#155c30");
  ctx.beginPath();
  drawRoundRect(ctx, btnX, btnY, BTN_W, BTN_H, 11);
  ctx.fill();

  ctx.fillStyle    = "rgba(255,255,255,0.9)";
  ctx.font         = "bold 10px sans-serif";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    bypassed ? "已跳过" : (mixed ? "部分跳过" : "已启用"),
    btnX + BTN_W / 2, btnY + BTN_H / 2
  );

  const cntX = btnX - 28;
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.beginPath();
  drawRoundRect(ctx, cntX, btnY, 24, BTN_H, 4);
  ctx.fill();
  ctx.fillStyle    = "#999";
  ctx.font         = "10px sans-serif";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(nodeCount), cntX + 12, btnY + BTN_H / 2);

  const maxTitleW = cntX - textStartX - 6;
  ctx.fillStyle    = bypassed ? "#777" : "#ddd";
  ctx.font         = "13px sans-serif";
  ctx.textAlign    = "left";
  ctx.textBaseline = "middle";
  const title = truncateText(ctx, group.title || "未命名编组", maxTitleW);
  ctx.fillText(title, textStartX, y + ROW_H / 2);

  if (bypassed) {
    const tw = ctx.measureText(title).width;
    ctx.strokeStyle = "#666";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(textStartX, y + ROW_H / 2);
    ctx.lineTo(textStartX + tw, y + ROW_H / 2);
    ctx.stroke();
  }
  ctx.restore();
}

let selectPanelKeyHandler = null;
let selectPanelOutsideHandler = null;

function closeGroupSelectPanel() {
  document.getElementById(SELECT_PANEL_ID)?.remove();
  if (selectPanelKeyHandler) {
    document.removeEventListener("keydown", selectPanelKeyHandler, true);
    selectPanelKeyHandler = null;
  }
  if (selectPanelOutsideHandler) {
    document.removeEventListener("pointerdown", selectPanelOutsideHandler, true);
    selectPanelOutsideHandler = null;
  }
}

function selectButtonRect(node) {
  const W   = node.size?.[0] ?? MIN_W;
  const gap = 6;
  const w   = (W - PAD_X * 2 - gap * 2) / 3;
  return { x: PAD_X + (w + gap) * 2, y: PAD_Y, w, h: HEADER_H - 6 };
}

function canvasScreenPoint(node, localX, localY) {
  const canvas  = app.canvas;
  const element = canvas?.canvasEl ?? canvas?.canvas;
  const rect    = element?.getBoundingClientRect?.();
  const ds      = canvas?.ds;
  if (!rect || !ds) return null;
  const scale = ds.scale || 1;
  return {
    x: rect.left + ((node.pos?.[0] ?? 0) + localX + (ds.offset?.[0] ?? 0)) * scale,
    y: rect.top + ((node.pos?.[1] ?? 0) + localY + (ds.offset?.[1] ?? 0)) * scale,
  };
}

// 贴着点击位置弹出下拉面板，不做全屏遮罩，避免挡住画布。
function positionGroupSelectPanel(node, panel, anchor, origin) {
  const margin = 8;
  const box    = panel.getBoundingClientRect?.() ?? { width: 300, height: 320 };
  const point  = Number.isFinite(origin?.x) && Number.isFinite(origin?.y)
    ? origin
    : canvasScreenPoint(node, anchor.x, anchor.y + anchor.h);
  let left = point ? point.x : margin;
  let top  = point ? point.y + 8 : margin;
  left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));
  if (top + box.height > window.innerHeight - margin) {
    top = Math.max(margin, top - box.height - 16);
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function panelButton(label, onClick, primary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = [
    "padding:6px 12px",
    "border:1px solid " + (primary ? "#5e7f4e" : "#444"),
    "border-radius:6px",
    "background:" + (primary ? "#4f6f45" : "#2e2e2e"),
    "color:" + (primary ? "#fff" : "#ccc"),
    "font:12px sans-serif",
    "cursor:pointer",
  ].join(";");
  button.addEventListener("click", onClick);
  return button;
}

// 与 ComfyUI 选项列表一致的卡片样式：左侧圆圈勾选，选中项整张卡片高亮。
function groupSelectCard(node, group, rerender) {
  const title = groupTitle(group);
  const selected = selectedTitles(node).includes(title);

  const card = document.createElement("button");
  card.type = "button";
  card.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:10px",
    "width:100%",
    "padding:8px 10px",
    "border:1px solid " + (selected ? "#6d8f5e" : "#3a3a3a"),
    "border-radius:8px",
    "background:" + (selected ? "rgba(111,143,86,0.20)" : "#262626"),
    "color:" + (selected ? "#e8f0e2" : "#d5d5d5"),
    "font:13px/1.35 sans-serif",
    "text-align:left",
    "cursor:pointer",
  ].join(";");

  const dot = document.createElement("span");
  dot.style.cssText = [
    "flex:0 0 auto",
    "width:18px",
    "height:18px",
    "border-radius:50%",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "font-size:11px",
    "font-weight:700",
  ].join(";");
  if (selected) {
    dot.style.background = "#61854f";
    dot.style.color = "#fff";
    dot.textContent = "✓";
  } else {
    dot.style.border = "2px solid #5a5a5a";
    dot.style.boxSizing = "border-box";
  }

  const label = document.createElement("span");
  label.style.cssText = "flex:1;word-break:break-all;";
  label.textContent = title || "未命名编组";

  card.append(dot, label);
  card.addEventListener("mouseenter", () => {
    if (!selected) card.style.borderColor = "#5a5a5a";
  });
  card.addEventListener("mouseleave", () => {
    if (!selected) card.style.borderColor = "#3a3a3a";
  });
  card.addEventListener("click", () => {
    toggleSelectedTitle(node, title);
    rerender();
  });
  return card;
}

function openGroupSelectPanel(node, anchor = selectButtonRect(node), origin = null) {
  closeGroupSelectPanel();

  const panel = document.createElement("div");
  panel.id = SELECT_PANEL_ID;
  panel.style.cssText = [
    "position:fixed",
    "left:8px",
    "top:8px",
    "visibility:hidden",
    "z-index:12000",
    "display:flex",
    "flex-direction:column",
    "width:300px",
    "max-width:calc(100vw - 16px)",
    "max-height:60vh",
    "background:#232323",
    "border:1px solid #3d3d3d",
    "border-radius:8px",
    "box-shadow:0 12px 40px rgba(0,0,0,0.55)",
    "overflow:hidden",
    "color:#ddd",
    "font:13px sans-serif",
  ].join(";");

  const header = document.createElement("div");
  header.textContent = "选择要控制的编组";
  header.style.cssText = "padding:10px 12px;font-size:13px;font-weight:600;border-bottom:1px solid #383838;";

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:8px 10px;overflow-y:auto;";

  const footer = document.createElement("div");
  footer.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid #383838;";

  const render = () => {
    const groups = getAllGroups();
    list.replaceChildren();
    if (!groups.length) {
      const empty = document.createElement("div");
      empty.textContent = "工作流中没有编组";
      empty.style.cssText = "padding:16px 4px;color:#777;text-align:center;";
      list.append(empty);
      return;
    }
    for (const group of groups) {
      list.append(groupSelectCard(node, group, render));
    }
  };

  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  footer.append(
    panelButton("全选", () => {
      setSelectedTitles(node, getAllGroups().map(groupTitle));
      render();
    }),
    panelButton("清空", () => {
      setSelectedTitles(node, []);
      render();
    }),
    spacer,
    panelButton("完成", closeGroupSelectPanel, true),
  );

  panel.append(header, list, footer);
  document.body.append(panel);
  render();
  positionGroupSelectPanel(node, panel, anchor, origin);
  panel.style.visibility = "";

  selectPanelKeyHandler = (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeGroupSelectPanel();
  };
  document.addEventListener("keydown", selectPanelKeyHandler, true);

  selectPanelOutsideHandler = (event) => {
    if (panel.contains?.(event.target)) return;
    closeGroupSelectPanel();
  };
  document.addEventListener("pointerdown", selectPanelOutsideHandler, true);
}

function handleMouseDownM(node, e, localPos) {
  if (!localPos) return false;
  const [mx, my] = localPos;
  const W    = node.size[0];
  const btnX = W - PAD_X - BTN_W - 4;

  for (const btn of node._hitHeaderBtns) {
    if (mx >= btn.x && mx <= btn.x + btn.w &&
        my >= btn.y && my <= btn.y + btn.h) {
      if (btn.action === "select_groups") {
        openGroupSelectPanel(node, btn, e ? { x: e.clientX, y: e.clientY } : null);
        return true;
      }
      if (!btn.enabled) return true;
      applyToControlled(node, btn.action === "bypass_all");
      return true;
    }
  }

  for (const row of node._hitRows) {
    if (my < row.y || my > row.y + ROW_H) continue;
    const btnY = row.y + (ROW_H - BTN_H) / 2;
    if (mx >= btnX && mx <= btnX + BTN_W &&
        my >= btnY && my <= btnY + BTN_H) {
      recomputeGroupNodes(row.group);
      setGroupBypass(row.group, !row.bypassed);
      node._lastRecomputeMs = 0;
      return true;
    }
    if (mx < btnX - 30) {
      navigateToGroup(row.group);
      return true;
    }
  }
  return false;
}

function ensureStateS(node) {
  if (node._gbcS) return;
  node._gbcS = true;

  if (!node.properties) node.properties = {};
  if (typeof node.properties.selectedGroup !== "string") {
    node.properties.selectedGroup = "";
  }

  node._hitDropdown     = null;
  node._hitToggleS      = null;
  node._lastRecomputeMs = node._lastRecomputeMs ?? 0;
  node.serialize_widgets = false;
  node.isVirtualNode    = true;
  node.size             = [MIN_W, SINGLE_H];
  syncEnableWidget(node);
}

function drawSingleNode(node, ctx) {
  if (node.flags?.collapsed) return;

  node.size[1] = SINGLE_H;
  const toggleWidget = syncEnableWidget(node);

  const W        = node.size[0];
  const groups   = getAllGroups();
  const selTitle = node.properties?.selectedGroup ?? "";
  const group    = groups.find((g) => (g.title ?? "") === selTitle) ?? null;

  if (group) {
    const now = Date.now();
    if (now - (node._lastRecomputeMs ?? 0) >= RECOMPUTE_INTERVAL) {
      node._lastRecomputeMs = now;
      recomputeGroupNodes(group);
    }
  }

  const groupNodes = group ? getGroupNodes(group) : [];
  const bypassed   = groupNodes.length > 0 && groupNodes.every((n) => isSkippedMode(n.mode));
  const mixed      = !bypassed && groupNodes.some((n) => isSkippedMode(n.mode));

  if (toggleWidget && toggleWidget.value !== !bypassed) {
    toggleWidget.value = !bypassed;
  }

  let y = PAD_Y;

  const dX = PAD_X;
  const dY = y;
  const dW = W - PAD_X * 2;
  const dH = DROPDOWN_H;
  node._hitDropdown = { x: dX, y: dY, w: dW, h: dH };

  ctx.save();
  ctx.fillStyle   = "rgba(255,255,255,0.06)";
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  drawRoundRect(ctx, dX, dY, dW, dH, 5);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.fillStyle    = "#888";
  ctx.font         = "11px sans-serif";
  ctx.textAlign    = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("▼", dX + 8, dY + dH / 2);
  ctx.restore();

  if (group?.color) {
    ctx.save();
    ctx.fillStyle = group.color;
    ctx.beginPath();
    drawRoundRect(ctx, dX + dW - 14, dY + (dH - 14) / 2, 8, 14, 2);
    ctx.fill();
    ctx.restore();
  }

  const displayText = selTitle || "点击选择编组…";
  const textColor   = selTitle ? "#ddd" : "#555";
  const maxTW       = dW - 30 - (group?.color ? 18 : 0);
  ctx.save();
  ctx.fillStyle    = textColor;
  ctx.font         = "13px sans-serif";
  ctx.textAlign    = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(truncateText(ctx, displayText, maxTW), dX + 24, dY + dH / 2);
  ctx.restore();

  y += dH + 6;

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_X, y - 3);
  ctx.lineTo(W - PAD_X, y - 3);
  ctx.stroke();
  ctx.restore();

  const btnX = W - PAD_X - BTN_W - 4;
  const btnY = y + (ROW_H - BTN_H) / 2;
  node._hitToggleS = { x: btnX, y: btnY, w: BTN_W, h: BTN_H };

  if (!group) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.beginPath();
    drawRoundRect(ctx, btnX, btnY, BTN_W, BTN_H, 11);
    ctx.fill();
    ctx.fillStyle    = "#555";
    ctx.font         = "bold 10px sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("未选择", btnX + BTN_W / 2, btnY + BTN_H / 2);
    ctx.restore();

    ctx.save();
    ctx.fillStyle    = "#444";
    ctx.font         = "italic 11px sans-serif";
    ctx.textAlign    = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("请先选择编组", PAD_X + 4, y + ROW_H / 2);
    ctx.restore();
  } else {
    ctx.save();
    ctx.fillStyle = bypassed ? "#7a1515" : (mixed ? "#7a4c15" : "#155c30");
    ctx.beginPath();
    drawRoundRect(ctx, btnX, btnY, BTN_W, BTN_H, 11);
    ctx.fill();
    ctx.fillStyle    = "rgba(255,255,255,0.9)";
    ctx.font         = "bold 10px sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      bypassed ? "已跳过" : (mixed ? "部分跳过" : "已启用"),
      btnX + BTN_W / 2, btnY + BTN_H / 2
    );
    ctx.restore();

    const cntX = btnX - 28;
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.beginPath();
    drawRoundRect(ctx, cntX, btnY, 24, BTN_H, 4);
    ctx.fill();
    ctx.fillStyle    = "#999";
    ctx.font         = "10px sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(groupNodes.length), cntX + 12, btnY + BTN_H / 2);
    ctx.restore();

    ctx.save();
    ctx.fillStyle    = bypassed ? "#777" : "#bbb";
    ctx.font         = "12px sans-serif";
    ctx.textAlign    = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(
      truncateText(ctx, group.title || "未命名编组", cntX - PAD_X - 8),
      PAD_X + 4, y + ROW_H / 2
    );
    ctx.restore();
  }
}

function handleMouseDownS(node, e, localPos) {
  if (!localPos) return false;
  const [mx, my] = localPos;

  const dd = node._hitDropdown;
  if (dd && mx >= dd.x && mx <= dd.x + dd.w &&
             my >= dd.y && my <= dd.y + dd.h) {
    _showGroupMenu(node, e);
    return true;
  }

  const tg = node._hitToggleS;
  if (tg && mx >= tg.x && mx <= tg.x + tg.w &&
             my >= tg.y && my <= tg.y + tg.h) {
    const group = selectedGroup(node);
    if (group) {
      recomputeGroupNodes(group);
      const nodes    = getGroupNodes(group);
      const bypassed = nodes.length > 0 && nodes.every((n) => isSkippedMode(n.mode));
      setGroupBypass(group, !bypassed);
      node._lastRecomputeMs = 0;
      const widget = enableWidget(node);
      if (widget) widget.value = bypassed;
    }
    return true;
  }

  return false;
}

function _showGroupMenu(node, e) {
  const groups = getAllGroups();

  if (!groups.length) {
    new LiteGraph.ContextMenu(
      [{ content: "（工作流中没有编组）", disabled: true }],
      { event: e }
    );
    return;
  }

  const items = groups.map((g) => ({
    content: g.title || "未命名编组",
    callback: () => {
      node.properties.selectedGroup = g.title ?? "";
      node._lastRecomputeMs = 0;
      app.graph?.setDirtyCanvas?.(true, false);
    },
  }));

  new LiteGraph.ContextMenu(items, {
    event:      e,
    callback:   null,
    parentMenu: null,
  });
}

app.registerExtension({
  name: "ComfyUI.GGNodes.GroupController",

  async beforeRegisterNodeDef(nodeType, nodeData) {

    if (nodeData.name === NODE_NAME_M) {

      const origOnAddedM = nodeType.prototype.onAdded;
      nodeType.prototype.onAdded = function (graph) {
        ensureStateM(this);
        // 加载工作流时先标记；onConfigure 发现已保存的选择后撤销，避免新节点被当成旧工作流。
        if (app.configuringGraph) this[LEGACY_SELECTION_FLAG] = true;
        origOnAddedM?.call(this, graph);
      };

      const origOnConfigureM = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function (info) {
        const result = origOnConfigureM?.call(this, info);
        if (Array.isArray(info?.properties?.[SELECTED_GROUPS_PROPERTY])) {
          delete this[LEGACY_SELECTION_FLAG];
        } else if (info) {
          this[LEGACY_SELECTION_FLAG] = true;
        }
        ensureStateM(this);
        // 编组列表要等整张图 configure 完才可用，先用保存的行标题把控件建好，
        // 否则 GG 选项确认先恢复连线时会找不到目标控件。
        const savedTitles = info?.properties?.[GROUP_SLOT_TITLES_PROPERTY];
        if (Array.isArray(savedTitles)) syncRowWidgets(this, savedTitles);
        return result;
      };

      // 编组在节点全部 configure 完之后才挂回图；此处同步行接入点，
      // 保证 GG 选项确认恢复连线时能立刻找到对应控件。
      const origAfterConfigureM = nodeType.prototype.onAfterGraphConfigured;
      nodeType.prototype.onAfterGraphConfigured = function () {
        const result = origAfterConfigureM?.apply(this, arguments);
        ensureStateM(this);
        syncControlInputs(this, controlGroups(this));
        return result;
      };

      nodeType.prototype.computeSize = function () {
        ensureStateM(this);
        return [MIN_W, computeHeightM(controlGroups(this).length)];
      };

      nodeType.prototype.onDrawForeground = function (ctx) {
        ensureStateM(this);
        drawMultiNode(this, ctx);
      };

      const origMouseDownM = nodeType.prototype.onMouseDown;
      nodeType.prototype.onMouseDown = function (e, localPos, canvas) {
        ensureStateM(this);
        if (handleMouseDownM(this, e, localPos)) return true;
        return origMouseDownM?.call(this, e, localPos, canvas) ?? false;
      };

      const origMenuM = nodeType.prototype.getExtraMenuOptions;
      nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
        origMenuM?.call(this, canvas, options);
        const self = this;
        options.unshift(
          {
            content: "选择要控制的编组…",
            callback: () => openGroupSelectPanel(self),
          },
          {
            content: "跳过所选编组",
            callback: () => applyToControlled(self, true),
          },
          {
            content: "启用所选编组",
            callback: () => applyToControlled(self, false),
          },
          null
        );
      };
    }

    if (nodeData.name === NODE_NAME_S) {

      const origOnAddedS = nodeType.prototype.onAdded;
      nodeType.prototype.onAdded = function (graph) {
        ensureStateS(this);
        origOnAddedS?.call(this, graph);
      };

      nodeType.prototype.computeSize = function () {
        ensureStateS(this);
        return [MIN_W, SINGLE_H];
      };

      nodeType.prototype.onDrawForeground = function (ctx) {
        ensureStateS(this);
        drawSingleNode(this, ctx);
      };

      const origMouseDownS = nodeType.prototype.onMouseDown;
      nodeType.prototype.onMouseDown = function (e, localPos, canvas) {
        ensureStateS(this);
        if (handleMouseDownS(this, e, localPos)) return true;
        return origMouseDownS?.call(this, e, localPos, canvas) ?? false;
      };

      const origMenuS = nodeType.prototype.getExtraMenuOptions;
      nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
        origMenuS?.call(this, canvas, options);
        const self = this;
        options.unshift(
          {
            content: "跳过该编组",
            callback: () => {
              const selTitle = self.properties?.selectedGroup ?? "";
              const group    = getAllGroups().find((g) => (g.title ?? "") === selTitle) ?? null;
              if (group) { recomputeGroupNodes(group); setGroupBypass(group, true); }
            },
          },
          {
            content: "启用该编组",
            callback: () => {
              const selTitle = self.properties?.selectedGroup ?? "";
              const group    = getAllGroups().find((g) => (g.title ?? "") === selTitle) ?? null;
              if (group) { recomputeGroupNodes(group); setGroupBypass(group, false); }
            },
          },
          null
        );
      };
    }
  },

  loadedGraphNode(node) {
    const isM = node.comfyClass === NODE_NAME_M;
    const isS = node.comfyClass === NODE_NAME_S;
    if (!isM && !isS) return;

    requestAnimationFrame(() => {
      if (isM) {
        ensureStateM(node);
        // 旧工作流没有保存编组选择：加载后默认控制全部编组，保持原有行为。
        if (node[LEGACY_SELECTION_FLAG]) {
          delete node[LEGACY_SELECTION_FLAG];
          setSelectedTitles(node, getAllGroups().map(groupTitle));
        }
        node.size[1] = computeHeightM(controlGroups(node).length);
      } else {
        ensureStateS(node);
        syncEnableWidget(node);
        node.size[1] = SINGLE_H;
      }
      app.graph?.setDirtyCanvas?.(true, false);
    });
  },
});
