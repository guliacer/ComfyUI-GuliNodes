// 「GG 图像加载」节点内裁剪弹窗的几何规则。
// 只做纯计算，不碰 DOM：坐标一律是「变换后工作图」的像素坐标。
// 单独成模块是为了让 tools/verify_image_loader_crop.cjs 能直接断言，不必启动 ComfyUI。

export const CROP_RATIO_PRESETS = [
    { label: "自由比例", value: 0 },
    { label: "1:1 正方形", value: 1 },
    { label: "4:3 标准照片", value: 4 / 3 },
    { label: "3:2 摄影照片", value: 3 / 2 },
    { label: "16:9 横屏", value: 16 / 9 },
    { label: "9:16 竖屏", value: 9 / 16 },
    { label: "2:3 人像", value: 2 / 3 },
    { label: "3:4 人像", value: 3 / 4 },
    { label: "4:5 社交媒体", value: 4 / 5 },
    { label: "5:4 横向照片", value: 5 / 4 },
    { label: "21:9 宽银幕", value: 21 / 9 },
];
export const CUSTOM_RATIO = -1;
export const MIN_SELECTION = 2;

/** 支持 "4:3" / "4：3" / "4/3" / "1.5"，非法输入返回 0（=自由比例）。 */
export function parseRatioText(text) {
    const value = String(text ?? "").trim().replace("：", ":");
    const pair = value.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
    if (pair) {
        const width = Number(pair[1]);
        const height = Number(pair[2]);
        return width > 0 && height > 0 ? width / height : 0;
    }
    const single = Number(value);
    return Number.isFinite(single) && single > 0 ? single : 0;
}

/** 旋转 90/270 后宽高互换；翻转不改尺寸。 */
export function transformedBounds(bounds, rotation) {
    const [width, height] = bounds;
    return rotation === 90 || rotation === 270 ? [height, width] : [width, height];
}

export function clampRect(rect, bounds) {
    const [width, height] = bounds;
    const x0 = Math.max(0, Math.min(width, Math.min(rect[0], rect[2])));
    const y0 = Math.max(0, Math.min(height, Math.min(rect[1], rect[3])));
    const x1 = Math.max(0, Math.min(width, Math.max(rect[0], rect[2])));
    const y1 = Math.max(0, Math.min(height, Math.max(rect[1], rect[3])));
    return [x0, y0, x1, y1];
}

/** 按目标宽高比取图内最大的居中矩形，比例无效时返回整图。 */
export function fitCenteredRect(bounds, ratio) {
    const [width, height] = bounds;
    if (!(ratio > 0)) return [0, 0, width, height];
    let w = width;
    let h = w / ratio;
    if (h > height) { h = height; w = h * ratio; }
    return [(width - w) / 2, (height - h) / 2, (width + w) / 2, (height + h) / 2];
}

/**
 * 从锚点拖到指针构造选区。锁定比例时严格保持 w/h = ratio；
 * 靠近画布边缘时整体等比收缩，而不是把某一维截断后破坏比例。
 */
export function constrainDragRect(start, end, ratio, bounds) {
    const [width, height] = bounds;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const maxW = dx >= 0 ? width - start[0] : start[0];
    const maxH = dy >= 0 ? height - start[1] : start[1];
    let w, h;
    if (ratio > 0) {
        w = Math.max(Math.abs(dx), Math.abs(dy) * ratio);
        h = w / ratio;
        const scale = Math.min(1, maxW / Math.max(w, 1e-6), maxH / Math.max(h, 1e-6));
        w *= scale;
        h *= scale;
    } else {
        w = Math.min(Math.abs(dx), maxW);
        h = Math.min(Math.abs(dy), maxH);
    }
    const x0 = dx >= 0 ? start[0] : start[0] - w;
    const y0 = dy >= 0 ? start[1] : start[1] - h;
    return clampRect([x0, y0, x0 + w, y0 + h], bounds);
}

/** 整体平移选区，越界时贴边而不是缩小。 */
export function moveSelection(rect, delta, bounds) {
    const [width, height] = bounds;
    const w = rect[2] - rect[0];
    const h = rect[3] - rect[1];
    const x0 = Math.max(0, Math.min(width - w, rect[0] + delta[0]));
    const y0 = Math.max(0, Math.min(height - h, rect[1] + delta[1]));
    return [x0, y0, x0 + w, y0 + h];
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** 八向手柄缩放；锁定比例时统一按对角锚点等比约束。 */
export function resizeSelection(rect, handle, pointer, ratio, bounds) {
    const [width, height] = bounds;
    if (handle.length === 2) {
        const anchor = [handle.includes("w") ? rect[2] : rect[0], handle.includes("n") ? rect[3] : rect[1]];
        return constrainDragRect(anchor, pointer, ratio, bounds);
    }
    if (ratio > 0) {
        const anchor = [handle === "w" ? rect[2] : handle === "e" ? rect[0] : (rect[0] + rect[2]) / 2,
            handle === "n" ? rect[3] : handle === "s" ? rect[1] : (rect[1] + rect[3]) / 2];
        return constrainDragRect(anchor, pointer, ratio, bounds);
    }
    if (handle === "n") return [rect[0], clamp(pointer[1], 0, rect[3] - MIN_SELECTION), rect[2], rect[3]];
    if (handle === "s") return [rect[0], rect[1], rect[2], clamp(pointer[1], rect[1] + MIN_SELECTION, height)];
    if (handle === "w") return [clamp(pointer[0], 0, rect[2] - MIN_SELECTION), rect[1], rect[2], rect[3]];
    return [rect[0], rect[1], clamp(pointer[0], rect[0] + MIN_SELECTION, width), rect[3]];
}

/**
 * 反选语义：不把四块不连续区域硬拼成一张图，而是保留整张工作图，
 * 用 MASK 表达取反后的选区 —— 底色白（需要处理），原选区涂黑（保持原样）。
 */
export function inverseSelection(rect, bounds) {
    return { outputRect: [0, 0, bounds[0], bounds[1]], maskRect: clampRect(rect, bounds) };
}

/** 命中八个手柄（容差按画布显示尺寸给，返回手柄名或空串）。 */
export function hitHandle(rect, point, tolerance) {
    const [x0, y0, x1, y1] = rect;
    const near = (a, b) => Math.abs(a - b) <= tolerance;
    const horizontal = near(point[0], x0) ? "w" : near(point[0], x1) ? "e" : "";
    const vertical = near(point[1], y0) ? "n" : near(point[1], y1) ? "s" : "";
    if (horizontal && vertical) return vertical + horizontal;
    if (horizontal || vertical) return horizontal + vertical;
    return "";
}

export function rectSize(rect) {
    return [Math.max(1, Math.round(rect[2] - rect[0])), Math.max(1, Math.round(rect[3] - rect[1]))];
}
