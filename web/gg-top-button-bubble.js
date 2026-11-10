// 顶栏按钮 · 状态提示气泡（设计稿「GuliNodes 顶栏按钮重设计」第 2 页 ·07）
//
// 原生 `title` 要 ~1 秒才出、样式不可控，而且只写「节点光效」这种名字没有信息量。
// 设计稿要求：顶栏按钮悬停时给出「功能名 · 当前状态」式气泡，用户在悬停瞬间最想知道的
// 是「这是开着的还是关着的、点了会怎样」。动作 / 弹窗类按钮（如 GuliNodes 入口）则写
// 结果文案（如「打开 GuliNodes 工具菜单」）。
//
// 实现要点：
//  - 单一气泡节点 + 事件委托，覆盖所有 `.gg-ui-top-button`（顶栏按钮统一类），含宿主 / 浮动两种位置。
//  - 名称优先取 `data-gg-bubble-name`，其次按类名查表（设计稿里的 4 枚主开关 + 其余开关），
//    都没有再退回 `aria-label`。
//  - 状态从 `gg-state-on` / `active` / `gg-state-off` / `gg-state-disabled` 读，不依赖模块自己写的
//    「开启/关闭 X」动作文案——那样会丢失「当前处于什么状态」这一信息。
//  - 悬停 / 键盘聚焦时清掉原生 `title`（存回 `aria-label` 仍保证可访问性），避免原生提示与气泡重影。
//  - 全部配色用设计层令牌，深 / 浅主题自动跟随。

import { app } from "../../scripts/app.js";

const BUBBLE_DELAY = 120; // ms，远快于原生 title 的 ~1000ms

// 设计稿第 2 页 ·02/·03 的开关清单：类名 → 干净功能名。
// 只列「开关类」；动作类按钮靠 data-gg-bubble-action 或 aria-label 兜底。
const FEATURE_NAMES_BY_CLASS = {
    "gg-node-glow-btn": "节点光效",
    "gg-link-style-btn": "连接线样式",
    "gg-group-styler-btn": "分组样式",
    "gg-comfy-translate-btn": "界面翻译",
    "gg-node-align-top-button": "移动对齐",
    "gg-node-plugin-name-top-button": "插件名称",
    "gg-port-list-top-button": "输入输出列表",
    "gg-node-pin-top-button": "节点固定",
    "gg-node-collapse-top-button": "节点折叠",
    "gg-memory-cleanup-btn": "内存清理",
    "gg-send-to-suyan-btn": "发送到素言",
    "gg-taprelay-toggle-button": "完成通知",
};

function featureNameFor(button) {
    if (button.dataset.ggBubbleName) return button.dataset.ggBubbleName;
    for (const className of button.classList) {
        const name = FEATURE_NAMES_BY_CLASS[className];
        if (name) return name;
    }
    return button.getAttribute("aria-label") || "";
}

function stateFor(button) {
    if (button.disabled || button.classList.contains("gg-state-disabled") ||
        button.getAttribute("aria-disabled") === "true") {
        return "disabled";
    }
    if (button.classList.contains("gg-state-on") || button.classList.contains("active")) {
        return "on";
    }
    if (button.classList.contains("gg-state-off")) {
        return "off";
    }
    return null;
}

const STATE_TEXT = {
    on: "已开启",
    off: "已关闭",
    disabled: "已禁用",
};

