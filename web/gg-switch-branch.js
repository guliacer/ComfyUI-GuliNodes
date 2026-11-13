import { app } from "../../scripts/app.js";

// GG 选择：下拉只列已连接分支（官方分支选择控件负责选项），
// 这里补上「自动跟随」——当前值不在已连接分支里时，自动选中第一路已连接分支。
const NODE_TYPE = "GGSwitchBranch";
const WIDGET_NAME = "生效输入";
const INPUT_PREFIX = "autogrow.";

function connectedNames(node) {
  return (node.inputs ?? [])
    .filter((input) => input?.name?.startsWith(INPUT_PREFIX) && input.link != null)
    .map((input) => input.label ?? input.localized_name ?? input.name.slice(INPUT_PREFIX.length));
}

function syncSelection(node) {
  const widget = (node.widgets ?? []).find((item) => item.name === WIDGET_NAME);
  if (!widget) return;
  const names = connectedNames(node);
  if (names.includes(widget.value)) return;
  const next = names[0] ?? "";
  if (widget.value === next) return;
  widget.value = next;
  node.setDirtyCanvas?.(true, true);
}

function patch(node) {
  if (node.__ggSwitchBranchPatched) {
    syncSelection(node);
    return;
  }
  node.__ggSwitchBranchPatched = true;
  for (const name of ["onInputAdded", "onConnectionsChange", "onConfigure"]) {
    const original = node[name];
    node[name] = function (...args) {
      const result = typeof original === "function" ? original.apply(this, args) : undefined;
      syncSelection(this);
      return result;
    };
  }
  syncSelection(node);
}

app.registerExtension({
  name: "ComfyUI.GGNodes.SwitchBranch",
  nodeCreated(node) {
    if (node.comfyClass === NODE_TYPE) patch(node);
  },
  loadedGraphNode(node) {
    if (node.comfyClass === NODE_TYPE) patch(node);
  },
});
