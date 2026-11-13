export function widgetByName(node, name) {
  return (node?.widgets || []).find((widget) => widget?.name === name);
}

export function setWidgetValue(node, name, value) {
  const widget = widgetByName(node, name);
  if (!widget) return false;
  widget.value = value;
  widget.callback?.(value);
  return String(widget.value) === String(value);
}

export function findCompatibleLoader(graph, nodeType, expectedValues = {}) {
  const entries = Object.entries(expectedValues);
  return (graph?._nodes || []).find((candidate) => {
    if ((candidate?.comfyClass || candidate?.type) !== nodeType) return false;
    return entries.every(([name, value]) =>
      String(widgetByName(candidate, name)?.value ?? "") === String(value));
  });
}

export function createLoaderNode(graph, nodeType, { values = {}, title = "", position = null } = {}) {
  const loader = globalThis.LiteGraph?.createNode?.(nodeType);
  if (!loader || typeof graph?.add !== "function") return null;
  graph.add(loader);
  for (const [name, value] of Object.entries(values)) {
    if (!setWidgetValue(loader, name, value)) {
      graph.remove?.(loader);
      return null;
    }
  }
  if (title) loader.title = title;
  if (Array.isArray(position) && position.length >= 2) loader.pos = position;
  return loader;
}

export function connectLoaderToInput(loader, target, inputName) {
  const inputIndex = (target?.inputs || []).findIndex((input) => input?.name === inputName);
  if (inputIndex < 0) return false;
  if (target.inputs[inputIndex].link != null) return true;
  try {
    loader.connect(0, target, inputIndex);
  } catch {
    return false;
  }
  return target.inputs[inputIndex].link != null;
}