app.registerExtension({
    name: "ComfyUI.GGNodes.TopButtonBubble",
    setup() {
        // 气泡 DOM 与样式只建一次。
        const style = document.createElement("style");
        style.id = "gg-top-button-bubble-style";
        style.textContent = `
            .gg-top-button-bubble {
                position: fixed;
                z-index: 100050;
                max-width: 280px;
                padding: 6px 11px;
                border-radius: 9px;
                background: var(--gg-panel, #131822);
                color: var(--gg-ink, #EEF2F8);
                border: 1px solid var(--gg-divider, rgba(148,163,184,0.22));
                box-shadow: 0 10px 24px rgba(15,23,42,0.22);
                font-size: 12px;
                line-height: 1.4;
                font-weight: 500;
                white-space: nowrap;
                pointer-events: none;
                display: none;
                opacity: 0;
                transition: opacity 0.12s ease;
            }
            .gg-top-button-bubble[data-show="true"] {
                display: block;
                opacity: 1;
            }
            .gg-top-button-bubble .gg-bubble-name { font-weight: 600; }
            .gg-top-button-bubble .gg-bubble-sep {
                opacity: 0.45;
                margin: 0 6px;
                font-weight: 400;
            }
            .gg-top-button-bubble .gg-bubble-state { font-weight: 600; }
            .gg-top-button-bubble .gg-bubble-state[data-state="on"] { color: var(--gg-ok, #3DD68C); }
            .gg-top-button-bubble .gg-bubble-state[data-state="off"] { color: var(--gg-muted, #97A3B6); }
            .gg-top-button-bubble .gg-bubble-state[data-state="disabled"] { color: var(--gg-faint, #6B7688); }
        `;
        document.head.appendChild(style);

        const bubble = document.createElement("div");
        bubble.className = "gg-top-button-bubble";
        bubble.setAttribute("role", "tooltip");
        document.body.appendChild(bubble);

        let hideTimer = null;
        let showTimer = null;
        let activeButton = null;

        const hide = () => {
            clearTimeout(showTimer);
            bubble.dataset.show = "false";
            if (activeButton) {
                const btn = activeButton;
                activeButton = null;
                // 还原原生 title（若曾为抑制气泡而清空），aria-label 仍保留可访问性。
                if (btn._ggNativeTitle !== undefined) {
                    btn.title = btn._ggNativeTitle;
                    delete btn._ggNativeTitle;
                }
            }
        };

        const scheduleHide = () => {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(hide, 80);
        };

        const show = (button) => {
            if (button.id === "gg-top-tools-button" && button.getAttribute("aria-expanded") === "true") {
                hide();
                return;
            }
            const actionText = button.dataset.ggBubbleAction;
            const name = featureNameFor(button);
            const state = stateFor(button);

            bubble.textContent = "";
            if (actionText) {
                // 动作 / 弹窗类：直接写结果文案，不拼状态。
                bubble.append(document.createTextNode(actionText));
            } else if (name && state) {
                const nameSpan = document.createElement("span");
                nameSpan.className = "gg-bubble-name";
                nameSpan.textContent = name;
                const sep = document.createElement("span");
                sep.className = "gg-bubble-sep";
                sep.textContent = "·";
                const stateSpan = document.createElement("span");
                stateSpan.className = "gg-bubble-state";
                stateSpan.dataset.state = state;
                stateSpan.textContent = STATE_TEXT[state];
                bubble.append(nameSpan, sep, stateSpan);
            } else if (name) {
                bubble.append(document.createTextNode(name));
            } else {
                return;
            }

            // 抑制原生 title，避免原生提示与气泡重影；aria-label 不动，可访问性保留。
            if (button.title && !button._ggNativeTitle) {
                button._ggNativeTitle = button.title;
                button.title = "";
            }

            const rect = button.getBoundingClientRect();
            bubble.style.left = `${rect.left + rect.width / 2}px`;
            // 顶栏按钮贴在屏幕最顶端，气泡放在按钮下方，避免被顶边裁掉。
            bubble.style.top = `${rect.bottom + 8}px`;
            bubble.style.transform = "translate(-50%, 0)";
            bubble.dataset.show = "true";
            activeButton = button;
        };

        const scheduleShow = (button) => {
            clearTimeout(hideTimer);
            clearTimeout(showTimer);
            showTimer = setTimeout(() => show(button), BUBBLE_DELAY);
        };

        const targetButton = (event) => {
            const el = event.target;
            if (!(el instanceof Element)) return null;
            // 顶栏开关类按钮统一带 .gg-ui-top-button（含浮动态）；GuliNodes 入口是 .gg-switch 且 id 唯一。
            return el.closest(".gg-ui-top-button, #gg-top-tools-button");
        };

        document.addEventListener("mouseover", (event) => {
            const button = targetButton(event);
            if (button) {
                scheduleShow(button);
            } else if (activeButton) {
                scheduleHide();
            }
        });
        document.addEventListener("mouseout", (event) => {
            const button = targetButton(event);
            if (button) scheduleHide();
        });
        // 键盘可达性：Tab 聚焦顶栏按钮时也给出气泡。
        document.addEventListener("focusin", (event) => {
            const button = targetButton(event);
            if (button) scheduleShow(button);
        });
        document.addEventListener("focusout", (event) => {
            const button = targetButton(event);
            if (button) scheduleHide();
        });
        document.addEventListener("click", (event) => {
            if (targetButton(event)) hide();
        }, true);
        // 滚动 / 缩放 / 点击会让气泡错位或卡住，统一收掉。
        window.addEventListener("scroll", () => { if (activeButton) hide(); }, true);
        window.addEventListener("resize", () => { if (activeButton) hide(); });
        document.addEventListener("pointerdown", (event) => {
            const button = targetButton(event);
            if (!button && activeButton) hide();
        });
    },
});
