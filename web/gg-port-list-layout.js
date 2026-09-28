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

export function getVisibleContentHeight(
    widgets,
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
