import { app } from "../../scripts/app.js";

// ComfyUI 的 DOM widget 定位层（<div class="isolate" data-testid="dom-widgets">）是
// graph-canvas-container 里的一个 position:static 普通 div，里面每个 DOM 控件靠
// position + left/top 绝对定位，坐标已经是视口坐标（画布 pan/zoom 已折算）。
//
// 两个坑：
//
// 【坑一 · 空白透明层挡画布】
// 定位层本身 pointer-events 是默认的 auto——一整块透明矩形盖在画布上，鼠标按下去的
// 事件落在它身上，画布收不到。表现出来就是：打开节点多的老工作流后，画布拖不动、
// 滚轮不缩放、点节点没反应，但右侧面板和输入框照常能用。
//
// 【坑二 · 多行文本框飞出去互相压住】
// 前端 1.57 的 DomWidget 组件首帧用的是一份默认样式快照（position:relative + 当前
// 画布缩放 + 默认尺寸），只有 onDrawForeground 里判断到该 widget「可见」时才会写回
// position:fixed + 真实坐标。于是没有被激活的 widget 永远停在 relative：
//   · relative 参与文档流，left/top 只是视觉偏移，不改变占位；
//   · 同一层里所有 relative 控件按文档流竖直累加高度，再各自叠加 top；
//   · 结果就是每个控件都被前面所有控件的高度推下去，越靠后飞得越远，
//     节点里几个多行文本框全部脱出节点边框、互相压住。
// 实测：isolate 被撑到 424px 高，第 3 个文本框落在 y=523，而正确位置是 y=315。
//
// 修法：把定位层恢复成它本来该有的语义。
//   1. 定位层本身不接事件，控件各自接。pointer-events 是继承属性，所以容器设 none
//      之后必须给直接子元素显式设回 auto，否则多行输入框、预览面板会一起失效。
//   2. 子元素强制 position:fixed —— 官方 computeStyle 的两个分支输出的都是 fixed，
//      我们只是把首帧那份错误的 relative 纠正回官方本意。fixed 脱离文档流之后
//      left/top 直接就是视口坐标，既不会互相累加，也不再撑高定位层。
//
// 注意：定位层和 graph-canvas-container 都没有 transform，所以 fixed 的包含块就是
// 视口，和 left/top 的坐标语义一致；画布缩放走的是控件自身的 transform: scale()，
// 不受影响（scale=0.9 / 1.0 实测落位均精确）。

const STYLE_ID = "gg-dom-widget-layer-fix";

const CSS = `
div[data-testid="dom-widgets"] {
  pointer-events: none;
}
div[data-testid="dom-widgets"] > * {
  pointer-events: auto;
  position: fixed !important;
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
