import { app } from "../../scripts/app.js";

const SETTINGS_ID = "GuliNodes";
const VERSION = "1.0.17";
const REPOSITORY_URL = "https://github.com/guliacer/ComfyUI-GuliNodes";

function createBadgeLink({ href, src, alt, title }) {
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = title || alt;
    link.style.textDecoration = "none";
    link.style.display = "inline-flex";
    link.style.alignItems = "center";
    link.style.height = "20px";

    const badge = document.createElement("img");
    badge.src = src;
    badge.alt = alt;
    badge.style.display = "block";
    badge.style.height = "20px";
    badge.style.maxWidth = "100%";
    link.appendChild(badge);
    return link;
}

function createAboutRow() {
    const row = document.createElement("tr");
    row.className = "gg-settings-about-row";

    const cell = document.createElement("td");
    cell.colSpan = 2;

    const container = document.createElement("div");
    container.className = "gg-settings-about";
    container.style.display = "flex";
    container.style.alignItems = "center";
    container.style.flexWrap = "wrap";
    container.style.gap = "8px";
    container.style.minHeight = "24px";
    container.style.padding = "0 0 8px";

    container.append(
        createBadgeLink({
            href: `${REPOSITORY_URL}/releases/latest`,
            src: `https://img.shields.io/badge/%E7%89%88%E6%9C%AC-${encodeURIComponent(VERSION)}-green?style=flat&labelColor=555555`,
            alt: `GuliNodes 版本 ${VERSION}`,
            title: `当前版本：${VERSION}`,
        }),
        createBadgeLink({
            href: REPOSITORY_URL,
            src: "https://img.shields.io/github/stars/guliacer/ComfyUI-GuliNodes?style=flat&logo=github&logoColor=%23292F34&label=GuliNodes&labelColor=%23FFFFFF&color=blue",
            alt: "GuliNodes GitHub",
            title: "打开 GuliNodes GitHub 仓库",
        }),
        createBadgeLink({
            href: REPOSITORY_URL,
            src: "https://img.shields.io/badge/GitHub-%E4%BB%93%E5%BA%93-blue?style=flat&logo=github&logoColor=white&labelColor=555555",
            alt: "GitHub 仓库",
            title: "打开仓库地址",
        }),
        createBadgeLink({
            href: `${REPOSITORY_URL}/issues`,
            src: "https://img.shields.io/badge/%E9%97%AE%E9%A2%98-%E5%8F%8D%E9%A6%88-blue?style=flat&logo=githubissues&logoColor=white&labelColor=555555",
            alt: "问题反馈",
            title: "提交问题反馈",
        }),
    );

    cell.appendChild(container);
    row.appendChild(cell);
    return row;
}

