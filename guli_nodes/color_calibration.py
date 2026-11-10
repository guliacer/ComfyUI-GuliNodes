"""根据原图与编辑图的可靠区域校准编辑结果的颜色与对比度。"""

import torch
import torch.nn.functional as torch_F

try:
    from comfy_api.latest import io
except Exception:
    io = None


_MIN_ANCHOR_RATIO = 0.02


def _batch_image(image):
    if image is None:
        raise ValueError("图像不能为空：请连接 IMAGE 输入。")
    if not isinstance(image, torch.Tensor) or image.ndim not in (3, 4):
        raise ValueError("图像输入必须是 ComfyUI IMAGE 格式（批次、高度、宽度、通道）。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.shape[1] < 1 or image.shape[2] < 1 or image.shape[3] < 1:
        raise ValueError("图像尺寸为空，无法进行颜色校准。")
    return image.float()


def _rgb_alpha(image):
    if image.shape[-1] >= 4:
        return image[..., :3], image[..., 3:4]
    if image.shape[-1] == 3:
        return image, None
    if image.shape[-1] == 1:
        return image.expand(*image.shape[:-1], 3), None
    return image[..., :1].expand(*image.shape[:-1], 3), None


def _match_batch(image, batch):
    if image.shape[0] == 1 and batch > 1:
        return image.expand(batch, -1, -1, -1)
    if image.shape[0] != batch:
        raise ValueError(f"原始图像与编辑图像的批次不一致（{image.shape[0]} 与 {batch}）。")
    return image


def _resize(image, height, width, mode="bilinear"):
    return torch_F.interpolate(
        image.movedim(-1, 1), size=(height, width), mode=mode,
        align_corners=False if mode in ("bilinear", "bicubic") else None,
    ).movedim(1, -1)


def _prepare_mask(mask, batch, height, width):
    if mask is None:
        return None
    if not isinstance(mask, torch.Tensor):
        raise ValueError("遮罩输入必须是 ComfyUI MASK 张量。")
    mask = mask.float()
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    elif mask.ndim == 4:
        if mask.shape[1] == 1:
            mask = mask[:, 0]
        elif mask.shape[-1] == 1:
            mask = mask[..., 0]
        else:
            raise ValueError("遮罩输入必须是 批次×高度×宽度，不能包含多个通道。")
    if mask.ndim != 3:
        raise ValueError(f"遮罩输入维度不正确：得到 {mask.ndim} 维，需要 2 或 3 维 MASK。")
    if mask.shape[0] == 1 and batch > 1:
        mask = mask.expand(batch, -1, -1)
    elif mask.shape[0] != batch:
        raise ValueError(f"遮罩批次（{mask.shape[0]}）与图像批次（{batch}）不一致。")
    if mask.shape[1:] != (height, width):
        mask = _resize(mask.unsqueeze(-1), height, width)[..., 0]
    return mask.clamp(0.0, 1.0).unsqueeze(-1)


def _odd_kernel(size):
    size = max(1, int(size))
    return size if size % 2 else size + 1


def _morph_open(mask, size):
    size = int(size)
    if size <= 1:
        return mask
    size = _odd_kernel(size)
    values = mask.movedim(-1, 1)
    values = -torch_F.max_pool2d(-values, kernel_size=size, stride=1, padding=size // 2)
    values = torch_F.max_pool2d(values, kernel_size=size, stride=1, padding=size // 2)
    return values.movedim(1, -1)


def _morph_close(mask, size):
    size = int(size)
    if size <= 1:
        return mask
    size = _odd_kernel(size)
    values = mask.movedim(-1, 1)
    values = torch_F.max_pool2d(values, kernel_size=size, stride=1, padding=size // 2)
    values = -torch_F.max_pool2d(-values, kernel_size=size, stride=1, padding=size // 2)
    return values.movedim(1, -1)


def _dilate(mask, radius):
    radius = int(radius)
    if radius <= 0:
        return mask
    size = _odd_kernel(radius)
    values = torch_F.max_pool2d(
        mask.movedim(-1, 1), kernel_size=size, stride=1, padding=size // 2,
    )
    return values.movedim(1, -1)


def _auto_mask(original, edited, threshold, expand, open_size, close_size):
    difference = (original - edited).abs().amax(dim=-1, keepdim=True)
    mask = (difference > float(threshold)).float()
    mask = _morph_open(mask, open_size)
    mask = _morph_close(mask, close_size)
    return _dilate(mask, expand).clamp(0.0, 1.0)


def _gaussian_blur(image, sigma=2.0):
    if sigma <= 0:
        return image
    size = int(torch.ceil(torch.tensor(float(sigma) * 3.0)).item()) * 2 + 1
    positions = torch.arange(size, device=image.device, dtype=image.dtype) - size // 2
    kernel = torch.exp(-(positions.square()) / (2.0 * sigma * sigma))
    kernel = kernel / kernel.sum()
    values = image.movedim(-1, 1)
    channels = values.shape[1]
    horizontal = kernel.view(1, 1, 1, size).repeat(channels, 1, 1, 1)
    vertical = kernel.view(1, 1, size, 1).repeat(channels, 1, 1, 1)
    values = torch_F.conv2d(torch_F.pad(values, (size // 2, size // 2, 0, 0), mode="replicate"), horizontal, groups=channels)
    values = torch_F.conv2d(torch_F.pad(values, (0, 0, size // 2, size // 2), mode="replicate"), vertical, groups=channels)
    return values.movedim(1, -1)


def _low_frequency_merge(original, corrected, mask, feather):
    soft_mask = _feather(mask, feather) if feather > 0 else mask
    low_original = _gaussian_blur(_gaussian_blur(_gaussian_blur(original)))
    low_corrected = _gaussian_blur(_gaussian_blur(_gaussian_blur(corrected)))
    return (corrected + (1.0 - soft_mask) * (low_original - low_corrected)).clamp(0.0, 1.0)


def _feather(mask, radius):
    radius = int(radius)
    if radius <= 0:
        return mask
    # 采用平均池化做轻量羽化，不引入额外依赖；核大小限制在 127 以内。
    kernel = min(127, max(3, radius * 2 + 1))
    if kernel % 2 == 0:
        kernel -= 1
    result = torch_F.avg_pool2d(
        mask.movedim(-1, 1), kernel_size=kernel, stride=1, padding=kernel // 2,
    )
    return result.movedim(1, -1).clamp(0.0, 1.0)


def _weighted_affine(original, edited, anchor):
    """在遮罩外按通道匹配均值和标准差，返回 scale、shift。"""
    weights = anchor.reshape(-1)
    total = weights.sum()
    scale = torch.ones(3, device=original.device, dtype=original.dtype)
    shift = torch.zeros(3, device=original.device, dtype=original.dtype)
    if float(total) < 32:
        return scale, shift
    for channel in range(3):
        source = edited[..., channel].reshape(-1)
        target = original[..., channel].reshape(-1)
        source_mean = (weights * source).sum() / total
        target_mean = (weights * target).sum() / total
        source_var = (weights * (source - source_mean).square()).sum() / total
        target_var = (weights * (target - target_mean).square()).sum() / total
        source_std = source_var.clamp_min(1e-12).sqrt()
        target_std = target_var.clamp_min(1e-12).sqrt()
        if float(source_std) < 1e-4:
            scale[channel] = 1.0
            shift[channel] = target_mean - source_mean
        else:
            scale[channel] = (target_std / source_std).clamp(0.5, 2.0)
            shift[channel] = target_mean - scale[channel] * source_mean
    return scale, shift


def _contrast_anchor(original, corrected, anchor):
    """按遮罩外灰度分位范围，回压编辑图整体动态范围。"""
    result = corrected.clone()
    for index in range(original.shape[0]):
        weights = anchor[index, ..., 0].reshape(-1)
        if float(weights.sum()) < 32:
            continue
        source = corrected[index].mean(dim=-1).reshape(-1)
        target = original[index].mean(dim=-1).reshape(-1)
        valid = weights > 0
        if int(valid.sum()) < 32:
            continue
        source_values = source[valid]
        target_values = target[valid]
        source_low, source_high = torch.quantile(source_values, torch.tensor([0.005, 0.995], device=source.device))
        target_low, target_high = torch.quantile(target_values, torch.tensor([0.005, 0.995], device=target.device))
        source_span = source_high - source_low
        target_span = target_high - target_low
        if float(source_span) < 1e-3 or float(target_span) < 1e-3:
            continue
        factor = (source_span / target_span).clamp(0.3, 3.0)
        result[index] = ((corrected[index] - source_low) / factor + source_low).clamp(0.0, 1.0)
    return result


def _calibrate(original, edited, threshold, expand, open_size, close_size, feather, strength, outside_mode, mask=None):
    original = _batch_image(original)
    edited = _batch_image(edited)
    batch = max(original.shape[0], edited.shape[0])
    original = _match_batch(original, batch)
    edited = _match_batch(edited, batch)
    original_rgb, original_alpha = _rgb_alpha(original)
    edited_rgb, edited_alpha = _rgb_alpha(edited)
    height, width = edited_rgb.shape[1:3]
    if original_rgb.shape[1:3] != (height, width):
        original_rgb = _resize(original_rgb, height, width)
        if original_alpha is not None:
            original_alpha = _resize(original_alpha, height, width, "nearest")
    original_rgb = original_rgb.clamp(0.0, 1.0)
    edited_rgb = edited_rgb.clamp(0.0, 1.0)
    change_mask = _prepare_mask(mask, batch, height, width)
    if change_mask is None:
        change_mask = _auto_mask(original_rgb, edited_rgb, threshold, expand, open_size, close_size)
    change_mask = change_mask.clamp(0.0, 1.0)
    anchor = 1.0 - (change_mask > 0.5).float()
    changed_ratio = float(change_mask.mean())
    anchor_ratio = float(anchor.mean())
    if anchor_ratio >= _MIN_ANCHOR_RATIO:
        scale, shift = _weighted_affine(original_rgb, edited_rgb, anchor)
        corrected = (edited_rgb * scale.view(1, 1, 1, 3) + shift.view(1, 1, 1, 3)).clamp(0.0, 1.0)
        corrected = edited_rgb.lerp(corrected, max(0.0, min(1.0, float(strength))))
        corrected = _contrast_anchor(original_rgb, corrected, anchor)
    else:
        corrected = edited_rgb
    blend_mask = _feather(change_mask, feather)
    if outside_mode == "还原原图":
        result_rgb = blend_mask * corrected + (1.0 - blend_mask) * original_rgb
    else:
        # 对应 BlueBox 的 edited 模式：遮罩外使用原图低频、编辑图高频，保留纹理细节。
        result_rgb = _low_frequency_merge(original_rgb, corrected, change_mask, feather)
    alpha = edited_alpha if edited_alpha is not None else original_alpha
    result = torch.cat([result_rgb, alpha], dim=-1) if alpha is not None else result_rgb
    return result.clamp(0.0, 1.0).contiguous(), change_mask[..., 0].contiguous(), changed_ratio


class GG颜色校准:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "原始图像": ("IMAGE",),
                "编辑图像": ("IMAGE",),
                "差异阈值": ("FLOAT", {"default": 0.08, "min": 0.0, "max": 1.0, "step": 0.01}),
                "遮罩扩展": ("INT", {"default": 48, "min": 0, "max": 128, "step": 1}),
                "开运算核": ("INT", {"default": 13, "min": 1, "max": 81, "step": 2}),
                "闭运算核": ("INT", {"default": 15, "min": 1, "max": 81, "step": 2}),
                "边缘羽化": ("INT", {"default": 24, "min": 0, "max": 128, "step": 1}),
                "校准强度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "遮罩外处理": (["保留编辑图", "还原原图"], {"default": "保留编辑图"}),
            },
            "optional": {"遮罩": ("MASK",)},
        }

    RETURN_TYPES = ("IMAGE", "MASK", "FLOAT")
    RETURN_NAMES = ("校准图像", "变化遮罩", "变化比例")
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像"
    DESCRIPTION = "根据原始图像与编辑图像的未变化区域校准颜色、亮度和对比度；未连接遮罩时自动检测变化区域。"

    def execute(self, 原始图像, 编辑图像, 差异阈值=0.08, 遮罩扩展=48, 开运算核=13, 闭运算核=15,
                边缘羽化=24, 校准强度=1.0, 遮罩外处理="保留编辑图", 遮罩=None):
        return _calibrate(原始图像, 编辑图像, 差异阈值, 遮罩扩展, 开运算核, 闭运算核,
                          边缘羽化, 校准强度, 遮罩外处理, 遮罩)


if io is not None:
    class GG颜色校准_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GG颜色校准",
                display_name="GG 颜色校准",
                category="GuliNodes/图像",
                description="根据原始图像与编辑图像的未变化区域校准颜色、亮度和对比度；未连接遮罩时自动检测变化区域。",
                inputs=[
                    io.Image.Input("原始图像"),
                    io.Image.Input("编辑图像"),
                    io.Float.Input("差异阈值", default=0.08, min=0.0, max=1.0, step=0.01),
                    io.Int.Input("遮罩扩展", default=48, min=0, max=128, step=1),
                    io.Int.Input("开运算核", default=13, min=1, max=81, step=2),
                    io.Int.Input("闭运算核", default=15, min=1, max=81, step=2),
                    io.Int.Input("边缘羽化", default=24, min=0, max=128, step=1),
                    io.Float.Input("校准强度", default=1.0, min=0.0, max=1.0, step=0.05),
                    io.Combo.Input("遮罩外处理", options=["保留编辑图", "还原原图"], default="保留编辑图"),
                    io.Mask.Input("遮罩", optional=True),
                ],
                outputs=[
                    io.Image.Output("校准图像"),
                    io.Mask.Output("变化遮罩"),
                    io.Float.Output("变化比例"),
                ],
            )

        @classmethod
        def execute(cls, 原始图像, 编辑图像, 差异阈值=0.08, 遮罩扩展=48, 开运算核=13, 闭运算核=15,
                    边缘羽化=24, 校准强度=1.0, 遮罩外处理="保留编辑图", 遮罩=None):
            return io.NodeOutput(*_calibrate(原始图像, 编辑图像, 差异阈值, 遮罩扩展, 开运算核,
                                             闭运算核, 边缘羽化, 校准强度, 遮罩外处理, 遮罩))

    GG颜色校准 = GG颜色校准_V3


NODE_CLASS_MAPPINGS = {"GG颜色校准": GG颜色校准}
NODE_DISPLAY_NAME_MAPPINGS = {"GG颜色校准": "GG 颜色校准"}
