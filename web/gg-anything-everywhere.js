import { app } from "../../scripts/app.js";

const NODE_NAME = "GGAnythingEverywhere";
const EMPTY_TYPE = "*";
const EMPTY_LABEL = "任意";
const INPUT_PREFIX = "anything_";
const COMPACT_WIDTH = 150;
const DEFAULT_SLOT_HEIGHT = 20;
const FIRST_INPUT_ROW_RATIO = 0.7;
const BOTTOM_PADDING = 8;
const MIN_HEIGHT = 46;
const DIRECTIONS = {
  LEFT: 3,
};

function getLiteGraph() {
  return globalThis.LiteGraph ?? {};
}

function liteDirection(name) {
  return getLiteGraph()[name] ?? DIRECTIONS[name];
}

function graphNodes(graph) {
  return graph?.nodes ?? graph?._nodes ?? [];
}

function getRootGraph(graph) {
  return graph?.rootGraph ?? app.rootGraph ?? app.graph;
}

function uniqueGraphs(graphs) {
  return graphs.filter((graph, index) => graph && graphs.indexOf(graph) === index);
}

function getLink(graph, linkId) {
  if (linkId == null) return null;
  const candidates = [linkId];
  const numericId = Number(linkId);
  if (Number.isFinite(numericId)) candidates.push(numericId);

  for (const id of candidates) {
    const link = graph?.getLink?.(id);
    if (link) return link;
  }
  for (const store of [graph?.links, graph?._links]) {
    if (!store) continue;
    for (const id of candidates) {
      const link = typeof store.get === "function" ? store.get(id) : store[id];
      if (link) return link;
    }
  }
  return null;
}

function deleteStoredLink(graph, linkId) {
  const candidates = [linkId];
  const numericId = Number(linkId);
  if (Number.isFinite(numericId)) candidates.push(numericId);

  for (const store of [graph?.links, graph?._links]) {
    if (!store) continue;
    for (const id of candidates) {
      if (typeof store.delete === "function" && store.delete(id)) return;
      if (Object.prototype.hasOwnProperty.call(store, id)) {
        delete store[id];
        return;
      }
    }
  }
}

function removeLink(graph, linkId) {
  const link = getLink(graph, linkId);
  if (linkId == null || !link) return;
  const storedId = link.id ?? linkId;
  if (typeof graph?.removeLink === "function") {
    graph.removeLink(storedId);
    return;
  }

  const origin = getNode(graph, link.origin_id);
  const target = getNode(graph, link.target_id);
  const outputLinks = origin?.outputs?.[link.origin_slot]?.links;
  if (Array.isArray(outputLinks)) {
    const index = outputLinks.findIndex((id) => String(id) === String(storedId));
    if (index >= 0) outputLinks.splice(index, 1);
  }
  const input = target?.inputs?.[link.target_slot];
  if (String(input?.link) === String(storedId)) input.link = null;

  deleteStoredLink(graph, storedId);
}

function getNode(graph, id) {
  return graph?.getNodeById?.(id) ?? graphNodes(graph).find((node) => String(node.id) === String(id));
}

function getCurrentGraphs(graph = app.graph) {
  const root = getRootGraph(graph);
  const graphs = uniqueGraphs([graph, root]);
  const subgraphStore = root?.subgraphs ?? root?._subgraphs;
  const subgraphs = subgraphStore?.values?.();
  if (subgraphs) {
    for (const graph of subgraphs) graphs.push(graph);
  }
  return uniqueGraphs(graphs);
}

function isEverywhereNode(node) {
  return node?.comfyClass === NODE_NAME || node?.type === NODE_NAME;
}

function isNodeLive(node) {
  return node && node.mode !== 2 && node.mode !== 4;
}

function inputDisplayName(input) {
  return input?.label || input?.localized_name || input?.name || "";
}