app.registerExtension({
    name: "ComfyUI.GGNodes.Settings",

    settings: [
        {
            id: `${SETTINGS_ID}.about`,
            category: ["GuliNodes", " GuliNodes"],
            name: "关于",
            type: createAboutRow,
        },
        {
            id: `${SETTINGS_ID}.enableToolbar`,
            category: ["GuliNodes", "\u5de5\u5177\u680f"],
            name: "\u5de5\u5177\u680f",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u662f\u5426\u5728\u753b\u5e03\u5e95\u90e8\u663e\u793a\u8282\u70b9\u989c\u8272/\u5c3a\u5bf8/\u5bf9\u9f50\u5de5\u5177\u680f",
            onChange: (value) => { window.__ggApplyToolbar?.(value); },
        },
        {
            id: `${SETTINGS_ID}.enableToolbarTopSwitch`,
            category: ["GuliNodes", "\u5de5\u5177\u680f", "\u9876\u90e8\u5f00\u5173"],
            name: "\u9876\u90e8\u5f00\u5173",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u662f\u5426\u5728 ComfyUI \u9876\u90e8\u83dc\u5355\u533a\u663e\u793a\u5de5\u5177\u680f\u6536\u8d77/\u5c55\u5f00\u5f00\u5173",
            onChange: (value) => { window.__ggApplyToolbarTopSwitch?.(value); },
        },
        {
            id: `${SETTINGS_ID}.enableMemoryCleanupButtons`,
            category: ["GuliNodes", "\u5185\u5b58\u6e05\u7406"],
            name: "\u9876\u90e8\u5185\u5b58/\u663e\u5b58\u6e05\u7406\u6309\u94ae",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u662f\u5426\u5728 ComfyUI \u9876\u90e8\u83dc\u5355\u533a\u663e\u793a\u6a21\u578b\u663e\u5b58\u91ca\u653e\u548c\u6df1\u5ea6\u6e05\u7406\u6309\u94ae",
            onChange: (value) => { window.__ggApplyMemoryCleanupButtons?.(value); },
        },
        {
            id: `${SETTINGS_ID}.enableLinkStyleButtons`,
            category: ["GuliNodes", "\u8fde\u63a5\u7ebf"],
            name: "\u9876\u90e8\u8fde\u63a5\u7ebf\u6309\u94ae",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u662f\u5426\u5728 ComfyUI \u9876\u90e8\u83dc\u5355\u533a\u663e\u793a\u8fde\u63a5\u7ebf\u81ea\u5b9a\u4e49\u5feb\u6377\u6309\u94ae",
            onChange: (value) => { window.__ggApplyLinkStyleButtons?.(value); },
        },
        {
            id: `${SETTINGS_ID}.enableFloatButtons`,
            category: ["GuliNodes", "\u6587\u672c\u6846\u60ac\u6d6e\u6309\u94ae"],
            name: "\u6587\u672c\u6846\u60ac\u6d6e\u6309\u94ae",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u662f\u5426\u81ea\u52a8\u8bc6\u522b\u753b\u5e03\u4e2d\u6240\u6709\u6587\u672c\u6846\uff0c\u9f20\u6807\u60ac\u6d6e\u65f6\u663e\u793a\u590d\u5236/\u7c98\u8d34/\u6e05\u7a7a\u6309\u94ae",
            onChange: (value) => {
                if (window.__ggApplyFloatButtonsTopSwitch) window.__ggApplyFloatButtonsTopSwitch(value);
                else window.__ggApplyFloatButtons?.(value);
            },
        },
        {
            id: `${SETTINGS_ID}.enablePortListToggle`,
            category: ["GuliNodes", "\u8282\u70b9\u663e\u793a"],
            name: "\u8f93\u5165\u8f93\u51fa\u5217\u8868\u9690\u85cf\u6309\u94ae",
            type: "boolean",
            defaultValue: false,
            tooltip: "\u5f00\u542f\u540e\uff0c\u5728\u6709\u8f93\u5165\u6216\u8f93\u51fa\u7684\u8282\u70b9\u6807\u9898\u680f\u663e\u793a\u6309\u94ae\uff0c\u53ef\u4ee5\u9690\u85cf\u6216\u6062\u590d\u7aef\u53e3\u5217\u8868",
            onChange: (value) => { window.__ggApplyPortListToggle?.(value); },
        },
        {
            id: `${SETTINGS_ID}.enableNodeCollapseButton`,
            category: ["GuliNodes", "\u8282\u70b9\u663e\u793a"],
            name: "\u8282\u70b9\u6298\u53e0\u6309\u94ae",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u5f00\u542f\u540e\uff0c\u5728\u8282\u70b9\u6807\u9898\u680f\u663e\u793a\u6298\u53e0/\u6062\u590d\u6309\u94ae\uff0c\u5e76\u4fdd\u7559\u6298\u53e0\u72b6\u6001",
            onChange: (value) => { window.__ggApplyNodeCollapseButton?.(value); },
        },
        {
            id: `${SETTINGS_ID}.nodeCollapseWidthPadding`,
            category: ["GuliNodes", "\u8282\u70b9\u663e\u793a"],
            name: "\u8282\u70b9\u6298\u53e0\u5bbd\u5ea6",
            type: "slider",
            defaultValue: 150,
            attrs: { min: 60, max: 400, step: 1 },
            tooltip: "\u6240\u6709\u6298\u53e0\u8282\u70b9\u7edf\u4e00\u4e3a\u8fd9\u4e2a\u5bbd\u5ea6\uff08\u50cf\u7d20\uff09\u3002\u6807\u9898\u8fc7\u957f\u4f1a\u622a\u65ad\uff0c\u8fc7\u77ed\u5219\u53f3\u4fa7\u7559\u767d\u3002",
            onChange: (value) => { window.__ggApplyNodeCollapseWidthPadding?.(value); },
        },
        {
            id: `${SETTINGS_ID}.enableNodePinButton`,
            category: ["GuliNodes", "\u8282\u70b9\u663e\u793a"],
            name: "\u8282\u70b9\u56fa\u5b9a\u6309\u94ae",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u5f00\u542f\u540e\uff0c\u5728\u8282\u70b9\u6807\u9898\u680f\u6298\u53e0\u6309\u94ae\u65c1\u663e\u793a\u56fa\u5b9a\u6309\u94ae\uff0c\u70b9\u51fb\u53ef\u5c06\u8282\u70b9\u56fa\u5b9a\u5728\u753b\u5e03\u4e0a\uff08\u4e0d\u53ef\u62d6\u52a8/\u7f29\u653e\uff09\u6216\u53d6\u6d88\u56fa\u5b9a\u3002",
            onChange: (value) => { window.__ggApplyNodePinButton?.(value); },
        },
        {
            id: `${SETTINGS_ID}.enableNodeAlign`,
            category: ["GuliNodes", "\u8282\u70b9\u663e\u793a"],
            name: "\u79fb\u52a8\u5bf9\u9f50\u5438\u9644",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u5f00\u542f\u540e\uff0c\u62d6\u52a8\u8282\u70b9\u65f6\u4f1a\u81ea\u52a8\u5bf9\u9f50\u5230\u9644\u8fd1\u8282\u70b9\u7684\u8fb9\u7f18/\u4e2d\u7ebf\uff08\u50cf PS \u79fb\u52a8\u56fe\u5c42\uff09\uff0c\u5e76\u663e\u793a\u5bf9\u9f50\u53c2\u8003\u7ebf\u3002",
            onChange: (value) => { window.__ggApplyNodeAlign?.(value); },
        },
    ],
});
