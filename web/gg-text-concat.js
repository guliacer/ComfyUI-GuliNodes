import { app } from "../../scripts/app.js";

// ---------------------------------------------------------------------------
// GG 文本拼接
//
// 后端声明了 20 个可选文本槽（`文本1` … `文本20`），这里只负责「显示几个」：
// 初始只显示 1 个，文本1 有字变 2 个，文本2 有字变 3 个，依此类推，最多 20 个。
// 槽位被转成输入端口并接线也算「在用」：接完文本1 会立刻长出文本2，
// 否则节点上只剩一个端口、连打字的地方都没有（见 visibleSlotCount）。
//
// 清空某个框**只影响它自己**：别的内容留在原来的框里，绝不往前搬。
// 曾经做过「清空中间框就把下面的内容整体上移压实」，结果清空文本1 会把文本2 的字
// 搬到文本1、文本2 变成空框，看起来就像「文本框2 也被删掉了」（用户实测报的缺陷）。
// 代价是清空中间框后原位留一个空格子——但后端拼接本来就跳过空段，
// 成品不受影响，留个空位比丢字安全得多。
//
// 拼接规则（默认换行 + 空白行、自定义分隔符单独占一行）只写在后端 text_tools.py，
// 前端不重复实现一份，避免两处逻辑漂移。
// ---------------------------------------------------------------------------

const NODE_NAME = "GGTextConcat";
const SLOT_PREFIX = "文本";
const MAX_SLOTS = 20;
const HIDDEN_TYPE = "ggHiddenTextSlot";
// 初始只显示一个空框；填上字之后才长出下一个。
const MIN_VISIBLE = 1;
const MIN_WIDTH = 340;
const MIN_HEIGHT = 80;

function slotName(index) {
  return `${SLOT_PREFIX}${index}`;
}

function getWidget(node, name) {
  return node?.widgets?.find((widget) => widget?.name === name) ?? null;
}

function slotEntries(node) {
  // 控件列表在节点生命周期内基本不变，缓存一份：绘制时每帧都要用它，
  // 每次重新 find 20 遍太浪费。onConfigure / 重建时由 setupNode 清掉缓存。
  if (node._ggSlotEntries) return node._ggSlotEntries;
  const entries = [];
  for (let index = 1; index <= MAX_SLOTS; index += 1) {
    const widget = getWidget(node, slotName(index));
    if (widget) entries.push({ index, widget });
  }
  node._ggSlotEntries = entries;
  return entries;
}

function hasText(widget) {
  return String(widget?.value ?? "").trim().length > 0;
}

// 已接线的槽位：它的取值来自连线，控件由前端按「已连线」自己藏起来，
// 所以既不该由我们压成隐藏类型（否则断开连线后前端放不开、渲染不出高度），
// 也不该参与「显示几个」的计数（控件里残留的旧文字是死数据）。
//
// 判断依据必须是「有没有连线（link）」，不能只看 node.inputs 里有没有对应条目：
// 新版前端会把**每个控件**都镜像成一条 input 条目（`widget: {name}`、`link: null`），
// 只按名字匹配会让所有槽位都被当成端口，于是 20 个文本框全被强制显示。
function isSocketSlot(node, widget) {
  return (node?.inputs ?? []).some(
    (input) => input?.widget?.name === widget?.name && input.link != null,
  );
}

