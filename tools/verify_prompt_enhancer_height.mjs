// 提示词增强节点「高度记忆」行为验证：node tools/verify_prompt_enhancer_height.mjs
// 只依赖 gg-prompt-enhancer-height.js 的纯函数，不需要启动 ComfyUI。
import assert from "node:assert/strict";
import {
  BOTTOM_PADDING,
  MIN_REMEMBERED_HEIGHT,
  forgetHeight,
  rememberHeight,
  resolveHeight,
  storedHeight,
  visibleBottom,
} from "../web/gg-prompt-enhancer-height.js";

const growOnlyHeight = (current, content) => {
  const now = Number(current);
  const need = Number(content);
  if (!Number.isFinite(need) || need <= 0) return Number.isFinite(now) && now > 0 ? now : need;
  if (!Number.isFinite(now) || now <= 0) return need;
  return Math.max(now, need);
};

function fakeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

// 复现截图里的节点：10 个控件，最后一个可见控件底边约 460。
function fakeNode(widgets) {
  return { properties: {}, widgets };
}

const visibleWidgets = [
  { y: 32, height: 24 },
  { y: 60, height: 24 },
  { y: 88, height: 24 },
  { y: 116, height: 24 },
  { y: 144, height: 24 },
  { y: 172, height: 24 },
  { y: 200, height: 24 },
  { y: 228, height: 24 },
  { y: 256, height: 24 },
  { y: 284, height: 24 },
];
const hiddenWidgets = [{ y: 312, height: 24, hidden: true }, { y: 340, height: 24, hidden: true }];

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

check("没有记忆时沿用 growOnlyHeight：不擅自缩回工作流里的高度", () => {
  const node = fakeNode(visibleWidgets);
  const target = resolveHeight({ current: 756, computed: 430, remembered: storedHeight(node), bottom: visibleBottom(node), growOnly: growOnlyHeight });
  assert.equal(target, 756);
});

check("记住 547 后，虚高的 computeSize(756) 再也顶不回去", () => {
  const storage = fakeStorage();
  const node = fakeNode(visibleWidgets);
  rememberHeight(node, 547, storage);
  const target = resolveHeight({ current: 756, computed: 756, remembered: storedHeight(node, storage), bottom: visibleBottom(node), growOnly: growOnlyHeight });
  assert.equal(target, 547);
});

check("记住 547 但可见控件放到 600 以上时补到内容高度，不裁控件", () => {
  const widgets = visibleWidgets.map((widget) => ({ ...widget, y: widget.y + 300 }));
  const node = fakeNode(widgets);
  const target = resolveHeight({ current: 547, computed: 756, remembered: 547, bottom: visibleBottom(node), growOnly: growOnlyHeight });
  assert.equal(target, visibleBottom(node) + BOTTOM_PADDING);
  assert.ok(target > 547);
});

check("hidden 的控件不参与底边计算", () => {
  const node = fakeNode([...visibleWidgets, ...hiddenWidgets]);
  assert.equal(visibleBottom(node), 284 + 24);
});

check("完全拿不到控件布局时（首帧/全隐藏）按 computeSize 兜底，避免裁掉控件", () => {
  const node = fakeNode([{ y: 32, height: 24, hidden: true }]);
  assert.equal(visibleBottom(node), 0);
  assert.equal(resolveHeight({ current: 700, computed: 700, remembered: 547, bottom: visibleBottom(node), growOnly: growOnlyHeight }), 700);
});

check("localStorage 跨会话生效：properties 丢了也能恢复", () => {
  const storage = fakeStorage({ "gg.promptEnhancer.height": "512" });
  const node = fakeNode(visibleWidgets);
  assert.equal(storedHeight(node, storage), 512);
});

check("properties 优先于 localStorage（同一工作流里的独立高度）", () => {
  const storage = fakeStorage({ "gg.promptEnhancer.height": "512" });
  const node = fakeNode(visibleWidgets);
  node.properties.ggPreferredHeight = 620;
  assert.equal(storedHeight(node, storage), 620);
});

check("低于最小高度的误触不写入记忆", () => {
  const storage = fakeStorage();
  const node = fakeNode(visibleWidgets);
  assert.equal(rememberHeight(node, MIN_REMEMBERED_HEIGHT - 1, storage), 0);
  assert.equal(storedHeight(node, storage), 0);
});

check("清除记忆后回到 growOnlyHeight 的原始行为", () => {
  const storage = fakeStorage();
  const node = fakeNode(visibleWidgets);
  rememberHeight(node, 547, storage);
  assert.equal(storedHeight(node, storage), 547);
  forgetHeight(node, storage);
  assert.equal(storedHeight(node, storage), 0);
  assert.equal(node.properties.ggPreferredHeight, undefined);
  assert.equal(resolveHeight({ current: 756, computed: 430, remembered: storedHeight(node, storage), bottom: visibleBottom(node), growOnly: growOnlyHeight }), 756);
});

check("重复记忆同一高度不产生多余写入", () => {
  const storage = fakeStorage();
  let writes = 0;
  const spy = {
    getItem: storage.getItem,
    removeItem: storage.removeItem,
    setItem: (key, value) => {
      writes += 1;
      storage.setItem(key, value);
    },
  };
  const node = fakeNode(visibleWidgets);
  rememberHeight(node, 547, spy);
  rememberHeight(node, 547, spy);
  assert.equal(writes, 1);
});

console.log(`\n${passed} 项全部通过`);
