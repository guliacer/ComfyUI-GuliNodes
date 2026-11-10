function nodeId(value) {
  if (value == null) return null;
  return String(typeof value === "object" ? value.id : value);
}

function sameNode(left, right) {
  if (!left || !right) return false;
  return left === right || (nodeId(left) != null && nodeId(left) === nodeId(right));
}

function hoveredNode(canvas) {
  return canvas?.node_over || canvas?.nodeOver || canvas?.hovered_node || canvas?.hoveredNode || null;
}

function isNodeHovered(node, canvas) {
  return node?.mouseOver === true || sameNode(hoveredNode(canvas), node);
}

function isNodePressed(node, canvas) {
  if (node?.mouse_down === true || node?.mouseDown === true) return true;
  const pointerDown = canvas?.pointer_is_down === true
    || canvas?.pointer?.isDown === true
    || canvas?.pointer?.down === true
    || canvas?.last_mouse_dragging === true;
  if (!pointerDown) return false;
  return sameNode(hoveredNode(canvas), node)
    || sameNode(canvas?.node_dragged, node)
    || sameNode(canvas?._node_dragged, node)
    || sameNode(canvas?.moving_node, node);
}

// Positive y moves the node down in the canvas' local coordinate system.
// Keep this helper shared by drawNode and drawConnections so the one-pixel
// feedback never separates a node from its port endpoints.
export function nodeMicroOffsetY(node, canvas) {
  const scale = Math.max(0.05, Number(canvas?.ds?.scale) || 1);
  if (isNodePressed(node, canvas)) return 1 / scale;
  if (isNodeHovered(node, canvas)) return -1 / scale;
  return 0;
}

export function sameNodeForMicroInteraction(left, right) {
  return sameNode(left, right);
}
