import { app } from "../../scripts/app.js";

const NODE_NAME = "GGUniversalSlider";
const STYLE_ID = "gg-universal-slider-style";
const DEFAULTS = {
  滑条类型: "浮点",
  最小值: 0,
  最大值: 1,
  步长: 0.01,
  显示名称: "数值",
  滑条颜色: "#48c7b8",
};

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.gg-slider-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(12,16,20,.58);backdrop-filter:blur(3px)}
.gg-slider-panel{width:min(420px,calc(100vw - 32px));padding:22px 24px;background:#1f242b;border:1px solid #3c4652;border-radius:8px;box-shadow:0 22px 70px rgba(0,0,0,.42);font-family:"Segoe UI","Microsoft YaHei",sans-serif;--gg-slider-color:#48c7b8}
.gg-slider-title{margin:0 0 18px;color:#f3f6f8;font-size:16px;font-weight:700}
.gg-slider-row{display:grid;grid-template-columns:82px 1fr;align-items:center;gap:12px;margin:12px 0}
.gg-slider-label{color:#aeb8c4;font-size:13px}
.gg-slider-input{box-sizing:border-box;width:100%;height:34px;padding:6px 10px;color:#f3f6f8;background:#151a20;border:1px solid #3d4650;border-radius:6px;outline:none;font:13px "Segoe UI","Microsoft YaHei",sans-serif}
.gg-slider-input:focus{border-color:var(--gg-slider-color);box-shadow:0 0 0 2px color-mix(in srgb,var(--gg-slider-color) 24%,transparent)}
.gg-slider-color{width:54px;height:34px;padding:2px;background:#151a20;border:1px solid #3d4650;border-radius:6px;cursor:pointer}
.gg-slider-segment{display:flex;gap:8px}
.gg-slider-segment button{height:34px;padding:0 14px;color:#d8dee6;background:#151a20;border:1px solid #3d4650;border-radius:6px;cursor:pointer;font:13px "Segoe UI","Microsoft YaHei",sans-serif}
.gg-slider-segment button.is-active{color:#101418;background:var(--gg-slider-color);border-color:var(--gg-slider-color);font-weight:700}
.gg-slider-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.gg-slider-button{height:34px;padding:0 18px;border-radius:6px;border:1px solid #46515d;cursor:pointer;font:13px "Segoe UI","Microsoft YaHei",sans-serif}
.gg-slider-button[data-action="cancel"]{color:#d8dee6;background:#20262d}
.gg-slider-button[data-action="ok"]{color:#101418;background:var(--gg-slider-color);border-color:var(--gg-slider-color);font-weight:700}
`;
  document.head.append(style);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function numberValue(value, fallback) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function isIntegerMode(node) {
  return node?.properties?.滑条类型 === "整数";
}

function snapValue(value, min, step) {
  if (!Number.isFinite(step) || step <= 0) return value;
  return Math.round((value - min) / step) * step + min;
}

function normalizeValue(value, node) {
  const properties = node.properties ?? DEFAULTS;
  const min = numberValue(properties.最小值, DEFAULTS.最小值);
  const max = numberValue(properties.最大值, DEFAULTS.最大值);
  const step = numberValue(properties.步长, DEFAULTS.步长);
  const integerMode = isIntegerMode(node);
  let next = snapValue(numberValue(value, 0), min, step);
  next = clamp(next, min, max);
  if (integerMode) return Math.round(next);
  return Number(next.toFixed(10));
}

function formatValue(value, node) {
  if (isIntegerMode(node)) return String(Math.round(numberValue(value, 0)));
  const step = Math.abs(numberValue(node.properties?.步长, DEFAULTS.步长));
  const decimals = step >= 1 ? 0 : Math.min(6, Math.max(2, Math.ceil(-Math.log10(step))));
  return numberValue(value, 0).toFixed(decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function drawRoundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget?.name === name) ?? null;
}

function markDirty(node) {
  node?.setDirtyCanvas?.(true, true);
}

function ensureProperties(node) {
  node.properties ??= {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (node.properties[key] === undefined) node.properties[key] = value;
  }
}

function syncOutputType(node) {
  let widget = getWidget(node, "输出类型") ?? getWidget(node, "output_type");
  if (!widget && typeof node.addWidget === "function") {
    node.addWidget("combo", "输出类型", isIntegerMode(node) ? "整数" : "浮点", () => {}, { values: ["浮点", "整数"] });
    widget = getWidget(node, "输出类型");
  }
  if (!widget) return;
  widget.value = isIntegerMode(node) ? "整数" : "浮点";
  widget.type = "hidden";
  widget.hidden = true;
  widget.computeSize = () => [0, 0];
  widget.draw = () => {};
  widget.mouse = () => {};
}

function syncValueWidget(node) {
  const widget = getWidget(node, "数值") ?? getWidget(node, "值");
  if (!widget) return;
  widget.value = normalizeValue(widget.value, node);
  widget.type = isIntegerMode(node) ? "INT" : "FLOAT";
  widget.hidden = true;
  widget.computeSize = () => [0, 0];
}

function normalizeSliderConfig(node) {
  ensureProperties(node);
  let min = numberValue(node.properties.最小值, DEFAULTS.最小值);
  let max = numberValue(node.properties.最大值, DEFAULTS.最大值);
  if (min > max) [min, max] = [max, min];
  let step = numberValue(node.properties.步长, DEFAULTS.步长);
  if (step <= 0) step = node.properties.滑条类型 === "整数" ? 1 : 0.01;
  if (node.properties.滑条类型 === "整数") {
    min = Math.round(min);
    max = Math.round(max);
    step = Math.max(1, Math.round(step));
  }
  node.properties.最小值 = min;
  node.properties.最大值 = max;
  node.properties.步长 = step;
  node.properties.滑条类型 = node.properties.滑条类型 === "整数" ? "整数" : "浮点";
  node.properties.显示名称 = String(node.properties.显示名称 || DEFAULTS.显示名称).trim() || DEFAULTS.显示名称;
  if (!/^#[0-9a-f]{6}$/i.test(String(node.properties.滑条颜色))) node.properties.滑条颜色 = DEFAULTS.滑条颜色;
  syncValueWidget(node);
  syncOutputType(node);
}

function cleanupDrag(node) {
  const state = node._ggUniversalSlider;
  if (!state) return;
  state.dragging = false;
  if (state.cleanup) {
    state.cleanup();
    state.cleanup = null;
  }
}

function createInput(type, value, attrs = {}) {
  const input = document.createElement("input");
  input.className = type === "color" ? "gg-slider-color" : "gg-slider-input";
  input.type = type;
  input.value = value;
  for (const [key, attrValue] of Object.entries(attrs)) input.setAttribute(key, attrValue);
  return input;
}

function addRow(panel, labelText, element) {
  const row = document.createElement("div");
  row.className = "gg-slider-row";
  const label = document.createElement("label");
  label.className = "gg-slider-label";
  label.textContent = labelText;
  row.append(label, element);
  panel.append(row);
}

function openSettings(node) {
  injectStyles();
  cleanupDrag(node);
  normalizeSliderConfig(node);
  document.querySelectorAll(".gg-slider-overlay").forEach((element) => element.remove());

  const overlay = document.createElement("div");
  overlay.className = "gg-slider-overlay";
  overlay.tabIndex = -1;

  const panel = document.createElement("div");
  panel.className = "gg-slider-panel";
  panel.style.setProperty("--gg-slider-color", node.properties.滑条颜色);

  const title = document.createElement("h2");
  title.className = "gg-slider-title";
  title.textContent = "GG 万能滑条设置";
  panel.append(title);

  let selectedType = node.properties.滑条类型;
  const segment = document.createElement("div");
  segment.className = "gg-slider-segment";
  for (const type of ["浮点", "整数"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = type;
    button.classList.toggle("is-active", selectedType === type);
    button.addEventListener("click", () => {
      selectedType = type;
      segment.querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
    });
    segment.append(button);
  }
  addRow(panel, "输出类型", segment);

  const colorInput = createInput("color", node.properties.滑条颜色);
  colorInput.addEventListener("input", () => panel.style.setProperty("--gg-slider-color", colorInput.value));
  addRow(panel, "滑条颜色", colorInput);

  const minInput = createInput("number", node.properties.最小值, { step: "any" });
  addRow(panel, "最小值", minInput);
  const maxInput = createInput("number", node.properties.最大值, { step: "any" });
  addRow(panel, "最大值", maxInput);
  const stepInput = createInput("number", node.properties.步长, { step: "any", min: "0.000001" });
  addRow(panel, "步长", stepInput);
  const labelInput = createInput("text", node.properties.显示名称);
  addRow(panel, "显示名称", labelInput);

  const actions = document.createElement("div");
  actions.className = "gg-slider-actions";
  const cancelButton = document.createElement("button");
  cancelButton.className = "gg-slider-button";
  cancelButton.dataset.action = "cancel";
  cancelButton.textContent = "取消";
  cancelButton.addEventListener("click", () => overlay.remove());
  const okButton = document.createElement("button");
  okButton.className = "gg-slider-button";
  okButton.dataset.action = "ok";
  okButton.textContent = "确定";
  okButton.addEventListener("click", () => {
    node.properties.滑条类型 = selectedType;
    node.properties.最小值 = numberValue(minInput.value, DEFAULTS.最小值);
    node.properties.最大值 = numberValue(maxInput.value, DEFAULTS.最大值);
    node.properties.步长 = numberValue(stepInput.value, selectedType === "整数" ? 1 : DEFAULTS.步长);
    node.properties.显示名称 = String(labelInput.value || DEFAULTS.显示名称).trim() || DEFAULTS.显示名称;
    node.properties.滑条颜色 = colorInput.value;
    normalizeSliderConfig(node);
    markDirty(node);
    overlay.remove();
  });
  actions.append(cancelButton, okButton);
  panel.append(actions);
  overlay.append(panel);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") overlay.remove();
    if (event.key === "Enter") okButton.click();
  });

  document.body.append(overlay);
  overlay.focus();
}

function setupSlider(node) {
  if (node._ggUniversalSliderInstalled) return;
  node._ggUniversalSliderInstalled = true;
  normalizeSliderConfig(node);

  const valueWidget = getWidget(node, "数值") ?? getWidget(node, "值");
  const state = {
    valueWidget,
    dragging: false,
    cleanup: null,
    trackLeft: 16,
    trackWidth: 220,
  };
  node._ggUniversalSlider = state;

  syncValueWidget(node);
  syncOutputType(node);
  node.color = node.color || "#24323d";
  node.bgcolor = node.bgcolor || "#24323d";
  if (Array.isArray(node.size)) node.size[0] = Math.max(node.size[0] || 0, 300);

  node.addCustomWidget({
    name: "GG万能滑条界面",
    type: "gg_universal_slider",
    draw(ctx, node, width, y) {
      normalizeSliderConfig(node);
      const widget = getWidget(node, "数值") ?? state.valueWidget;
      const value = normalizeValue(widget?.value ?? 0, node);
      if (widget && widget.value !== value) widget.value = value;
      const min = node.properties.最小值;
      const max = node.properties.最大值;
      const color = node.properties.滑条颜色;
      const range = max - min || 1;
      const ratio = clamp((value - min) / range, 0, 1);
      const marginLeft = 16;
      const marginRight = 22;
      state.trackLeft = marginLeft;
      state.trackWidth = Math.max(1, width - marginLeft - marginRight);

      ctx.save();
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const label = String(node.properties.显示名称 || DEFAULTS.显示名称);
      const valueText = ` ${formatValue(value, node)}`;
      const labelFont = "16px 'Segoe UI','Microsoft YaHei',sans-serif";
      const valueFont = "700 24px 'Segoe UI','Microsoft YaHei',sans-serif";
      ctx.font = labelFont;
      const labelWidth = ctx.measureText(label).width;
      ctx.font = valueFont;
      const valueWidth = ctx.measureText(valueText).width;
      const textX = Math.max(8, (width - labelWidth - valueWidth) / 2);
      const textY = y + 13;
      ctx.shadowColor = "rgba(0,0,0,.45)";
      ctx.shadowBlur = 3;
      ctx.fillStyle = "#b8c3ce";
      ctx.font = labelFont;
      ctx.fillText(label, textX, textY);
      ctx.fillStyle = color;
      ctx.font = valueFont;
      ctx.fillText(valueText, textX + labelWidth, textY);
      ctx.restore();

      const trackY = y + 38;
      const trackHeight = 10;
      const fillWidth = state.trackWidth * ratio;
      ctx.save();
      drawRoundRect(ctx, marginLeft, trackY, state.trackWidth, trackHeight, 5);
      ctx.fillStyle = "#121820";
      ctx.fill();
      ctx.restore();

      if (fillWidth > 0) {
        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        drawRoundRect(ctx, marginLeft, trackY + 2, fillWidth, trackHeight - 4, 4);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();

        ctx.save();
        drawRoundRect(ctx, marginLeft, trackY, fillWidth, trackHeight, 5);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
      }

      const thumbX = marginLeft + fillWidth;
      const thumbY = trackY + trackHeight / 2;
      ctx.save();
      ctx.shadowColor = state.dragging ? color : "rgba(0,0,0,.42)";
      ctx.shadowBlur = state.dragging ? 8 : 4;
      ctx.fillStyle = "#f6f8fb";
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(thumbX, thumbY, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    },
    mouse(event, pos, node) {
      const state = node._ggUniversalSlider;
      const widget = getWidget(node, "数值") ?? state?.valueWidget;
      if (!state || !widget) return false;

      const updateFromGraphX = (graphX) => {
        const ratio = clamp((graphX - state.trackLeft) / state.trackWidth, 0, 1);
        const value = node.properties.最小值 + ratio * (node.properties.最大值 - node.properties.最小值);
        widget.value = normalizeValue(value, node);
        markDirty(node);
      };

      if ((event.type === "mousemove" || event.type === "pointermove") && state.dragging) {
        updateFromGraphX(pos[0]);
        return true;
      }

      if (event.type === "mouseup" || event.type === "pointerup") {
        cleanupDrag(node);
        markDirty(node);
        return true;
      }

      if (event.type !== "mousedown" && event.type !== "pointerdown") return false;
      if (event.button !== undefined && event.button !== 0) return false;
      cleanupDrag(node);
      updateFromGraphX(pos[0]);
      state.dragging = true;

      const startClientX = event.clientX;
      const startValue = widget.value;
      const onMove = (moveEvent) => {
        const scale = app.canvas?.ds?.scale || 1;
        const graphDelta = (moveEvent.clientX - startClientX) / scale;
        const ratioDelta = graphDelta / state.trackWidth;
        const valueDelta = ratioDelta * (node.properties.最大值 - node.properties.最小值);
        widget.value = normalizeValue(startValue + valueDelta, node);
        markDirty(node);
      };
      const onUp = () => cleanupDrag(node);
      state.cleanup = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      return true;
    },
    computeSize(width) {
      return [width, 66];
    },
  });

  const originalWidgetChanged = node.onWidgetChanged;
  node.onWidgetChanged = function (name, value, widget) {
    const result = originalWidgetChanged?.call(this, name, value, widget);
    if (name === "数值") markDirty(this);
    return result;
  };
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.UniversalSlider",

  setup() {
    injectStyles();
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const originalOnCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnCreated?.apply(this, args);
      setupSlider(this);
      return result;
    };

    const originalConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (...args) {
      const result = originalConfigure?.apply(this, args);
      requestAnimationFrame(() => {
        setupSlider(this);
        normalizeSliderConfig(this);
        markDirty(this);
      });
      return result;
    };

    const originalMenu = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options = []) {
      const result = originalMenu?.call(this, canvas, options);
      options.unshift(
        {
          content: "GG 万能滑条设置",
          callback: () => openSettings(this),
        },
        null
      );
      return result;
    };
  },

  loadedGraphNode(node) {
    if (node?.comfyClass !== NODE_NAME && node?.type !== NODE_NAME) return;
    requestAnimationFrame(() => {
      setupSlider(node);
      normalizeSliderConfig(node);
      markDirty(node);
    });
  },
});
