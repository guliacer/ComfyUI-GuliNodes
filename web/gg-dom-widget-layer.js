import { app } from "../../scripts/app.js";

// ComfyUI 的 DOM widget 定位层（<div data-testid="dom-widgets">）是 graph-canvas-container
// 里的一个 position:static 普通 div，里面每个 DOM 控件用 position:relative + left/top 定位。
// 后果：控件越多，这个容器被撑得越高，而它 pointer-events 是默认的 auto——
// 一整块透明矩形盖在画布上，鼠标按下去的事件落在它身上，画布收不到。
//
// 表现出来就是：打开节点多的老工作流后，画布拖不动、滚轮不缩放、点节点没反应，
// 但右侧面板和输入框照常能用（那些不在画布上）。实测该工作流容器被撑到 1600×538，
// 画布上半部分完全失去响应。
//
// 修法就是恢复它本来该有的语义：定位层本身不接事件，里面的控件各自接。
// pointer-events 是继承属性，所以容器设 none 之后必须给直接子元素显式设回 auto，
// 否则多行输入框、预览面板会一起失效。

const STYLE_ID = "gg-dom-widget-layer-fix";

const CSS = `
div[data-testid="dom-widgets"] {
  pointer-events: none;
}
div[data-testid="dom-widgets"] > * {
  pointer-events: auto;
}
`;

function install() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  if (!document.head) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

app.registerExtension({
  name: "ComfyUI.GGNodes.DomWidgetLayerFix",
  async setup() {
    install();
  },
});
