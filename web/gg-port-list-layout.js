export const DEFAULT_MULTILINE_WIDGET_HEIGHT = 56;
export const MIN_MULTILINE_WIDGET_HEIGHT = 36;

export function normalizeMultilineHeight(
    configured,
    fallback = DEFAULT_MULTILINE_WIDGET_HEIGHT,
    minimum = MIN_MULTILINE_WIDGET_HEIGHT,
) {
    const value = Number(configured);
    return Number.isFinite(value) && value >= minimum
        ? value
        : Math.max(minimum, fallback);
}

export function shouldLockHiddenNodeSize({
    featureEnabled,
    hidden,
    collapsed,
    manualSizeObserved,
    lockedSize,
}) {
    return featureEnabled === true
        && hidden === true
        && collapsed !== true
        && manualSizeObserved !== true
        && Array.isArray(lockedSize);
}

export function getVisibleContentHeight(    widgets,
    titleHeight,
    bottomPadding = 10,
) {
    const visible = (Array.isArray(widgets) ? widgets : [])
        .filter((widget) => widget?.visible !== false)
        .map((widget) => {
            const y = Number(widget?.y);
            const height = Number(widget?.height);
            return Number.isFinite(y) && Number.isFinite(height) && height > 0
                ? y + height
                : null;
        })
        .filter((bottom) => Number.isFinite(bottom));
    if (!visible.length) return null;
    return Math.max(
        Number(titleHeight) + Number(bottomPadding),
        Math.max(...visible) + Number(bottomPadding),
    );
}

// 自动布局只许把节点撑大，不许替用户收小。
// 用户拉高节点是为了看清内容，切一次下拉框（显隐控件、改槽位数量）就被压回内容高度，
// 等于每次都要重新拉一遍。没拉过时照常按内容贴合，所以不用额外的「记住」状态。
export function growOnlyHeight(current, content) {
    const now = Number(current);
    const need = Number(content);
    if (!Number.isFinite(need) || need <= 0) {
        return Number.isFinite(now) && now > 0 ? now : need;
    }
    if (!Number.isFinite(now) || now <= 0) return need;
    return Math.max(now, need);
}
