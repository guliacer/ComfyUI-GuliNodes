import { app } from "../../scripts/app.js";
import { ensureGGDesign } from "./gg-ui-design.js";
import { getWidgetSkinScope, setWidgetSkinScope, onWidgetSkinScopeChange,
    WIDGET_SKIN_SCOPE_OPTIONS } from "./gg-skin-scope.js";

// 皮肤范围开关直接做成行内分段控件（.gg-seg）：挂在「GuliNodes 工具」菜单的
// 「节点控件皮肤」行右侧，或老版本前端的顶栏兜底位置。不再有「点调色板按钮
// 再开一层弹层」的二级交互——三档按钮就在页面上，点哪档切哪档。
const GROUP_ID = "gg-widget-skin-buttons";
const DESCRIPTIONS = {
    all: "本插件及其它节点的标准控件统一皮肤，保留各节点的布局与交互。",
    own: "本插件及配套节点统一皮肤，其它节点保持原样。首次安装使用此模式。",
    off: "标准控件恢复宿主外观；LoRA 分组、拖拽等专用交互继续保留。",
};
let group;
const choices = [];

function syncControls() {
    const scope = getWidgetSkinScope();
    for (const button of choices) {
        const selected = button.dataset.scope === scope;
        button.setAttribute("aria-pressed", String(selected));
        button.title = DESCRIPTIONS[button.dataset.scope];
        button.setAttribute("aria-label",
            `${button.textContent}：${DESCRIPTIONS[button.dataset.scope]}`);
    }
    group.dataset.scope = scope;
}

function choose(scope) {
    setWidgetSkinScope(scope);
    syncControls();
}

function installStyles() {
    if (document.getElementById("gg-widget-skin-controls-style")) return;
    const style = document.createElement("style");
    style.id = "gg-widget-skin-controls-style";
    style.textContent = `
        #${GROUP_ID} { display: inline-flex; align-items: center; max-width: 100%; }
        /* 行内分段控件要更紧凑：菜单行右侧留给它的空间有限，过大的胶囊会把左侧
           「节点控件皮肤」标签挤成省略号（用户 2026-11-09：三个按钮占比太大、菜单名看不清）。
           这里把高度/内距/字号都压到比全局 .gg-seg 更紧，三档并排仍完整可读。 */
        #${GROUP_ID} .gg-seg { max-width: 100%; }
        #${GROUP_ID} .gg-seg > button { height: 20px; padding: 0 6px;
            font-size: 11px; line-height: 1; white-space: nowrap; }
    `;
    document.head.appendChild(style);
}

app.registerExtension({
    name: "ComfyUI.GGNodes.WidgetSkinControls",
    setup() {
        if (group) return;
        ensureGGDesign();
        installStyles();
        group = document.createElement("div");
        group.id = GROUP_ID;
        group.dataset.scope = getWidgetSkinScope();
        const seg = document.createElement("div");
        seg.className = "gg-seg";
        seg.setAttribute("role", "group");
        seg.setAttribute("aria-label", "节点控件皮肤");
        for (const option of WIDGET_SKIN_SCOPE_OPTIONS) {
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.scope = option.value;
            button.textContent = option.text;
            button.setAttribute("aria-pressed", "false");
            button.addEventListener("click", () => choose(option.value));
            choices.push(button);
            seg.appendChild(button);
        }
        group.appendChild(seg);
        onWidgetSkinScopeChange(syncControls);
        syncControls();

        const place = () => {
            if (window.__ggMountTopGroup?.(group)) return true;
            const host = app.menu?.settingsGroup?.element;
            if (host?.parentElement) host.before(group);
            else {
                document.body.appendChild(group);
                group.style.cssText = "position:fixed;top:18px;right:120px;z-index:100002";
            }
            return false;
        };
        if (!place()) {
            let attempts = 0;
            const retry = () => { if (!place() && ++attempts < 12) setTimeout(retry, 500); };
            setTimeout(retry, 500);
        }
    },
});
