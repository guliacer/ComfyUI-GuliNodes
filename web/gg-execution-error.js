// GG 执行错误显示：节点执行失败时，把中文错误消息直接画在节点下方，
// 不用翻控制台或弹窗日志去猜失败原因。任何节点（含原生节点）都生效。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const SETTING_ID = "GuliNodes.nodeError.enabled";
const PATCH_FLAG = "_ggExecErrorDrawNodePatched";
const MSG_KEY = "_ggExecErrorMsg";
const FONT_FAMILY = '12px system-ui, "Microsoft YaHei", "PingFang SC", sans-serif';
const PAD_X = 8;
const PAD_Y = 6;
const LINE_HEIGHT = 16;
const MAX_LINES = 6;
const MIN_WIDTH = 60;
const GAP = 2;

const reentrant = new WeakSet();

function enabled() {
  return app.ui?.settings?.getSettingValue?.(SETTING_ID, true) ?? true;
}

// 中文没有空格可分词，按字符累计宽度折行；超出 MAX_LINES 时尾部截断加省略号。
function wrapText(ctx, text, maxWidth, maxLines) {
  const lines = [];
  let line = "";
  for (const ch of String(text)) {
    if (ch === "\n") {
      lines.push(line);
      line = "";
      if (lines.length >= maxLines) return lines;
      continue;
    }
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length >= maxLines) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(last + "…").width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = last + "…";
  }
  return lines;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
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

// 在节点局部坐标系绘制（drawNode 已在 translate(node.pos) 之内）；
// 必须在 original.drawNode 之后调用，避免被节点本体覆盖。
function drawErrorBox(ctx, node) {
  const msg = node[MSG_KEY];
  if (!msg) return;
  const width = Math.max(Number(node.size?.[0]) || 0, MIN_WIDTH);
  ctx.save();
  ctx.font = FONT_FAMILY;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.globalAlpha = 1;
  const lines = wrapText(ctx, msg, width - PAD_X * 2, MAX_LINES);
  const boxHeight = lines.length * LINE_HEIGHT + PAD_Y * 2;
  const y0 = (Number(node.size?.[1]) || 0) + GAP;
  ctx.fillStyle = "rgba(185, 28, 28, 0.94)";
  roundRectPath(ctx, 0, y0, width, boxHeight, 4);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], PAD_X, y0 + PAD_Y + i * LINE_HEIGHT);
  }
  ctx.restore();
}

function wrapDrawNode(target) {
  if (!target || typeof target.drawNode !== "function") return false;
  const original = target.drawNode;
  const wrapped = function (node, ctx, ...args) {
    // 重入保护：原型补丁与实例补丁可能同时命中同一条调用链，只画一次。
    if (reentrant.has(node) || !enabled()) {
      return original.call(this, node, ctx, ...args);
    }
    reentrant.add(node);
    try {
      const result = original.call(this, node, ctx, ...args);
      try {
        drawErrorBox(ctx, node);
      } catch {
        // 错误条绘制失败不能影响节点本体绘制。
      }
      return result;
    } finally {
      reentrant.delete(node);
    }
  };
  target.drawNode = wrapped;
  return true;
}

function installDrawNodePatch() {
  const prototype = Object.getPrototypeOf(app.canvas ?? {}) ?? null;
  const proto = (typeof LGraphCanvas !== "undefined" && LGraphCanvas?.prototype) || prototype;
  if (!proto || typeof proto.drawNode !== "function") return false;
  if (proto[PATCH_FLAG]) return true;
  if (!wrapDrawNode(proto)) return false;
  proto[PATCH_FLAG] = true;
  // 其他扩展已把 drawNode 装在画布实例上时，原型补丁会被遮蔽，补包一次实例。
  const canvas = app.canvas;
  if (canvas && typeof canvas.drawNode === "function" && canvas.drawNode !== proto.drawNode && !canvas[PATCH_FLAG]) {
    wrapDrawNode(canvas);
    canvas[PATCH_FLAG] = true;
  }
  return true;
}

function showExecutionError(detail) {
  const msg = String(detail?.exception_message || "").trim() || "节点执行失败，请查看运行日志获取详情。";
  const nodeId = Number(detail?.node_id);
  const node = Number.isFinite(nodeId) ? app.graph?.getNodeById?.(nodeId) : null;
  if (node) node[MSG_KEY] = msg;
  try {
    app.extensionManager?.toast?.add?.({
      severity: "error",
      summary: `节点执行失败${detail?.node_type ? `（${detail.node_type}）` : ""}`,
      detail: msg,
      life: 10000,
    });
  } catch {
    // 旧版前端没有 toast 能力，节点下方错误条仍然生效。
  }
  if (node) app.canvas?.setDirty?.(true);
}

function clearAllErrors() {
  const nodes = app.graph?._nodes;
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (node && node[MSG_KEY]) delete node[MSG_KEY];
  }
}

app.registerExtension({
  name: "ComfyUI.GGNodes.executionError",
  settings: [
    {
      id: SETTING_ID,
      category: ["GuliNodes", "节点错误显示"],
      name: "在节点上显示执行错误",
      type: "boolean",
      defaultValue: true,
      tooltip: "节点执行失败时把中文错误消息直接画在节点下方，并弹出右上角通知。",
      onChange: () => {
        try {
          app.canvas?.setDirty?.(true);
        } catch {
          // 重绘失败只影响即时刷新，不影响功能。
        }
      },
    },
  ],
  setup() {
    if (!installDrawNodePatch()) return;
    api.addEventListener("execution_error", (event) => {
      try {
        showExecutionError(event?.detail);
      } catch {
        // 显示失败不影响执行流程。
      }
    });
    api.addEventListener("execution_start", () => {
      try {
        clearAllErrors();
      } catch {
        // 清理失败不影响执行流程。
      }
    });
  },
});
