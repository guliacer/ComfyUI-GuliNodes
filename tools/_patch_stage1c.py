# -*- coding: utf-8 -*-
import io, sys
def read(p): return io.open(p, encoding="utf-8").read()
def write(p, s): io.open(p, "w", encoding="utf-8", newline="").write(s)
def sub1(s, old, new, label):
    n = s.count(old)
    if n != 1:
        print("FAIL", label, "count=", n); sys.exit(1)
    return s.replace(old, new)

p = "web/gg-port-list-toggle.js"
s = read(p)

s = sub1(s, 'import { applySurface, ensureGGDesign } from "./gg-ui-design.js";',
'import { applySurface, ensureGGDesign, detectHostTheme, PALETTES } from "./gg-ui-design.js";', "imports")

# 折叠宽度：设计稿第 5 页 ·06 定稿 96–260 / 默认 158
s = sub1(s, """const COLLAPSE_WIDTH_DEFAULT = 150;
const COLLAPSE_WIDTH_MIN = 60;
const COLLAPSE_WIDTH_MAX = 400;""",
"""const COLLAPSE_WIDTH_DEFAULT = 158;
const COLLAPSE_WIDTH_MIN = 96;
const COLLAPSE_WIDTH_MAX = 260;
// 三档预设（设计稿第 5 页 ·06）：覆盖 90% 用法，滑杆只处理中间值。
const COLLAPSE_WIDTH_PRESETS = [
    { value: 120, label: "紧凑" },
    { value: 158, label: "标准" },
    { value: 200, label: "宽松" },
];""", "collapse width")

# 标题栏按钮主题配色助手
s = sub1(s, """function isNodeHovered(node) {""",
"""// 标题栏三枚按钮的配色：跟随宿主明暗。detectHostTheme 自带 1 秒缓存，
// 不会在 drawNode 里每帧触发 getComputedStyle。
let titleButtonThemeCache = { at: 0, mode: "dark" };
function titleButtonPalette() {
    const now = Date.now();
    if (now - titleButtonThemeCache.at > 1000) {
        titleButtonThemeCache = { at: now, mode: detectHostTheme() };
    }
    return PALETTES[titleButtonThemeCache.mode === "light" ? "light" : "dark"];
}

function hexToRgba(hex, alpha) {
    const text = String(hex || "").replace("#", "");
    const full = text.length === 3 ? [...text].map((ch) => ch + ch).join("") : text;
    const value = Number.parseInt(full, 16);
    if (!Number.isFinite(value)) return `rgba(76, 141, 255, ${alpha})`;
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

// 一枚标题栏按钮的四态底色（设计稿第 1 页 ·02 / 第 2 页 ·02）：
// 默认只有图标；悬停出 btn 底 + ink 图标；激活 accent 软底 + accent 图标。
function titleButtonSkin(palette, { hovered, active, pressed, mode }) {
    if (pressed) return { fill: palette.pressBg, stroke: palette.divider, icon: palette.ink, iconFill: null };
    if (active) {
        return {
            fill: hexToRgba(palette.accent, mode === "light" ? 0.10 : 0.30),
            stroke: hexToRgba(palette.accent, 0.55),
            icon: palette.accent,
            iconFill: palette.accent,
        };
    }
    if (hovered) return { fill: palette.btnHover, stroke: palette.divider, icon: palette.ink, iconFill: null };
    return { fill: null, stroke: null, icon: palette.muted, iconFill: null };
}

function isNodeHovered(node) {""", "theme helpers")

# 常显：端口按钮不再依赖选中/悬停
s = sub1(s, """function shouldShowPortListButton(node) {
    return node?.selected === true || isNodeHovered(node) || node?._ggPortListButtonHovered === true;
}""",
"""function shouldShowPortListButton(node) {
    // 设计稿第 1 页 ·02：三枚按钮常显。没有端口的节点画 34% 禁用态，
    // 而不是“点它也没反应”的隐形按钮。
    return featureEnabled && !isNodeCollapsed(node);
}""", "always show")

# 三枚常显；端口按钮不再要求 hasPorts
s = sub1(s, """    const showPin = fullTier && !officialPin && pinFeatureEnabled;
    const showPort = featureEnabled && hasPorts && midTier;        // 240+ 保留端口
    const showCollapse = collapseFeatureEnabled && smallTier;     // 180+ 保留折叠""",
"""    const showPin = fullTier && !officialPin && pinFeatureEnabled;
    // 端口按钮常显（无端口时由 drawPortListButton 画 34% 禁用态）
    const showPort = featureEnabled && midTier;
    const showCollapse = collapseFeatureEnabled && smallTier;     // 180+ 保留折叠""", "show port")

# 与原生按钮之间：6 + 1px 分隔线 + 12
s = sub1(s, """        const nativeLeft = nativeTitleButtonsLeftEdge(node);
        if (nativeLeft != null) {
            rightAnchor = Math.min(rightAnchor, nativeLeft - NATIVE_BUTTON_GAP);
        }""",
"""        const nativeLeft = nativeTitleButtonsLeftEdge(node);
        if (nativeLeft != null) {
            // 设计稿第 1 页 ·04：我们的组与官方按钮之间 = 6 间距 + 1px 分隔线 + 12。
            rightAnchor = Math.min(rightAnchor, nativeLeft - NATIVE_BUTTON_GAP - 1 - 12);
        }""", "right anchor")

write(p, s)
print("ok part 1")
