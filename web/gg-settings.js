import { app } from "../../scripts/app.js";

const SETTINGS_ID = "GuliNodes";
const VERSION = "1.0.8";
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
    ],
});