// 「显示几个」由两件事共同决定：
//   1. 内容填到哪，空框跟到哪 —— 最后一个有字的槽位后面永远留一个空框；
//   2. 接线的槽位也算「在用」，但只在**末尾**生效：可见范围正好停在
//      一个已接线的槽位上时往后顺延，直到落到一个未接线的槽位为止。
//
// 第 2 条是为了「接文本1 → 必须还能继续打字」：接线的控件显隐归前端管
// （它自己会把控件藏起来、只留端口），如果我们不把范围跨过它，
// 节点上就一个能输入的框都不剩（用户实测报的缺陷）。
//
// 只在末尾顺延、而不是「有连线就参与计数」，是为了不复活老缺陷：
// 隔着空位去接文本3（文本1、文本2 都还没用）时，范围停在文本1，
// 不会把文本2 一起撑出来。已接线槽位里残留的旧文字同样是死数据，不参与计数。
function visibleSlotCount(node, entries) {
  let lastText = 0;
  const wired = new Set();
  for (const { index, widget } of entries) {
    if (isSocketSlot(node, widget)) {
      wired.add(index);
      continue;
    }
    if (hasText(widget)) lastText = index;
  }
  let visible = Math.max(MIN_VISIBLE, lastText + 1);
  while (visible < MAX_SLOTS && wired.has(visible)) visible += 1;
  return Math.min(MAX_SLOTS, visible);
}

function hideSlot(widget) {
  if (!widget || widget._ggSlotHidden) return;
  widget._ggSlotHidden = true;
  widget._ggSlotType = widget.type;
  widget._ggSlotComputeSize = widget.computeSize;
  // 隐藏时必须先写 hidden 再换 type：反序会被前端按旧 type 重新派生可见性。
  widget.hidden = true;
  widget.type = HIDDEN_TYPE;
  widget.computeSize = () => [0, -4];
  delete widget._ggSlotReleased;
}

function showSlot(widget) {
  if (!widget || !widget._ggSlotHidden) return;
  // 显示时先把 type 恢复成真实类型，再写 hidden，顺序同样不能反。
  releaseSlot(widget);
  widget.hidden = false;
}

// 把控件交还给前端：只还原类型与尺寸，**不动 hidden**。
//
// 实测前端对「已接线控件」只改 hidden（接线置 true、断开置 false），从不改 type。
// 我们若把 hidden 一起改了，就是和前端抢同一个开关：要么接线后空框冒出来，
// 要么断开后 type 还停在 ggHiddenTextSlot、前端把 hidden 放开也渲染不出高度。
//
// `_ggSlotReleased` 用来标记「这个控件的显隐已经不归我们管了」：
// 前端在 removeLink 时会自己把 hidden 放开，但 disconnectOutput 之类的路径不会，
// 断开后若看到这个标记且 hidden 还是 true，就由我们补一次，保证两条路径结果一致。
function releaseSlot(widget) {
  if (!widget || !widget._ggSlotHidden) return false;
  if (widget._ggSlotType != null) widget.type = widget._ggSlotType;
  if (widget._ggSlotComputeSize) widget.computeSize = widget._ggSlotComputeSize;
  else delete widget.computeSize;
  delete widget._ggSlotHidden;
  delete widget._ggSlotType;
  delete widget._ggSlotComputeSize;
  widget._ggSlotReleased = true;
  return true;
}

