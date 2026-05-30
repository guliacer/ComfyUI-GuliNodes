import { app } from "../../scripts/app.js";

const SET_NODE = "GGSetNode";
const GET_NODE = "GGGetNode";
const EMPTY_TYPE = "*";
const DEFAULT_NAME = "UNKNOWN";
const LINK_MODE_NEVER = "从不";
const LINK_MODE_SELECTED = "选中时";
const LINK_MODE_ALWAYS = "始终";
const NODE_CATEGORY = "GuliNodes/工作流/变量";

const TYPE_COLORS = {
  MODEL: LGraphCanvas.node_colors?.blue,
  LATENT: LGraphCanvas.node_colors?.purple,
  VAE: LGraphCanvas.node_colors?.red,
  IMAGE: LGraphCanvas.node_colors?.pale_blue,
  CLIP: LGraphCanvas.node_colors?.yellow,
  CONDITIONING: LGraphCanvas.node_colors?.brown,
  FLOAT: LGraphCanvas.node_colors?.green,
  MASK: { color: "#1c5715", bgcolor: "#1f401b" },
  INT: { color: "#1b4669", bgcolor: "#29699c" },
};

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

function getNodes(graph) {
  return graph?._nodes ?? graph?.nodes ?? [];
}

function getRootGraph(graph) {
  return graph?.rootGraph ?? app.graph;
}

function getSubgraphs(root) {
  const result = [];
  const subgraphs = root?._subgraphs ?? root?.subgraphs;
  if (!subgraphs) return result;
  for (const graph of subgraphs.values()) result.push(graph);
  return result;
}

function findParentGraph(root, childGraph) {
  if (!root || !childGraph || childGraph === root) return null;
  const graphs = [root, ...getSubgraphs(root)];
  for (const graph of graphs) {
    for (const node of getNodes(graph)) {
      if (node?.subgraph === childGraph) return graph;
    }
  }
  return null;
}

function getGraphAncestors(graph) {
  const root = getRootGraph(graph);
  if (!graph) return [];
  const chain = [graph];
  const seen = new Set(chain);
  let current = graph;
  while (current && current !== root) {
    const parent = findParentGraph(root, current);
    if (!parent || seen.has(parent)) break;
    chain.push(parent);
    seen.add(parent);
    current = parent;
  }
  if (root && !seen.has(root)) chain.push(root);
  return chain;
}

function collectNodes(graphs, type) {
  const found = [];
  for (const graph of graphs) {
    for (const node of getNodes(graph)) {
      if (node?.type === type) found.push({ node, graph });
    }
  }
  return found;
}

function getVisibleSetters(graph) {
  return collectNodes(getGraphAncestors(graph), SET_NODE);
}

function findSetterByName(graph, name) {
  if (!name) return null;
  return getVisibleSetters(graph).find(({ node }) => node.widgets?.[0]?.value === name) ?? null;
}

function getSetterNames(graph, filterType = null) {
  const names = [];
  const seen = new Set();
  for (const { node, graph: setterGraph } of getVisibleSetters(graph)) {
    const name = node.widgets?.[0]?.value;
    const type = node.inputs?.[0]?.type;
    if (!name || seen.has(name)) continue;
    if (filterType && !canConnectType(type, filterType)) continue;
    seen.add(name);
    names.push({ name, source: setterGraph === graph ? "local" : "parent", type });
  }
  names.sort((a, b) => a.name.localeCompare(b.name));
  return names;
}

function titleWith(prefix, name) {
  const disable = app.ui?.settings?.getSettingValue?.("GuliNodes.setGetDisablePrefix") ?? false;
  return name ? `${disable ? "" : prefix + "_"}${name}` : prefix;
}

function normalizeLinkMode(value) {
  if (value === "never" || value === LINK_MODE_NEVER) return "never";
  if (value === "always" || value === LINK_MODE_ALWAYS) return "always";
  return "selected";
}

