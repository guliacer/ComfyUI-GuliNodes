import io, re, sys
path = "web/gg-port-list-toggle.js"
src = io.open(path, encoding="utf-8").read()

start = src.index("function drawPortListButton(node, ctx) {")
end = src.index("function drawCollapseIcon(ctx, centerX, centerY, expanded) {")
new_port = '''// 标题栏按钮的公共画法：底色 / 描边 / 图标色全部走主题皮肤（设计稿 1·02 / 2·02）。
// 拿到画布后显式设 globalAlpha，避免上一段绘制遗留的透明度漏进图标。
function paintTitleButton(ctx, rect, skin, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    if (skin.fill) {
        roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, BUTTON_RADIUS);
        ctx.fillStyle = skin.fill;
        ctx.fill();
        ctx.strokeStyle = skin.stroke || skin.fill;
        ctx.lineWidth = 1;
        ctx.stroke();
    }
    ctx.strokeStyle = skin.icon;
    ctx.fillStyle = skin.iconFill || skin.icon;
    ctx.lineWidth = 1.25;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
}

function titleButtonState(node, key, active) {
    const palette = titleButtonPalette();
    const hovered = key === "port"
        ? node._ggPortListButtonHovered === true
        : key === "collapse"
            ? node._ggPortListCollapseButtonHovered === true
            : node._ggPortListPinButtonHovered === true;
    const pressed = key === "port"
        ? node._ggPortListButtonPressed === true
        : key === "collapse"
            ? node._ggPortListCollapseButtonPressed === true
            : node._ggPortListPinButtonPressed === true;
    return { palette, skin: titleButtonSkin(palette, { hovered, active, pressed, mode: titleButtonThemeCache.mode }) };
}

function drawPortListButton(node, ctx) {
    if (!ctx || !shouldShowPortListButton(node)) return;
    const rect = getButtonRect(node);
    if (!rect) return;
    const hidden = readHiddenState(node);
    const enabled = nodeHasPorts(node);
    // 无端口：34% 透明禁用态，不画 hover 底、不响应点击（设计稿 1·02）。
    const { skin } = titleButtonState(node, "port", hidden);
    paintTitleButton(ctx, rect, enabled ? skin : { ...skin, fill: null, stroke: null, icon: titleButtonPalette().muted }, enabled ? 1 : 0.34);
    drawEyeIcon(ctx, rect.x + rect.width / 2, rect.y + rect.height / 2, hidden);
    ctx.restore();
}

'''
src = src[:start] + new_port + src[end:]

start = src.index("function drawCollapseButton(node, ctx) {")
end = src.index("function drawPinIcon(ctx, centerX, centerY, pinned) {")
new_collapse = '''function drawCollapseButton(node, ctx) {
    if (!ctx || !collapseFeatureEnabled || !node?._ggPortListNodeHovered && node?.selected !== true) return;
    const rect = getCollapseButtonRect(node);
    if (!rect) return;
    // 激活态 = 已折叠（设计稿 1·02），图标同时翻转成「展开」。
    const { skin } = titleButtonState(node, "collapse", isNodeCollapsed(node));
    paintTitleButton(ctx, rect, skin);
    drawCollapseIcon(ctx, rect.x + rect.width / 2, rect.y + rect.height / 2, !isNodeCollapsed(node));
    ctx.restore();
}

'''
src = src[:start] + new_collapse + src[end:]

start = src.index("function drawPinButton(node, ctx) {")
end = src.index("function refreshNode(node) {")
new_pin = '''function drawPinButton(node, ctx) {
    if (!ctx || !pinFeatureEnabled || !node?._ggPortListNodeHovered && node?.selected !== true) return;
    const rect = getPinButtonRect(node);
    if (!rect) return;
    const pinned = isNodePinned(node);
    const { skin } = titleButtonState(node, "pin", pinned);
    paintTitleButton(ctx, rect, skin);
    drawPinIcon(ctx, rect.x + rect.width / 2, rect.y + rect.height / 2, pinned);
    ctx.restore();
}

'''
src = src[:start] + new_pin + src[end:]

io.open(path, "w", encoding="utf-8", newline="\n").write(src)
print("patched draws")