function fitNode(node) {
  const computed = typeof node?.computeSize === "function" ? node.computeSize() : null;
  if (!computed) return;
  const width = Math.max(MIN_WIDTH, Number(node.size?.[0]) || 0, Number(computed[0]) || 0);
  const height = Math.max(MIN_HEIGHT, Number(computed[1]) || 0);
  const current = [Number(node.size?.[0]) || 0, Number(node.size?.[1]) || 0];
  if (Math.abs(current[0] - width) < 1 && Math.abs(current[1] - height) < 1) return;

  node.setSize?.([width, height]);
  node.size = [width, height];
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

// force = true 时跳过「可见数量没变就早退」的缓存：
// 接线变化常常不改可见数量，但需要把已接线槽位的控件交还前端（并补上「已交还」标记），
// 必须强制走一遍循环；断开时也靠它把控件放回来。
function syncSlots(node, force = false) {
  const entries = slotEntries(node);
  if (!entries.length) return 0;

  // 规则：始终只在最后一个「在用」的槽位后面留一个空框。
  // 初始 1 个；文本1 有字变 2 个；文本2 有字变 3 个；文本1 被接线也变 2 个。
  // 中间被清空的框会原位留白（不搬内容），所以「可见数」由最靠后的在用槽位决定，
  // 前面有几个空位都算在可见范围里——内容绝不能为了少一个空框而搬家。
  const visible = visibleSlotCount(node, entries);
  if (!force && node._ggSlotVisible === visible) return visible;
  node._ggSlotVisible = visible;

  let changed = false;
  for (const { index, widget } of entries) {
    // 已接线的槽位不参与显隐：它的 hidden 由前端按「有没有连线」自己管，
    // 我们只把此前压上去的类型/尺寸还原掉，让前端能正常渲染它。
    if (isSocketSlot(node, widget)) {
      if (releaseSlot(widget)) changed = true;
      // 即使此前没藏过它（接线前它本来就是可见的），也要记下「它的 hidden 不归我们管」：
      // 断开时前端有些路径（disconnectOutput）不会自己放开 hidden，没有这个标记，
      // 控件会一直藏着，而我们却以为它已经显示了。
      if (!widget._ggSlotReleased) {
        widget._ggSlotReleased = true;
        changed = true;
      }
      continue;
    }
    if (index <= visible) {
      if (widget._ggSlotHidden) {
        showSlot(widget);
        changed = true;
      } else if (widget._ggSlotReleased && widget.hidden) {
        // 交还期间被前端藏起来、断开后没被放开的控件，由我们补一次。
        widget.hidden = false;
        delete widget._ggSlotReleased;
        changed = true;
      }
    } else if (!widget._ggSlotHidden) {
      hideSlot(widget);
      changed = true;
    }
  }
  if (changed) fitNode(node);
  return visible;
}

function isConcatNode(node) {
  return Boolean(node) && (node.comfyClass === NODE_NAME || node.type === NODE_NAME);
}

function setupNode(node) {
  if (!isConcatNode(node)) return;
  // 控件可能被重建（onConfigure / 换工作流），缓存一律作废重算。
  node._ggSlotEntries = null;
  node._ggSlotVisible = -1;
  const entries = slotEntries(node);
  if (!entries.length) return;

  // 注意：实例标记不能和原型标记同名——同名时实例读到的永远是原型上的 true，
  // 包装逻辑会被整段跳过（踩过）。
  if (!node._ggTextConcatWrapped) {
    node._ggTextConcatWrapped = true;
    // 经典画布下改字会走 widget.callback，这里先接一手。
    for (const { widget } of entries) {
      const originalCallback = widget.callback;
      widget.callback = function (...args) {
        const result = originalCallback?.apply(this, args);
        syncSlots(node);
        return result;
      };
    }
  }
  syncSlots(node);
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.TextConcat",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME || nodeType.prototype._ggTextConcatProtoPatched) return;
    nodeType.prototype._ggTextConcatProtoPatched = true;

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalOnConfigure?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };

    // 槽位被转成输入端口 / 断开连线时也要重算：接线会改变前端对控件显隐的接管范围。
    const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const result = originalOnConnectionsChange?.apply(this, args);
      // 强制重算：可见数量没变（还是 1 个空框），但必须把接线槽位的控件交还前端。
      if (isConcatNode(this)) setTimeout(() => syncSlots(this, true), 0);
      return result;
    };

    // 兜底：新版前端（Vue 渲染的文本控件）改字时不一定回调 widget.callback，
    // 只在回调里算会导致「填了第一个框却不增行」。绘制钩子每帧跑一次，
    // syncSlots 用可见数量做缓存，数量没变就是一次整数比较，代价可以忽略。
    const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (...args) {
      const result = originalOnDrawForeground?.apply(this, args);
      if (isConcatNode(this)) syncSlots(this);
      return result;
    };
  },

  nodeCreated(node) {
    if (isConcatNode(node)) setTimeout(() => setupNode(node), 0);
  },

  loadedGraphNode(node) {
    if (isConcatNode(node)) setTimeout(() => setupNode(node), 0);
  },
});
