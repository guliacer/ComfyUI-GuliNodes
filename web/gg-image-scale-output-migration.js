import { app } from "../../scripts/app.js";

/**
 * Repair old GG 图像缩放 nodes saved while the historical output-hiding patch
 * was active. That patch could leave one of two pieces of stale state in a
 * workflow:
 *
 *   1. output.pos = [4000, 0] parked every output outside the node; or
 *   2. outputs = [] after a broken draw-time projection was serialized.
 *
 * GG Latent does not have this problem because it is a pure V3 node: its output
 * is declared once by the schema and is never hidden or projected by a frontend
 * patch. GG 图像缩放 now declares only its image output. This file is a one-time
 * compatibility migration for already-saved nodes: it removes obsolete width and
 * height slots from old workflows and never hides the remaining image output.
 */

const NODE_NAME = "GG图像缩放";
const EXPECTED_OUTPUTS = [["图像", "IMAGE"]];
const MIGRATION_FLAG = "_ggImageScaleOutputMigrationV3";

function isTargetNode(node) {
  return node?.comfyClass === NODE_NAME || node?.type === NODE_NAME;
}

function clearStaleOutputPositions(node) {
  if (!Array.isArray(node?.outputs)) return false;
  let changed = false;
  for (const output of node.outputs) {
    if (!output || !Object.prototype.hasOwnProperty.call(output, "pos")) continue;
    delete output.pos;
    changed = true;
  }
  return changed;
}

function removeObsoleteOutputs(node) {
  if (!isTargetNode(node) || !Array.isArray(node.outputs)) return false;
  let changed = false;
  while (node.outputs.length > EXPECTED_OUTPUTS.length) {
    const index = node.outputs.length - 1;
    try {
      if (typeof node.removeOutput === "function") node.removeOutput(index);
      else node.outputs.splice(index, 1);
      changed = true;
    } catch (error) {
      console.warn("[GuliNodes] Unable to remove obsolete GG图像缩放 output:", error);
      break;
    }
  }
  return changed;
}

function refreshNodeGeometry(node) {
  node._widgetSlotsDirty = true;
  try {
    node._setConcreteSlots?.();
  } catch {
    // The next native draw pass can rebuild concrete slots if this node is still
    // between configure and graph attachment.
  }
  try {
    node.arrange?.();
  } catch {
    // Geometry is best-effort here; the output array itself is already repaired.
  }
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

function repairNode(node) {
  if (!isTargetNode(node)) return false;
  const removed = removeObsoleteOutputs(node);
  const unparked = clearStaleOutputPositions(node);
  if (!removed && !unparked) {
    node[MIGRATION_FLAG] = true;
    return false;
  }
  refreshNodeGeometry(node);
  // Persist the repair when it is applied to a loaded workflow. Without a graph
  // change notification the ports may look fixed until refresh, then the stale
  // serialized state can come back on the next load.
  node.graph?.change?.();
  node[MIGRATION_FLAG] = true;
  return true;
}

function repairLater(node) {
  if (!isTargetNode(node)) return;
  // V3 dynamic inputs and the native configure path can finish one microtask
  // after the lifecycle callback. Run once after that state settles as well.
  repairNode(node);
  requestAnimationFrame(() => repairNode(node));
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.ImageScaleOutputMigration",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalOnConfigure?.apply(this, args);
      repairLater(this);
      return result;
    };

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated?.apply(this, args);
      repairLater(this);
      return result;
    };
  },

  loadedGraphNode(node) {
    repairLater(node);
  },

  nodeCreated(node) {
    repairLater(node);
  },
});
