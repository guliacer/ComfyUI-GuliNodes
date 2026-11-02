// 提示词增强节点的「高度记忆」纯逻辑（无 DOM / 无 LiteGraph 依赖，可直接被 Node 测试）。
//
// 背景：这节点在加载时 computeSize 会把尚未隐藏的控件先算进去，配合 growOnlyHeight
// 的「只增不减」，结果就是每次打开工作流都被撑回上一次的高度，用户手动拉矮的尺寸留不住。
// 处理方式：把用户拖出来的高度记进节点 properties（跟工作流一起存）+ localStorage（跨会话），
// 之后刷新以记住的高度为准，只有当前可见控件确实放不下时才往下补。

export const HEIGHT_MEMORY_KEY = "gg.promptEnhancer.height";
export const MIN_REMEMBERED_HEIGHT = 120;
// widget.y 已经把标题栏算进去了，底边再加这点余量就是节点理想高度。
export const BOTTOM_PADDING = 16;

function storageOf(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch (error) {
    return null;
  }
}

export function storedHeight(node, storage) {
  const fromNode = Number(node?.properties?.ggPreferredHeight);
  if (Number.isFinite(fromNode) && fromNode >= MIN_REMEMBERED_HEIGHT) return fromNode;
  const store = storageOf(storage);
  if (!store) return 0;
  try {
    const fromStore = Number(store.getItem(HEIGHT_MEMORY_KEY));
    return Number.isFinite(fromStore) && fromStore >= MIN_REMEMBERED_HEIGHT ? fromStore : 0;
  } catch (error) {
    return 0;
  }
}

export function rememberHeight(node, height, storage) {
  if (!Number.isFinite(height) || height < MIN_REMEMBERED_HEIGHT || !node) return 0;
  const rounded = Math.round(height);
  if (node.properties?.ggPreferredHeight !== rounded) {
    node.properties = node.properties || {};
    node.properties.ggPreferredHeight = rounded;
  }
  const store = storageOf(storage);
  if (store) {
    try {
      // 只在真的变了才写，避免拖拽过程中反复落盘。
      if (String(store.getItem(HEIGHT_MEMORY_KEY)) !== String(rounded)) {
        store.setItem(HEIGHT_MEMORY_KEY, String(rounded));
      }
    } catch (error) {
      // 无痕模式禁用 localStorage 时只靠节点 properties，不影响本次会话。
    }
  }
  return rounded;
}

export function forgetHeight(node, storage) {
  if (node?.properties) delete node.properties.ggPreferredHeight;
  const store = storageOf(storage);
  if (store) {
    try {
      store.removeItem(HEIGHT_MEMORY_KEY);
    } catch (error) {
      // 同上，清不掉就只清 properties。
    }
  }
}

// 可见控件的真实底边。hidden 的控件不参与计算。
export function visibleBottom(node) {
  let bottom = 0;
  for (const widget of node?.widgets || []) {
    if (!widget || widget.hidden) continue;
    const y = Number(widget.y);
    const height = Number(widget.height);
    if (Number.isFinite(y) && Number.isFinite(height) && height > 0) {
      bottom = Math.max(bottom, y + height);
    }
  }
  return bottom;
}

export function resolveHeight({ current, computed, remembered, bottom, growOnly }) {
  const grow = typeof growOnly === "function" ? growOnly : (now, need) => Math.max(Number(now) || 0, Number(need) || 0);
  const content = bottom > 0 && Number.isFinite(computed)
    ? Math.min(computed, bottom + BOTTOM_PADDING)
    : computed;
  if (Number.isFinite(remembered) && remembered > 0) {
    // 记住的高度优先，且不再被虚高的 computeSize 顶回去。
    return Math.max(remembered, Number(content) || 0);
  }
  return grow(current, computed);
}
