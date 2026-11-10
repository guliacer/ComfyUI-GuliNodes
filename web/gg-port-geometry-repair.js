import { app } from "../../scripts/app.js";

/**
 * 端口几何修复（通用，覆盖所有 GuliNodes 节点）
 *
 * 背景：历史上的「隐藏输出」补丁在绘制期做过两种投影，并且可能被序列化进工作流：
 *
 *   1. output.pos = [4000, 0]  —— 把输出点停到节点外面。数据还在、连线还在，
 *      但节点右边缘什么都不画。用户看到的就是「输出源漏了」。
 *   2. outputs = []            —— 输出槽被清空，节点右侧彻底没有端口。
 *
 * 这两种状态会跟着存档走，所以老工作流一打开就一直缺输出。GG图像缩放 有专门的
 * 迁移模块处理它自己的历史遗留；这里做一个不绑定具体节点的通用兜底，覆盖其余节点。
 *
 * 修复原则：只动「明显不可能由引擎算出」的值，正常端口一律不碰。
 *   引擎算出来的 output.pos 恒为 [size[0], y]，y 落在 [0, size[1]] 内。
 *   所以判据是 pos[0] 超过 size[0] 一定余量、或 x/y 为负。
 */

const REPAIR_FLAG = "_ggPortGeometryRepaired";
const MARK = "_ggPortGeometryRepair";

function isGgNode(node) {
  if (!node) return false;
  const cls = String(node.comfyClass || node.type || "");
  // GuliPosePicker / GuliGarmentPicker / GuliFacePicker 来自兄弟插件
  // ComfyUI-GuliPoses（python_module 不含 GuliNodes），只认 GG 前缀会漏掉它们。
  if (cls.startsWith("GG") || cls.startsWith("Guli")) return true;
  const mod = String(node.constructor?.nodeData?.python_module || "");
  return mod.includes("Guli");
}

function nodeWidth(node) {
  const w = Number(node?.size?.[0]);
  return Number.isFinite(w) && w > 0 ? w : 200;
}

function nodeHeight(node) {
  const h = Number(node?.size?.[1]);
  return Number.isFinite(h) && h > 0 ? h : 100;
}

/** 端口被停到节点外 / 坐标为负 —— 删掉 pos 让引擎在下次绘制时重算 */
function unparkList(node, list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const w = nodeWidth(node);
  const h = nodeHeight(node);
  let changed = false;
  for (const port of list) {
    if (!port || !Object.prototype.hasOwnProperty.call(port, "pos")) continue;
    const pos = port.pos;
    if (!Array.isArray(pos) || pos.length < 2) continue;
    const x = Number(pos[0]);
    const y = Number(pos[1]);
    const parked = !Number.isFinite(x) || !Number.isFinite(y) || x > w + 200 || x < -50 || y < -50 || y > h + 200;
    if (!parked) continue;
    delete port.pos;
    changed = true;
  }
  return changed;
}

/** 输出槽被清空 —— 按后端定义重建（后端是权威，前端不应有 0 个输出） */
function rebuildOutputs(node) {
  if (!Array.isArray(node?.outputs) || node.outputs.length > 0) return false;
  const nodeData = node.constructor?.nodeData;
  const types = nodeData?.output;
  if (!Array.isArray(types) || types.length === 0) return false;
  const names = Array.isArray(nodeData.output_name) && nodeData.output_name.length ? nodeData.output_name : types;
  let changed = false;
  for (let i = 0; i < types.length; i++) {
    const name = String(names[i] ?? types[i]);
    try {
      if (typeof node.addOutput === "function") node.addOutput(name, types[i]);
      else node.outputs.push({ name, type: types[i], links: [], slot_index: i });
      changed = true;
    } catch (error) {
      console.warn("[GuliNodes] 重建输出端口失败:", name, error);
      break;
    }
  }
  return changed;
}

function refreshGeometry(node) {
  node._widgetSlotsDirty = true;
  try {
    node._setConcreteSlots?.();
  } catch {
    // 交给下一次原生绘制重建
  }
  try {
    node.arrange?.();
  } catch {
    // 几何是尽力而为，端口数据已经修好了
  }
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

function repair(node) {
  if (!isGgNode(node)) return false;
  const unparked = unparkList(node, node.inputs) | unparkList(node, node.outputs);
  const rebuilt = rebuildOutputs(node);
  if (!unparked && !rebuilt) {
    node[REPAIR_FLAG] = true;
    return false;
  }
  refreshGeometry(node);
  // 让修复结果落回存档，否则下次打开又是坏的
  node.graph?.change?.();
  node[REPAIR_FLAG] = true;
  return true;
}

function repairLater(node) {
  if (!isGgNode(node)) return;
  repair(node);
  // 动态输入（COMFY_AUTOGROW_V3 展开的 文本N / 表达式_N）与原生 configure
  // 可能在两帧之后才补完，只补 rAF 一帧会被它们带着老 pos 混过去，
  // 再留两个延迟兜底。repair 幂等，多跑几遍没有副作用。
  requestAnimationFrame(() => repair(node));
  setTimeout(() => repair(node), 300);
  setTimeout(() => repair(node), 1200);
}

/** 绘制期清扫：AUTOGROW 槽位（文本N / 表达式_N / 标签_X）可能在所有
 * repairLater 兜底之后才被引擎补建，并从老存档把 parked pos 一起带回来。
 * 挂在 onDrawBackground 做最后一道网 —— 每帧只做数值比较（很便宜），
 * 真发现 parked 才 delete + change()，正常帧零副作用。 */
function sweepNode(node) {
  if (!isGgNode(node)) return;
  if (unparkList(node, node.inputs) | unparkList(node, node.outputs)) {
    node.graph?.change?.();
  }
}

app.registerExtension({
  name: "ComfyUI.GGNodes.PortGeometryRepair",

  async setup() {
    // 测试与手工排查入口：允许主动对单个节点重跑修复
    app.ggRepairPortGeometry = repair;
  },

  async beforeRegisterNodeDef(nodeType) {
    if (nodeType.prototype._ggPortParkSweepInstalled) return;
    nodeType.prototype._ggPortParkSweepInstalled = true;
    const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
    nodeType.prototype.onDrawBackground = function (...args) {
      try { sweepNode(this); } catch { /* 清扫是尽力而为，不挡绘制 */ }
      return originalOnDrawBackground?.apply(this, args);
    };
  },

  loadedGraphNode(node) {
    repairLater(node);
  },

  nodeCreated(node) {
    repairLater(node);
  },
});
