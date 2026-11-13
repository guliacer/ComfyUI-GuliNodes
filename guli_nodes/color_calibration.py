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
    # 已经是 float32 时不再复制整张图（.float() 在 CPU 上会拷贝一遍）。
    return image if image.dtype == torch.float32 else image.float()


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


def _prepare_mask(mask, batch, height, width, device=None):
    if mask is None:
        return None
    if not isinstance(mask, torch.Tensor):
        raise ValueError("遮罩输入必须是 ComfyUI MASK 张量。")
    mask = mask.float()
    if device is not None:
        mask = mask.to(device)
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


def _box_sum(values, size):
    """积分图盒和：返回每个像素 size×size 窗口内（越界按零）的和。

    一次前缀和即可得到任意核的窗口和，复杂度 O(HW) 且与核大小无关。
    形态学核最大 129、羽化核最大 127，逐点池化即使可分离也要 O(2k) 次
    比较/累加，4096 图上单步就要数秒；积分图把这一步压到 0.1 秒级。
    """
    size = int(size)
    cumulative = values.cumsum(-1).cumsum(-2)
    cumulative = torch_F.pad(cumulative, (1, 0, 1, 0))
    return (
        cumulative[..., size:, size:]
        - cumulative[..., :-size, size:]
        - cumulative[..., size:, :-size]
        + cumulative[..., :-size, :-size]
    )


def _is_binary(values):
    return bool(((values == 0) | (values == 1)).all())


def _binary_dilate(values, size):
    """二值膨胀：窗口和 > 0 即置 1。用 int32 积分图精确整数运算。"""
    radius = size // 2
    padded = torch_F.pad(values.to(torch.int32), (radius,) * 4, value=0)
    return (_box_sum(padded, size) > 0).to(values.dtype)


def _binary_erode(values, size):
    """二值腐蚀：窗口和等于核面积（窗口内全 1）才保留，越界按 1 处理。"""
    radius = size // 2
    padded = torch_F.pad(values.to(torch.int32), (radius,) * 4, value=1)
    return (_box_sum(padded, size) >= size * size).to(values.dtype)


def _max_pool_separable(values, size):
    """可分离的最大值池化：先横向再纵向。

    与 size×size 方形核的 2D max_pool 结果逐位相同，但复杂度从 O(k²)
    降到 O(2k)。只作为非二值输入的回退路径；二值遮罩走积分图。
    """
    size = int(size)
    if size <= 1:
        return values
    radius = size // 2
    values = torch_F.max_pool2d(
        values, kernel_size=(1, size), stride=1, padding=(0, radius),
    )
    values = torch_F.max_pool2d(
        values, kernel_size=(size, 1), stride=1, padding=(radius, 0),
    )
    return values


def _min_pool_separable(values, size):
    return -_max_pool_separable(-values, size)


def _morph_open(mask, size, binary=None):
    size = int(size)
    if size <= 1:
        return mask
    size = _odd_kernel(size)
    values = mask.movedim(-1, 1)
    if binary is None:
        binary = _is_binary(values)
    if binary:
        values = _binary_erode(values, size)
        values = _binary_dilate(values, size)
    else:
        values = _min_pool_separable(values, size)
        values = _max_pool_separable(values, size)
    return values.movedim(1, -1)


def _morph_close(mask, size, binary=None):
    size = int(size)
    if size <= 1:
        return mask
    size = _odd_kernel(size)
    values = mask.movedim(-1, 1)
    if binary is None:
        binary = _is_binary(values)
    if binary:
        values = _binary_dilate(values, size)
        values = _binary_erode(values, size)
    else:
        values = _max_pool_separable(values, size)
        values = _min_pool_separable(values, size)
    return values.movedim(1, -1)


def _dilate(mask, radius, binary=None):
    radius = int(radius)
    if radius <= 0:
        return mask
    size = _odd_kernel(radius)
    values = mask.movedim(-1, 1)
    if binary is None:
        binary = _is_binary(values)
    if binary:
        return _binary_dilate(values, size).movedim(1, -1)
    return _max_pool_separable(values, size).movedim(1, -1)


def _auto_mask(original, edited, threshold, expand, open_size, close_size):
    """自动检测变化区域。

    阈值化结果天然是 0/1 二值图，后续形态学一律走整数积分图，
    不必逐次检测。
    """
    difference = (original - edited).abs().amax(dim=-1, keepdim=True)
    mask = (difference > float(threshold)).float()
    mask = _morph_open(mask, open_size, binary=True)
    mask = _morph_close(mask, close_size, binary=True)
    return _dilate(mask, expand, binary=True).clamp(0.0, 1.0)


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