function typeParts(type) {
  return String(type || EMPTY_TYPE)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function canConnectType(sourceType, targetType) {
  const sourceTypes = typeParts(sourceType);
  const targetTypes = typeParts(targetType);
  if (!sourceTypes.length || !targetTypes.length) return true;
  if (sourceTypes.includes(EMPTY_TYPE) || targetTypes.includes(EMPTY_TYPE)) return true;
  return sourceTypes.some((type) => targetTypes.includes(type));
}

function displayLinkMode(value) {
  const mode = normalizeLinkMode(value);
  if (mode === "never") return LINK_MODE_NEVER;
  if (mode === "always") return LINK_MODE_ALWAYS;
  return LINK_MODE_SELECTED;
}

function migrateLegacyLinkModeSetting() {
  const settings = app.ui?.settings;
  if (!settings?.getSettingValue || !settings?.setSettingValue) return;
  const current = settings.getSettingValue("GuliNodes.setGetShowLinks");
  const translated = displayLinkMode(current);
  if (current !== undefined && current !== translated) {
    settings.setSettingValue("GuliNodes.setGetShowLinks", translated);
  }
}

function autoColor(node, type) {
  const enabled = app.ui?.settings?.getSettingValue?.("GuliNodes.setGetAutoColor") ?? true;
  if (!enabled || !type || type === EMPTY_TYPE) {
    node.color = null;
    node.bgcolor = null;
    return;
  }
  const colors = TYPE_COLORS[typeParts(type)[0]] ?? LGraphCanvas.node_colors?.gray;
  if (colors) {
    node.color = colors.color;
    node.bgcolor = colors.bgcolor;
  }
}

function inferTypeFromInput(node) {
  const link = getLink(node.graph, node.inputs?.[0]?.link);
  if (!link) return EMPTY_TYPE;
  const source = node.graph?.getNodeById?.(link.origin_id);
  return source?.outputs?.[link.origin_slot]?.type || link.type || EMPTY_TYPE;
}

function setSlotType(node, type) {
  const normalized = type || EMPTY_TYPE;
  if (node.inputs?.[0]) {
    node.inputs[0].type = normalized;
    node.inputs[0].name = normalized;
  }
  if (node.outputs?.[0]) {
    node.outputs[0].type = normalized;
    node.outputs[0].name = normalized;
  }
  autoColor(node, normalized);
}

function validateName(setNode) {
  const graph = setNode.graph;
  if (!graph) return;
  let name = setNode.widgets?.[0]?.value?.trim();
  if (!name || name === EMPTY_TYPE) name = DEFAULT_NAME;

  const used = new Set(
    collectNodes([graph], SET_NODE)
      .filter(({ node }) => node !== setNode)
      .map(({ node }) => node.widgets?.[0]?.value)
      .filter(Boolean)
  );
  const base = name.replace(/_\d+$/, "");
  let index = 1;
  while (used.has(name)) name = `${base}_${index++}`;
  setNode.widgets[0].value = name;
  setNode.title = titleWith("GG Set", name);
}

function refreshGetters(graph, name) {
  const root = getRootGraph(graph);
  const graphs = [root, ...getSubgraphs(root)].filter(Boolean);
  for (const { node } of collectNodes(graphs, GET_NODE)) {
    if (!name || node.widgets?.[0]?.value === name) node.onRename?.();
    node._refreshComboOptions?.();
  }
}

function getOutputTargetType(node) {
  const linkId = node.outputs?.[0]?.links?.[0];
  const link = getLink(node.graph, linkId);
  const target = link ? node.graph?.getNodeById?.(link.target_id) : null;
  return target?.inputs?.[link?.target_slot]?.type ?? null;
}

function renderVirtualLink(ctx, fromNode, toNode, color) {
  const start = fromNode.getConnectionPos(false, 0);
  const end = toNode.getConnectionPos(true, 0);
  app.canvas.renderLink(ctx, start, end, null, false, null, color, LiteGraph.RIGHT, LiteGraph.LEFT);
}

function addNodeNear(type, target, side) {
  const graph = app.canvas?.graph || app.graph;
  const node = LiteGraph.createNode(type);
  if (!node || !graph) return null;
  graph.add(node);
  node.pos = [
    side === "left" ? target.pos[0] - node.size[0] - 30 : target.pos[0] + target.size[0] + 30,
    target.pos[1],
  ];
  if (side === "left") {
    const slot = target.inputs?.findIndex((input) => !input.link) ?? -1;
    if (slot >= 0) node.connect(0, target, slot);
  } else {
    const slot = target.outputs?.findIndex((output) => !output.links?.length) ?? -1;
    if (slot >= 0) target.connect(slot, node, 0);
  }
  app.canvas?.selectNode(node, false);
  app.canvas?.setDirty(true, true);
  return node;
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.SetGet",

  registerCustomNodes() {
    class GGSetNode extends LiteGraph.LGraphNode {
      static title = "GG Set";
      static category = NODE_CATEGORY;
      serialize_widgets = true;
      isVirtualNode = true;
      drawConnection = false;

      constructor(title) {
        super(title);
        this.properties ??= {};
        this.properties["Node name for S&R"] = SET_NODE;
        this.addWidget("text", "Constant", DEFAULT_NAME, () => this.onRename());
        this.addInput(EMPTY_TYPE, EMPTY_TYPE);
        this.addOutput(EMPTY_TYPE, EMPTY_TYPE);
        this.title = titleWith("GG Set", DEFAULT_NAME);
      }

      onRename() {
        if (app.configuringGraph) return;
        const previous = this.properties.previousName;
        validateName(this);
        this.properties.previousName = this.widgets[0].value;
        refreshGetters(this.graph, previous);
        refreshGetters(this.graph, this.widgets[0].value);
        app.canvas?.setDirty(true, true);
      }

      onConnectionsChange(slotType, slot, isConnected, linkInfo) {
        if (app.configuringGraph) return;
        if (slotType === LiteGraph.INPUT) {
          const type = isConnected ? (linkInfo?.type || inferTypeFromInput(this)) : EMPTY_TYPE;
          setSlotType(this, type);
          if (isConnected) this.onRename();
        }
        if (slotType === LiteGraph.OUTPUT && isConnected && this.inputs?.[0]?.type !== EMPTY_TYPE) {
          setSlotType(this, this.inputs[0].type);
        }
        refreshGetters(this.graph, this.widgets?.[0]?.value);
      }

      onConfigure() {
        setTimeout(() => {
          const type = this.inputs?.[0]?.link ? inferTypeFromInput(this) : this.inputs?.[0]?.type;
          setSlotType(this, type || EMPTY_TYPE);
          validateName(this);
          refreshGetters(this.graph, this.widgets?.[0]?.value);
        }, 0);
      }

      getInputLink(slot) {
        return getLink(this.graph, this.inputs?.[slot]?.link);
      }

      getExtraMenuOptions(_, options) {
        options.unshift({
          content: this.drawConnection ? "隐藏虚拟连线" : "显示虚拟连线",
          callback: () => {
            this.drawConnection = !this.drawConnection;
            app.canvas?.setDirty(true, true);
          },
        });
        options.unshift({
          content: "添加配对 GG Get",
          callback: () => {
            const getter = addNodeNear(GET_NODE, this, "right");
            if (getter?.widgets?.[0]) {
              getter.widgets[0].value = this.widgets[0].value;
              getter.onRename?.();
            }
          },
        });
      }
    }

    class GGGetNode extends LiteGraph.LGraphNode {
      static title = "GG Get";
      static category = NODE_CATEGORY;
      serialize_widgets = true;
      isVirtualNode = true;

      constructor(title) {
        super(title);
        this.properties ??= {};
        this.properties["Node name for S&R"] = GET_NODE;
        const options = {
          values: [],
          getOptionLabel: (value) => {
            const item = getSetterNames(this.graph).find((entry) => entry.name === value);
            if (!item || item.source === "local") return value;
            return `${value} (父级)`;
          },
        };
        Object.defineProperty(options, "values", {
          get: () => {
            const filter = (app.ui?.settings?.getSettingValue?.("GuliNodes.setGetFilterByType") ?? true)
              ? getOutputTargetType(this)
              : null;
            return getSetterNames(this.graph, filter).map((entry) => entry.name);
          },
          enumerable: true,
          configurable: true,
        });
        this.addWidget("combo", "Constant", "", () => this.onRename(), options);
        this._refreshComboOptions = () => {
          const widget = this.widgets?.[0];
          if (!widget) return;
          widget.options = { ...widget.options };
        };
        this.addOutput(EMPTY_TYPE, EMPTY_TYPE);
      }

      onConnectionsChange() {
        if (!app.configuringGraph) this.validateLinks();
      }

      onConfigure() {
        setTimeout(() => {
          this._refreshComboOptions?.();
          this.onRename();
        }, 0);
      }

      onRename() {
        const setter = findSetterByName(this.graph, this.widgets?.[0]?.value);
        if (!setter) {
          this.title = titleWith("GG Get", this.widgets?.[0]?.value || "");
          setSlotType(this, EMPTY_TYPE);
          app.canvas?.setDirty(true, true);
          return;
        }
        const type = setter.node.inputs?.[0]?.type || EMPTY_TYPE;
        this.title = titleWith("GG Get", setter.node.widgets?.[0]?.value);
        if (this.outputs?.[0]) {
          this.outputs[0].type = type;
          this.outputs[0].name = type;
        }
        autoColor(this, type);
        this.validateLinks();
        app.canvas?.setDirty(true, true);
      }

      validateLinks() {
        const type = this.outputs?.[0]?.type;
        if (!type || type === EMPTY_TYPE || !this.graph) return;
        for (const linkId of [...(this.outputs[0].links ?? [])]) {
          const link = getLink(this.graph, linkId);
          const target = link ? this.graph.getNodeById(link.target_id) : null;
          const targetType = target?.inputs?.[link?.target_slot]?.type;
          if (targetType && !canConnectType(type, targetType)) {
            this.graph.removeLink(link?.id ?? linkId);
          }
        }
      }

      findSetter() {
        return findSetterByName(this.graph, this.widgets?.[0]?.value)?.node ?? null;
      }

      getInputLink(slot) {
        const setter = findSetterByName(this.graph, this.widgets?.[0]?.value);
        if (!setter || setter.graph !== this.graph) return null;
        return getLink(this.graph, setter.node.inputs?.[slot]?.link);
      }

      resolveVirtualOutput(slot) {
        const setter = findSetterByName(this.graph, this.widgets?.[0]?.value);
        if (!setter || setter.graph === this.graph) return undefined;
        const link = getLink(setter.graph, setter.node.inputs?.[slot]?.link);
        const source = link ? setter.graph.getNodeById(link.origin_id) : null;
        return source ? { node: source, slot: link.origin_slot } : undefined;
      }

      goToSetter() {
        const setter = this.findSetter();
        if (!setter) return;
        if (setter.graph && setter.graph !== this.graph) app.canvas?.setGraph?.(setter.graph);
        setTimeout(() => {
          app.canvas?.centerOnNode?.(setter);
          app.canvas?.selectNode?.(setter, false);
          app.canvas?.setDirty(true, true);
        }, 0);
      }

      getExtraMenuOptions(_, options) {
        if (!this.findSetter()) return;
        options.unshift({
          content: "跳转到 GG Set 节点",
          callback: () => this.goToSetter(),
        });
      }
    }

    LiteGraph.registerNodeType(SET_NODE, GGSetNode);
    LiteGraph.registerNodeType(GET_NODE, GGGetNode);
  },

  settings: [
    {
      id: "GuliNodes.setGetFilterByType",
      category: ["GuliNodes", "设置/获取"],
      name: "按类型筛选获取选项",
      type: "boolean",
      defaultValue: true,
    },
    {
      id: "GuliNodes.setGetAutoColor",
      category: ["GuliNodes", "设置/获取"],
      name: "自动为设置/获取节点上色",
      type: "boolean",
      defaultValue: true,
    },
    {
      id: "GuliNodes.setGetDisablePrefix",
      category: ["GuliNodes", "设置/获取"],
      name: "隐藏 Set_/Get_ 前缀",
      type: "boolean",
      defaultValue: false,
      onChange: () => refreshGetters(app.graph),
    },
    {
      id: "GuliNodes.setGetShowLinks",
      category: ["GuliNodes", "设置/获取"],
      name: "显示虚拟连线",
      type: "combo",
      options: [LINK_MODE_NEVER, LINK_MODE_SELECTED, LINK_MODE_ALWAYS],
      defaultValue: LINK_MODE_SELECTED,
      onChange: () => app.canvas?.setDirty(true, true),
    },
  ],

  commands: [
    {
      id: "GuliNodes.AddSetNode",
      label: "添加 GG Set 节点",
      function: () => {
        const graph = app.canvas?.graph || app.graph;
        const node = LiteGraph.createNode(SET_NODE);
        if (!node || !graph) return;
        node.pos = [...(app.canvas?.graph_mouse ?? [0, 0])];
        graph.add(node);
        app.canvas?.selectNode(node, false);
      },
    },
    {
      id: "GuliNodes.AddGetNode",
      label: "添加 GG Get 节点",
      function: () => {
        const graph = app.canvas?.graph || app.graph;
        const node = LiteGraph.createNode(GET_NODE);
        if (!node || !graph) return;
        node.pos = [...(app.canvas?.graph_mouse ?? [0, 0])];
        graph.add(node);
        app.canvas?.selectNode(node, false);
      },
    },
  ],

  getNodeMenuItems(node) {
    if (!node?.inputs && !node?.outputs) return [];
    const items = [];
    if (node.inputs?.length) {
      items.push({ content: "添加 GG Get", callback: () => addNodeNear(GET_NODE, node, "left") });
    }
    if (node.outputs?.length) {
      items.push({ content: "添加 GG Set", callback: () => addNodeNear(SET_NODE, node, "right") });
    }
    return items;
  },

  beforeRegisterVueAppNodeDefs(nodeDefs) {
    for (let i = nodeDefs.length - 1; i >= 0; i--) {
      const nodeDef = nodeDefs[i];
      const isSetGet = nodeDef?.name === SET_NODE || nodeDef?.name === GET_NODE;
      if (isSetGet && nodeDef?.python_module === "custom_nodes.frontend_only") nodeDefs.splice(i, 1);
    }
  },

  setup() {
    migrateLegacyLinkModeSetting();

    const originalDrawBackground = app.canvas.onDrawBackground;
    app.canvas.onDrawBackground = function (ctx, visibleArea) {
      originalDrawBackground?.call(this, ctx, visibleArea);
      const graph = this.graph || app.graph;
      const mode = normalizeLinkMode(app.ui?.settings?.getSettingValue?.("GuliNodes.setGetShowLinks") ?? LINK_MODE_SELECTED);
      if (mode === "never" && !getNodes(graph).some((node) => node.type === SET_NODE && node.drawConnection)) return;

      const selectedNames = new Set(
        Object.values(this.selected_nodes || {})
          .filter((node) => node.type === SET_NODE || node.type === GET_NODE)
          .map((node) => node.widgets?.[0]?.value)
          .filter(Boolean)
      );

      for (const setNode of getNodes(graph).filter((node) => node.type === SET_NODE)) {
        const name = setNode.widgets?.[0]?.value;
        const show = setNode.drawConnection || mode === "always" || (mode === "selected" && selectedNames.has(name));
        if (!show || !name) continue;
        const color = app.canvas.default_connection_color_byType?.[setNode.inputs?.[0]?.type] || setNode.bgcolor || "#aaa";
        for (const getNode of getNodes(graph).filter((node) => node.type === GET_NODE && node.widgets?.[0]?.value === name)) {
          renderVirtualLink(ctx, setNode, getNode, color);
        }
      }
    };

    document.addEventListener("dblclick", () => {
      const selected = Object.values(app.canvas?.selected_nodes || {});
      if (selected.length === 1 && selected[0].type === GET_NODE) selected[0].goToSetter?.();
    });
  },
});