function typeParts(type) {
  return String(type || EMPTY_TYPE)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function canMatchType(sourceType, targetType) {
  const sourceTypes = typeParts(sourceType);
  const targetTypes = typeParts(targetType);
  if (targetTypes.includes(EMPTY_TYPE)) return true;
  if (sourceTypes.includes(EMPTY_TYPE)) return false;
  return sourceTypes.some((type) => targetTypes.includes(type));
}

function ensureProperties(node) {
  node.properties ??= {};
  node.properties.gg_everywhere ??= { nextInputIndex: 1 };
  return node.properties.gg_everywhere;
}

function setSlotAsEmpty(slot) {
  slot.type = EMPTY_TYPE;
  slot.label = EMPTY_LABEL;
  slot.color_on = undefined;
}

function getConnectedType(node, slot) {
  const link = getLink(node.graph, slot.link);
  const origin = getNode(node.graph, link?.origin_id);
  return origin?.outputs?.[link?.origin_slot]?.type || link?.type || EMPTY_TYPE;
}

function updateConnectedInput(node, slot) {
  const type = getConnectedType(node, slot);
  if (!type || type === EMPTY_TYPE) return;
  slot.type = type;
  slot.label = type;
  slot.color_on = app.canvas?.default_connection_color_byType?.[type];
}

function addEmptyInput(node) {
  const state = ensureProperties(node);
  const index = state.nextInputIndex ?? 1;
  state.nextInputIndex = index + 1;
  node.addInput(`${INPUT_PREFIX}${index}`, EMPTY_TYPE, { label: EMPTY_LABEL });
}

function normalizeInputs(node) {
  ensureProperties(node);
  styleCompactNode(node);
  const inputs = node.inputs ?? [];

  for (const input of inputs) {
    if (input.link) updateConnectedInput(node, input);
    else setSlotAsEmpty(input);
  }

  let emptyInputs = inputs.filter((input) => !input.link && input.type === EMPTY_TYPE);
  if (emptyInputs.length === 0) {
    addEmptyInput(node);
    emptyInputs = (node.inputs ?? []).filter((input) => !input.link && input.type === EMPTY_TYPE);
  }

  for (let i = (node.inputs ?? []).length - 1; i >= 0 && emptyInputs.length > 1; i--) {
    const input = node.inputs[i];
    if (!input.link && input.type === EMPTY_TYPE) {
      node.removeInput(i);
      emptyInputs.pop();
    }
  }

  fitNode(node);
  try {
    node.setDirtyCanvas?.(true, true);
  } catch {
    // The node can be normalized before the canvas is ready.
  }
}

function compactSize(node) {
  const inputCount = Math.max(1, node?.inputs?.length ?? 1);
  const height = Math.max(MIN_HEIGHT, inputSlotY(inputCount - 1, node) + BOTTOM_PADDING);
  return [COMPACT_WIDTH, height];
}

function styleCompactNode(node) {
  node.resizable = false;
  node.resizeable = false;
  node.serialize_widgets = false;
}

function fitNode(node) {
  const size = compactSize(node);
  node.size = size;
  node.setSize?.(size);
  updateSlotLayout(node);
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

function updateSlotLayout(node) {
  const inputs = node.inputs ?? [];
  const width = Number(node.size?.[0]) || COMPACT_WIDTH;
  for (const [index, input] of inputs.entries()) {
    input.label = input.label || EMPTY_LABEL;
    input.dir = liteDirection("LEFT");
    input.pos = [0, inputSlotY(index, node)];
  }
  const height = Math.max(MIN_HEIGHT, inputSlotY(Math.max(0, inputs.length - 1), node) + BOTTOM_PADDING);
  node.size = [width, height];
  node.setSize?.([width, height]);
}

function inputSlotY(index = 0, node = null) {
  const slotHeight = Number(getLiteGraph().NODE_SLOT_HEIGHT) || DEFAULT_SLOT_HEIGHT;
  const slotStartY = Number(node?.constructor?.slot_start_y) || 0;
  return (Math.max(0, index) + FIRST_INPUT_ROW_RATIO) * slotHeight + slotStartY;
}

function inputConnectionPos(node, slotNumber, out) {
  const y = node.pos[1] + inputSlotY(slotNumber, node);
  const x = node.pos[0];
  if (out) {
    out[0] = x;
    out[1] = y;
    return out;
  }
  return [x, y];
}

function getConnectionFromInput(node, input, inputIndex) {
  const link = getLink(node.graph, input.link);
  if (!link) return null;
  const sourceNode = getNode(node.graph, link.origin_id);
  const sourceOutput = sourceNode?.outputs?.[link.origin_slot];
  const type = sourceOutput?.type || link.type || input.type;
  if (!sourceNode || type === EMPTY_TYPE) return null;
  return {
    controller: node,
    controllerInputIndex: inputIndex,
    sourceNode,
    sourceOutputIndex: link.origin_slot,
    sourceType: type,
    sourceInputName: inputDisplayName(input),
  };
}

function collectBroadcasts(graph) {
  const broadcasts = [];
  for (const node of graphNodes(graph)) {
    if (!isEverywhereNode(node) || !isNodeLive(node)) continue;
    for (const [index, input] of (node.inputs ?? []).entries()) {
      if (!input?.link) continue;
      const broadcast = getConnectionFromInput(node, input, index);
      if (broadcast) broadcasts.push(broadcast);
    }
  }
  return broadcasts;
}

function findBestBroadcast(broadcasts, targetNode, targetInput) {
  const matches = broadcasts.filter((item) => {
    if (item.sourceNode.id === targetNode.id) return false;
    return canMatchType(item.sourceType, targetInput.type);
  });
  if (matches.length <= 1) return matches[0] ?? null;

  const targetName = inputDisplayName(targetInput);
  const named = matches.filter((item) => item.sourceInputName && item.sourceInputName === targetName);
  return named.length === 1 ? named[0] : null;
}

function connectEverywhere(graph) {
  const broadcasts = collectBroadcasts(graph);
  const addedLinks = [];
  if (!broadcasts.length) return () => {};

  for (const node of graphNodes(graph)) {
    if (!isNodeLive(node) || isEverywhereNode(node)) continue;
    for (const [inputIndex, input] of (node.inputs ?? []).entries()) {
      if (!input || input.link) continue;
      const broadcast = findBestBroadcast(broadcasts, node, input);
      if (!broadcast) continue;
      const link = broadcast.sourceNode.connect(broadcast.sourceOutputIndex, node, inputIndex);
      const linkId = typeof link === "number" ? link : link?.id;
      if (linkId != null) addedLinks.push({ graph, id: linkId });
    }
  }

  return () => {
    for (const { graph: linkGraph, id } of addedLinks.reverse()) {
      removeLink(linkGraph, id);
    }
  };
}

async function withEverywhereLinks(fn, thisArg, args) {
  const restorers = [];
  try {
    const currentGraph = args?.[0] ?? thisArg?.rootGraph ?? app.rootGraph ?? app.graph;
    for (const candidateGraph of getCurrentGraphs(currentGraph)) {
      restorers.push(connectEverywhere(candidateGraph));
    }
    return await fn.apply(thisArg, args);
  } finally {
    for (const restore of restorers.reverse()) restore();
  }
}

app.registerExtension({
  name: "ComfyUI.GGNodes.AnythingEverywhere",

  settings: [
    {
      id: "GuliNodes.anythingEverywhere",
      category: ["GuliNodes", "全局转接"],
      name: "全局转接",
      type: "boolean",
      defaultValue: true,
      tooltip: "队列执行时从 GG 全局转接节点临时连接匹配输入。",
    },
  ],

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      normalizeInputs(this);
    };

    const originalAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function () {
      originalAdded?.apply(this, arguments);
      normalizeInputs(this);
    };

    const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      originalConnectionsChange?.apply(this, arguments);
      requestAnimationFrame(() => normalizeInputs(this));
    };

    nodeType.prototype.computeSize = function () {
      return compactSize(this);
    };

    const originalGetConnectionPos = nodeType.prototype.getConnectionPos;
    nodeType.prototype.getConnectionPos = function (isInput, slotNumber, out) {
      if (isInput && isEverywhereNode(this)) {
        updateSlotLayout(this);
        return inputConnectionPos(this, slotNumber, out);
      }
      return originalGetConnectionPos?.call(this, isInput, slotNumber, out);
    };
  },

  loadedGraphNode(node) {
    if (!isEverywhereNode(node)) return;
    requestAnimationFrame(() => normalizeInputs(node));
  },

  init() {
    const originalGraphToPrompt = app.graphToPrompt;
    app.graphToPrompt = async function () {
      const enabled = app.ui?.settings?.getSettingValue?.("GuliNodes.anythingEverywhere") ?? true;
      if (!enabled) return await originalGraphToPrompt.apply(this, arguments);
      return await withEverywhereLinks(originalGraphToPrompt, this, arguments);
    };

    const exportCommand = app.extensionManager?.command?.commands?.find?.(
      (command) => command.id === "Comfy.ExportWorkflowAPI"
    );
    if (exportCommand?.function) {
      const originalExport = exportCommand.function;
      exportCommand.function = async function () {
        const enabled = app.ui?.settings?.getSettingValue?.("GuliNodes.anythingEverywhere") ?? true;
        if (!enabled) return await originalExport.apply(this, arguments);
        return await withEverywhereLinks(originalExport, this, arguments);
      };
    }
  },
});