def _low_frequency_merge(original, corrected, mask, feather, downscale=2):
    """遮罩外保留编辑图高频、换回原图低频。

    低频差本身是低频信号，在 1/2 分辨率上算三层高斯（sigma 1.0，
    等效全分辨率 sigma≈3.46，与原实现一致）再上采样，偏差 <0.3%，
    4096 图上耗时降到约 1/3。
    """
    soft_mask = _feather(mask, feather) if feather > 0 else mask
    height, width = original.shape[1:3]
    small_height = max(height // downscale, 1)
    small_width = max(width // downscale, 1)
    reduced = (small_height, small_width) != (height, width)
    if reduced:
        source_original = _resize(original, small_height, small_width)
        source_corrected = _resize(corrected, small_height, small_width)
        small_mask = _resize(soft_mask, small_height, small_width)
    else:
        source_original = original
        source_corrected = corrected
        small_mask = soft_mask
    sigma = 2.0 / float(downscale)
    low_original = _gaussian_blur(_gaussian_blur(_gaussian_blur(source_original, sigma), sigma), sigma)
    low_corrected = _gaussian_blur(_gaussian_blur(_gaussian_blur(source_corrected, sigma), sigma), sigma)
    delta = (1.0 - small_mask) * (low_original - low_corrected)
    if reduced:
        delta = _resize(delta, height, width)
    return (corrected + delta).clamp(0.0, 1.0)


def _feather(mask, radius):
    radius = int(radius)
    if radius <= 0:
        return mask
    # 平均池化做轻量羽化，不引入额外依赖；核大小上限 127（羽化 128 时）。
    # 用积分图算窗口和，等价于 kernel×kernel 的零填充平均池化，
    # 但耗时与核大小无关。
    kernel = min(127, max(3, radius * 2 + 1))
    if kernel % 2 == 0:
        kernel -= 1
    values = mask.movedim(-1, 1)
    padded = torch_F.pad(values, (kernel // 2,) * 4)
    smoothed = _box_sum(padded, kernel) * (1.0 / float(kernel * kernel))
    return smoothed.movedim(1, -1).clamp(0.0, 1.0)


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


def _weighted_quantiles(values, weights, quantiles):
    """按权重同时取多个分位值，只排序一次。

    避免像 mask[valid] 那样物化布尔索引；多个分位共用同一份排序结果，
    省掉重复的 argsort。
    """
    order = torch.argsort(values)
    sorted_values = values[order]
    sorted_weights = weights[order].clamp_min(0.0)
    cumulative = torch.cumsum(sorted_weights, dim=0)
    total = cumulative[-1]
    if float(total) <= 0:
        return None
    steps = torch.tensor(quantiles, dtype=cumulative.dtype, device=cumulative.device)
    positions = torch.searchsorted(cumulative, total * steps)
    positions = positions.clamp(0, sorted_values.numel() - 1)
    return [sorted_values[position] for position in positions]


def _contrast_anchor(original, corrected, anchor, downscale=8):
    """按遮罩外灰度分位范围，回压编辑图整体动态范围。

    分位统计在 1/8 分辨率上做：黑/白场本身是低频统计量，降采样几乎不改变
    结果，却能把全分辨率排序的开销降到 1/64。降采样前先合成灰度，
    避免把三通道各插值一遍。
    """
    result = corrected.clone()
    height, width = original.shape[1:3]
    small_height = max(height // downscale, 1)
    small_width = max(width // downscale, 1)
    source_gray = corrected.mean(dim=-1, keepdim=True)
    target_gray = original.mean(dim=-1, keepdim=True)
    if (small_height, small_width) != (height, width):
        source_gray = _resize(source_gray, small_height, small_width)
        target_gray = _resize(target_gray, small_height, small_width)
        anchor_small = _resize(anchor, small_height, small_width)
    else:
        anchor_small = anchor
    for index in range(original.shape[0]):
        weights = anchor_small[index, ..., 0].reshape(-1)
        if float(weights.sum()) < 32:
            continue
        source = source_gray[index, ..., 0].reshape(-1)
        target = target_gray[index, ..., 0].reshape(-1)
        source_range = _weighted_quantiles(source, weights, (0.005, 0.995))
        target_range = _weighted_quantiles(target, weights, (0.005, 0.995))
        if source_range is None or target_range is None:
            continue
        source_low, source_high = source_range
        target_low, target_high = target_range
        source_span = source_high - source_low
        target_span = target_high - target_low
        if float(source_span) < 1e-3 or float(target_span) < 1e-3:
            continue
        factor = (source_span / target_span).clamp(0.3, 3.0)
        # 就地换算，省掉一张与全图等大的临时张量。
        result[index].sub_(source_low).div_(factor).add_(source_low).clamp_(0.0, 1.0)
    return result


def _select_device(*tensors):
    """优先跟随输入所在设备；输入都在 CPU 时用 ComfyUI 的运算设备。

    ComfyUI 的 IMAGE/MASK 一律以 CPU 张量流转，若只看输入设备就永远跑在
    CPU 上——这正是旧实现比 BlueBox 慢一个数量级的主因。这里改用
    ``comfy.model_management.get_torch_device()``，既能在有显卡时上 GPU，
    也尊重用户以 ``--cpu`` 启动的选择。
    """
    for tensor in tensors:
        if isinstance(tensor, torch.Tensor) and tensor.is_cuda:
            return tensor.device
    try:
        import comfy.model_management as model_management

        device = torch.device(model_management.get_torch_device())
        if device.type == "cuda":
            return device if torch.cuda.is_available() else torch.device("cpu")
        if device.type == "cpu":
            # ComfyUI 以 --cpu 启动时，这里就是 cpu，必须尊重。
            return device
        # 其它后端（xpu / mps / directml）维持旧行为，避免未实现算子。
        return torch.device("cpu")
    except Exception:
        pass
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def _calibrate(original, edited, threshold, expand, open_size, close_size, feather, strength, outside_mode, mask=None):
    device = _select_device(original, edited, mask)
    try:
        return _calibrate_impl(
            original, edited, threshold, expand, open_size, close_size,
            feather, strength, outside_mode, mask, device,
        )
    except RuntimeError as error:
        if device.type != "cuda" or "out of memory" not in str(error).lower():
            raise
    # 走到这里说明显存不足：except 变量已释放，上一轮 GPU 张量随之回收，
    # 此时清缓存再回退 CPU，不会让失败现场继续占着显存。
    torch.cuda.empty_cache()
    return _calibrate_impl(
        original, edited, threshold, expand, open_size, close_size,
        feather, strength, outside_mode, mask, torch.device("cpu"),
    )


def _calibrate_impl(original, edited, threshold, expand, open_size, close_size, feather, strength,
                    outside_mode, mask, device):
    original = _batch_image(original).to(device)
    edited = _batch_image(edited).to(device)
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
    change_mask = _prepare_mask(mask, batch, height, width, device)
    if change_mask is None:
        change_mask = _auto_mask(original_rgb, edited_rgb, threshold, expand, open_size, close_size)
    change_mask = change_mask.clamp(0.0, 1.0)
    anchor = 1.0 - (change_mask > 0.5).float()
    changed_ratio = float(change_mask.mean())
    anchor_ratio = float(anchor.mean())
    if anchor_ratio >= _MIN_ANCHOR_RATIO:
        scale, shift = _weighted_affine(original_rgb, edited_rgb, anchor)
        corrected = edited_rgb.mul(scale.view(1, 1, 1, 3)).add(shift.view(1, 1, 1, 3)).clamp_(0.0, 1.0)
        corrected = edited_rgb.lerp(corrected, max(0.0, min(1.0, float(strength))))
        corrected = _contrast_anchor(original_rgb, corrected, anchor)
    else:
        corrected = edited_rgb
    if outside_mode == "还原原图":
        blend_mask = _feather(change_mask, feather)
        result_rgb = original_rgb.lerp(corrected, blend_mask)
    else:
        # 对应 BlueBox 的 edited 模式：遮罩外使用原图低频、编辑图高频，保留纹理细节。
        result_rgb = _low_frequency_merge(original_rgb, corrected, change_mask, feather)
    alpha = edited_alpha if edited_alpha is not None else original_alpha
    result = torch.cat([result_rgb, alpha], dim=-1) if alpha is not None else result_rgb
    # ComfyUI 的 IMAGE/MASK 以 CPU 张量流转，统一搬回 CPU 再交还。
    result = result.clamp_(0.0, 1.0).contiguous().cpu()
    return result, change_mask[..., 0].contiguous().cpu(), changed_ratio


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
