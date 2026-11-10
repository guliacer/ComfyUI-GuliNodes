// 独立校验 gg-top-button-bubble.js 的「名称 + 状态」决策逻辑（不依赖浏览器）。
const fs = require("node:fs");
const path = require("node:path");

const file = path.resolve(__dirname, "..", "web", "gg-top-button-bubble.js");
let src = fs.readFileSync(file, "utf8");

// 抽取从 FEATURE_NAMES_BY_CLASS 到 app.registerExtension 之前的纯逻辑片段。
const start = src.indexOf("const FEATURE_NAMES_BY_CLASS");
const end = src.indexOf("app.registerExtension({");
if (start < 0 || end < 0) {
    console.error("FAIL: 未能定位逻辑片段");
    process.exit(1);
}
const logic = src.slice(start, end);

// 在受限作用域里执行片段并取出函数。
const factory = new Function(`${logic}
return { featureNameFor, stateFor, STATE_TEXT, FEATURE_NAMES_BY_CLASS };`);
const { featureNameFor, stateFor, STATE_TEXT } = factory();

function makeButton({ classes = [], dataset = {}, ariaLabel = null, disabled = false }) {
    return {
        classList: {
            _set: new Set(classes),
            contains(c) { return this._set.has(c); },
            [Symbol.iterator]() { return this._set[Symbol.iterator](); },
        },
        dataset,
        disabled,
        getAttribute(name) { return name === "aria-label" ? ariaLabel : null; },
    };
}

let pass = 0, fail = 0;
function check(label, got, want) {
    if (got === want) { pass++; console.log(`PASS: ${label} => "${got}"`); }
    else { fail++; console.log(`FAIL: ${label} => got "${got}", want "${want}"`); }
}

// 1) 开关类 · 开
let b = makeButton({ classes: ["gg-node-glow-btn", "gg-ui-top-button", "active"], ariaLabel: "开启节点光效" });
check("节点光效 开 名称", featureNameFor(b), "节点光效");
check("节点光效 开 状态", stateFor(b), "on");

// 2) 开关类 · 关
b = makeButton({ classes: ["gg-port-list-top-button", "gg-ui-top-button", "gg-state-off"], ariaLabel: "关闭输入输出列表" });
check("输入输出列表 关 名称", featureNameFor(b), "输入输出列表");
check("输入输出列表 关 状态", stateFor(b), "off");

// 3) 连接线 · 用 gg-state-on
b = makeButton({ classes: ["gg-link-style-btn", "gg-ui-top-button", "gg-state-on"], ariaLabel: "关闭连接线自定义" });
check("连接线 开 名称", featureNameFor(b), "连接线样式");
check("连接线 开 状态", stateFor(b), "on");

// 4) 分组 · 关
b = makeButton({ classes: ["gg-group-styler-btn", "gg-ui-top-button", "gg-state-off"], ariaLabel: "关闭分组样式" });
check("分组 关 名称", featureNameFor(b), "分组样式");

// 5) 界面翻译 · 开
b = makeButton({ classes: ["gg-comfy-translate-btn", "active"], ariaLabel: "关闭界面翻译" });
check("翻译 开 名称", featureNameFor(b), "界面翻译");

// 6) 动作类 · 入口（data-gg-bubble-action）
b = makeButton({ classes: ["gg-switch"], dataset: { ggBubbleAction: "打开 GuliNodes 工具菜单" }, ariaLabel: "GuliNodes 工具" });
check("入口 动作文案", b.dataset.ggBubbleAction, "打开 GuliNodes 工具菜单");

// 7) 未登记类的开关回退到 aria-label
b = makeButton({ classes: ["gg-ui-top-button", "gg-state-on"], ariaLabel: "收起工具栏" });
check("回退 aria-label 名称", featureNameFor(b), "收起工具栏");
check("回退 状态", stateFor(b), "on");

// 8) 禁用态
b = makeButton({ classes: ["gg-ui-top-button", "gg-state-disabled"], ariaLabel: "内存清理" });
check("禁用 状态", stateFor(b), "disabled");

// 9) data-gg-bubble-name 覆盖优先
b = makeButton({ classes: ["gg-node-glow-btn", "active"], dataset: { ggBubbleName: "光效" }, ariaLabel: "开启节点光效" });
check("data-gg-bubble-name 优先", featureNameFor(b), "光效");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
