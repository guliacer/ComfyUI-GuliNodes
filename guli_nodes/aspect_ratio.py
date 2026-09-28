import math

import torch
import torch.nn.functional as torch_F
import comfy.utils

try:
    from comfy_api.latest import io
except Exception:
    io = None

ASPECT_RATIOS = ["1:1", "3:2", "4:3", "5:4", "16:9", "21:9", "9:16", "2:3", "3:4", "4:5", "9:21"]
LATENT_ASPECT_RATIOS = [
    "1:1",
    "1:2",
    "2:3",
    "3:4",
    "4:5",
    "5:7",
    "9:16",
    "10:16",
    "9:21",
]
ASPECT_PRESETS = {
    ratio: tuple(int(part) for part in ratio.split(":", 1))
    for ratio in [*ASPECT_RATIOS, *LATENT_ASPECT_RATIOS]
}
SIDE_TYPES = ["最长边", "最短边"]
ORIENTATION_TYPES = ["横屏", "竖屏"]
RESOLUTION_OPTIONS = ["1K", "2K", "3K", "4K"]
RESOLUTION_EDGE_LENGTHS = {
    "1K": 1024,
    "2K": 2048,
    "3K": 3072,
    "4K": 4096,
}
LATENT_MODE_OPTIONS = ["按边长", "按K数分辨率", "按Latent接入", "按图像接入"]
IMAGE_RESIZE_METHODS = ["nearest-exact", "bilinear", "lanczos", "area", "bicubic"]

# GG 图像宽高 与 GG Latent 共用同一套接入方式，只是输出不同（宽高 vs Latent）。
ADAPTER_MODE_OPTIONS = list(LATENT_MODE_OPTIONS)
ADAPTER_MODE_INPUT = "宽高方式"
# 宽高节点保留原有的 3:2/16:9/21:9 等横向比例，同时补齐 Latent 侧的 1:2/5:7/10:16。
ADAPTER_ASPECT_RATIOS = list(dict.fromkeys([*ASPECT_RATIOS, *LATENT_ASPECT_RATIOS]))

def _preset_dimensions(
    width_ratio: int,
    height_ratio: int,
    resolution: str,
    align_to_eight,
) -> tuple[int, int]:
    long_edge = RESOLUTION_EDGE_LENGTHS[resolution]

    # Use the common digital/cinema K convention: K denotes the long edge.
    short_edge = round(long_edge * min(width_ratio, height_ratio) / max(width_ratio, height_ratio))
    if width_ratio >= height_ratio:
        width, height = long_edge, short_edge
    else:
        width, height = short_edge, long_edge
    return align_to_eight(width), align_to_eight(height)


def _dimensions_from_edge(
    width_ratio: int,
    height_ratio: int,
    edge: int,
    edge_type: str,
    align_to_eight,
) -> tuple[int, int]:
    """Calculate dimensions from the explicitly selected long or short edge."""
    edge = int(edge)
    if edge_type == "最短边":
        short_edge = edge
        long_edge = int(edge * max(width_ratio, height_ratio) / min(width_ratio, height_ratio))
    else:
        # Only an explicit "最短边" selects short-edge mode.  This keeps
        # legacy or malformed workflow values from silently reversing the behavior.
        long_edge = edge
        short_edge = int(edge * min(width_ratio, height_ratio) / max(width_ratio, height_ratio))

    if width_ratio >= height_ratio:
        width, height = long_edge, short_edge
    else:
        width, height = short_edge, long_edge
    return align_to_eight(width), align_to_eight(height)


def _positive_scale(value: float, name: str = "缩放倍率") -> float:
    try:
        scale = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name}必须是有效数字。") from exc
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError(f"{name}必须大于 0。")
    return scale


def _empty_latent(batch_size: int, width: int, height: int, device=None, dtype=torch.float32) -> dict:
    return {
        "samples": torch.zeros(
            [max(1, int(batch_size)), 4, max(1, int(height)) // 8, max(1, int(width)) // 8],
            device=device,
            dtype=dtype,
        )
    }


def _resize_input_latent(latent: dict, scale: float) -> dict:
    if not isinstance(latent, dict) or not isinstance(latent.get("samples"), torch.Tensor):
        raise ValueError("按Latent接入模式必须连接有效的 LATENT 输入。")

    samples = latent["samples"]
    if samples.ndim != 4:
        raise ValueError("LATENT 的 samples 必须是四维张量（批量、通道、高度、宽度）。")

    scale = _positive_scale(scale)
    target_height = max(1, round(samples.shape[-2] * scale))
    target_width = max(1, round(samples.shape[-1] * scale))
    if (target_height, target_width) == tuple(samples.shape[-2:]):
        resized = samples.clone()
    else:
        resized = torch_F.interpolate(
            samples,
            size=(target_height, target_width),
            mode="bilinear",
            align_corners=False,
        )

    result = dict(latent)
    result["samples"] = resized
    return result


def _latent_from_input_image(image: torch.Tensor, method: str, scale: float, align_to_eight) -> dict:
    if not isinstance(image, torch.Tensor) or image.ndim != 4:
        raise ValueError("按图像接入模式必须连接有效的 IMAGE 输入（批量、高度、宽度、通道）。")
    if method not in IMAGE_RESIZE_METHODS:
        raise ValueError(f"不支持的缩放方法「{method}」。")

    scale = _positive_scale(scale)
    _, source_height, source_width, _ = image.shape
    target_height = max(1, round(source_height * scale))
    target_width = max(1, round(source_width * scale))
    # The output remains an empty LATENT, but perform the requested pixel resize
    # so the method and multiplier are applied to the connected image data.
    resized = comfy.utils.common_upscale(
        image.movedim(-1, 1),
        target_width,
        target_height,
        method,
        "disabled",
    ).movedim(1, -1)
    width = align_to_eight(resized.shape[2])
    height = align_to_eight(resized.shape[1])
    return _empty_latent(resized.shape[0], width, height, device=resized.device, dtype=resized.dtype)


def _unpack_mode(value, mode_key: str):
    """拆开 DynamicCombo 的嵌套取值：返回 (方式, 该方式下的输入字典)。"""
    if isinstance(value, dict):
        nested = value.get(mode_key)
        if isinstance(nested, dict):
            mode = nested.get(mode_key, "按边长")
            return mode, nested
        return nested or "按边长", value
    return value or "按边长", {}


def _unpack_latent_mode(value):
    return _unpack_mode(value, "Latent方式")


def _generate_latent_by_mode(mode_value, align_to_eight, apply_orientation) -> dict:
    mode, values = _unpack_latent_mode(mode_value)
    if mode not in LATENT_MODE_OPTIONS:
        raise ValueError(f"不支持的 Latent 方式「{mode}」。")

    if mode == "按Latent接入":
        return _resize_input_latent(values.get("Latent"), values.get("缩放倍率", 1.0))

    if mode == "按图像接入":
        return _latent_from_input_image(
            values.get("图像"),
            values.get("缩放方法", "lanczos"),
            values.get("缩放倍率", 1.0),
            align_to_eight,
        )

    ratio = values.get("宽高比例", "9:16")
    batch_size = values.get("批量大小", 1)
    orientation = values.get("画面方向", "横屏")
    wr, hr = ASPECT_PRESETS[ratio]
    wr, hr = apply_orientation(wr, hr, orientation)

    if mode == "按K数分辨率":
        resolution = values.get("分辨率", "1K")
        if resolution not in RESOLUTION_EDGE_LENGTHS:
            resolution = "1K"
        width, height = _preset_dimensions(wr, hr, resolution, align_to_eight)
    else:
        width, height = _dimensions_from_edge(
            wr, hr, values.get("边长", 1024), values.get("边长类型", "最长边"), align_to_eight
        )
    return _empty_latent(batch_size, width, height)


def _latent_mode_inputs(io_module):
    return io_module.DynamicCombo.Input("Latent方式", options=[
        io_module.DynamicCombo.Option(key="按边长", inputs=[
            io_module.Combo.Input("宽高比例", options=LATENT_ASPECT_RATIOS, default="9:16"),
            io_module.Int.Input("边长", default=1024, min=64, max=8192, step=8),
            io_module.Combo.Input("边长类型", options=SIDE_TYPES, default="最长边"),
            io_module.Int.Input("批量大小", default=1, min=1, max=64),
            io_module.Combo.Input("画面方向", options=ORIENTATION_TYPES, default="横屏"),
        ]),
        io_module.DynamicCombo.Option(key="按K数分辨率", inputs=[
            io_module.Combo.Input("宽高比例", options=LATENT_ASPECT_RATIOS, default="9:16"),
            io_module.Int.Input("批量大小", default=1, min=1, max=64),
            io_module.Combo.Input("画面方向", options=ORIENTATION_TYPES, default="横屏"),
            io_module.Combo.Input("分辨率", options=RESOLUTION_OPTIONS, default="1K"),
        ]),
        io_module.DynamicCombo.Option(key="按Latent接入", inputs=[
            io_module.Latent.Input("Latent", tooltip="按输入 Latent 的空间尺寸和缩放倍率生成输出。"),
            io_module.Float.Input("缩放倍率", default=1.0, min=0.1, max=100.0, step=0.05),
        ]),
        io_module.DynamicCombo.Option(key="按图像接入", inputs=[
            io_module.Image.Input("图像", tooltip="按输入图像的实际宽高和缩放倍率生成输出 Latent。"),
            io_module.Combo.Input("缩放方法", options=IMAGE_RESIZE_METHODS, default="lanczos"),
            io_module.Float.Input("缩放倍率", default=1.0, min=0.1, max=100.0, step=0.05),
        ]),
    ])


def _legacy_latent_mode_inputs():
    return {
        "Latent方式": (LATENT_MODE_OPTIONS, {"default": "按边长"}),
        "宽高比例": (LATENT_ASPECT_RATIOS, {"default": "9:16"}),
        "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
        "边长类型": (SIDE_TYPES, {"default": "最长边"}),
        "批量大小": ("INT", {"default": 1, "min": 1, "max": 64}),
        "画面方向": (ORIENTATION_TYPES, {"default": "横屏"}),
        "分辨率": (RESOLUTION_OPTIONS, {"default": "1K"}),
        "Latent": ("LATENT",),
        "图像": ("IMAGE",),
        "缩放方法": (IMAGE_RESIZE_METHODS, {"default": "lanczos"}),
        "缩放倍率": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 100.0, "step": 0.05}),
    }


def _dimensions_from_latent(latent, scale: float, align_to_eight) -> tuple[int, int]:
    """按输入 Latent 的空间尺寸 ×8 换算成像素宽高（与 GG Latent 的按Latent接入一致）。"""
    if not isinstance(latent, dict) or not isinstance(latent.get("samples"), torch.Tensor):
        raise ValueError("按Latent接入模式必须连接有效的 LATENT 输入。")
    samples = latent["samples"]
    if samples.ndim != 4:
        raise ValueError("LATENT 的 samples 必须是四维张量（批量、通道、高度、宽度）。")

    scale = _positive_scale(scale)
    width = align_to_eight(max(1, round(samples.shape[-1] * scale)) * 8)
    height = align_to_eight(max(1, round(samples.shape[-2] * scale)) * 8)
    return width, height


def _dimensions_from_image(image, scale: float, align_to_eight) -> tuple[int, int]:
    """按输入图像的原始宽高 ×缩放倍率 得到像素宽高（与 GG Latent 的按图像接入一致）。

    这里只做尺寸推算，不实际重采样像素：缩放方法不改变目标尺寸，
    因此宽高节点在该方式下不展示「缩放方法」。
    """
    if not isinstance(image, torch.Tensor) or image.ndim != 4:
        raise ValueError("按图像接入模式必须连接有效的 IMAGE 输入（批量、高度、宽度、通道）。")

    scale = _positive_scale(scale)
    _, source_height, source_width, _ = image.shape
    width = align_to_eight(max(1, round(source_width * scale)))
    height = align_to_eight(max(1, round(source_height * scale)))
    return width, height


def _dimensions_by_mode(mode_value, align_to_eight, apply_orientation) -> tuple[int, int]:
    mode, values = _unpack_mode(mode_value, ADAPTER_MODE_INPUT)
    if mode not in ADAPTER_MODE_OPTIONS:
        raise ValueError(f"不支持的宽高方式「{mode}」。")

    if mode == "按Latent接入":
        return _dimensions_from_latent(values.get("Latent"), values.get("缩放倍率", 1.0), align_to_eight)

    if mode == "按图像接入":
        return _dimensions_from_image(values.get("图像"), values.get("缩放倍率", 1.0), align_to_eight)

    ratio = values.get("宽高比例", "16:9")
    if ratio not in ASPECT_PRESETS:
        raise ValueError(f"不支持的宽高比例「{ratio}」。")
    orientation = values.get("画面方向", "横屏")
    wr, hr = ASPECT_PRESETS[ratio]
    wr, hr = apply_orientation(wr, hr, orientation)

    if mode == "按K数分辨率":
        resolution = values.get("分辨率", "1K")
        if resolution not in RESOLUTION_EDGE_LENGTHS:
            resolution = "1K"
        return _preset_dimensions(wr, hr, resolution, align_to_eight)

    return _dimensions_from_edge(
        wr, hr, values.get("边长", 1024), values.get("边长类型", "最长边"), align_to_eight
    )


def _adapter_mode_inputs(io_module):
    return io_module.DynamicCombo.Input(ADAPTER_MODE_INPUT, options=[
        io_module.DynamicCombo.Option(key="按边长", inputs=[
            io_module.Combo.Input("宽高比例", options=ADAPTER_ASPECT_RATIOS, default="16:9"),
            io_module.Int.Input("边长", default=1024, min=64, max=8192, step=8),
            io_module.Combo.Input("边长类型", options=SIDE_TYPES, default="最长边"),
            io_module.Combo.Input("画面方向", options=ORIENTATION_TYPES, default="横屏"),
        ]),
        io_module.DynamicCombo.Option(key="按K数分辨率", inputs=[
            io_module.Combo.Input("宽高比例", options=ADAPTER_ASPECT_RATIOS, default="16:9"),
            io_module.Combo.Input("画面方向", options=ORIENTATION_TYPES, default="横屏"),
            io_module.Combo.Input("分辨率", options=RESOLUTION_OPTIONS, default="1K"),
        ]),
        io_module.DynamicCombo.Option(key="按Latent接入", inputs=[
            io_module.Latent.Input("Latent", tooltip="按输入 Latent 的空间尺寸和缩放倍率输出宽高。"),
            io_module.Float.Input("缩放倍率", default=1.0, min=0.1, max=100.0, step=0.05),
        ]),
        io_module.DynamicCombo.Option(key="按图像接入", inputs=[
            io_module.Image.Input("图像", tooltip="按输入图像的实际宽高和缩放倍率输出宽高。"),
            io_module.Float.Input("缩放倍率", default=1.0, min=0.1, max=100.0, step=0.05),
        ]),
    ])


def _legacy_adapter_mode_inputs():
    # 方式选择器只在上面的 INPUT_TYPES["required"] 里声明一次，这里不重复，
    # 否则 /object_info 会把同名键同时放进 required 和 optional，前端可能建出两个同名控件。
    return {
        "宽高比例": (ADAPTER_ASPECT_RATIOS, {"default": "16:9"}),
        "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
        "边长类型": (SIDE_TYPES, {"default": "最长边"}),
        "画面方向": (ORIENTATION_TYPES, {"default": "横屏"}),
        "分辨率": (RESOLUTION_OPTIONS, {"default": "1K"}),
        "Latent": ("LATENT",),
        "图像": ("IMAGE",),
        "缩放倍率": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 100.0, "step": 0.05}),
    }


if io is not None:

    class GGAspectRatioAdapter(io.ComfyNode):
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGAspectRatioAdapter",
                display_name="GG 图像宽高",
                category="GuliNodes/图像",
                description="按边长、K数分辨率、Latent 或图像接入方式计算宽高（已对齐到8的倍数）。",
                inputs=[
                    _adapter_mode_inputs(io),
                ],
                outputs=[
                    io.Int.Output(display_name="宽度", tooltip="计算后的宽度（已对齐到8的倍数）。"),
                    io.Int.Output(display_name="高度", tooltip="计算后的高度（已对齐到8的倍数）。"),
                ],
            )

        @classmethod
        def execute(cls, 宽高方式):
            width, height = _dimensions_by_mode(宽高方式, cls._align_to_eight, cls._apply_orientation)
            return io.NodeOutput(width, height)

    GGAspectRatioAdapter = GGAspectRatioAdapter


    class GGAspectRatioLatent(io.ComfyNode):
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGAspectRatioLatent",
                display_name="GG Latent",
                category="GuliNodes/潜空间",
                description="按边长、K数分辨率、Latent 或图像接入方式生成 Latent。",
                inputs=[
                    _latent_mode_inputs(io),
                ],
                outputs=[
                    io.Latent.Output(display_name="Latent", tooltip="生成的空Latent。"),
                ],
            )

        @classmethod
        def execute(cls, Latent方式):
            return io.NodeOutput(_generate_latent_by_mode(Latent方式, cls._align_to_eight, cls._apply_orientation))

    GGAspectRatioLatent = GGAspectRatioLatent


else:

    class GGAspectRatioAdapter:
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def INPUT_TYPES(s):
            return {
                "required": {
                    ADAPTER_MODE_INPUT: (ADAPTER_MODE_OPTIONS, {"default": "按边长"}),
                },
                "optional": _legacy_adapter_mode_inputs(),
            }

        RETURN_TYPES = ("INT", "INT")
        RETURN_NAMES = ("宽度", "高度")
        FUNCTION = "calculate"
        CATEGORY = "GuliNodes/图像"

        def calculate(self, 宽高方式: str = "按边长", **kwargs) -> tuple:
            kwargs[ADAPTER_MODE_INPUT] = 宽高方式
            return _dimensions_by_mode(kwargs, self._align_to_eight, self._apply_orientation)


    class GGAspectRatioLatent:
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def INPUT_TYPES(s):
            return {
                "required": {
                    "Latent方式": (LATENT_MODE_OPTIONS, {"default": "按边长"}),
                },
                "optional": _legacy_latent_mode_inputs(),
            }

        RETURN_TYPES = ("LATENT",)
        FUNCTION = "generate"
        CATEGORY = "GuliNodes/潜空间"

        def generate(self, Latent方式: str = "按边长", **kwargs) -> tuple:
            kwargs["Latent方式"] = Latent方式
            return (_generate_latent_by_mode(kwargs, self._align_to_eight, self._apply_orientation),)


NODE_CLASS_MAPPINGS = {
    "GGAspectRatioAdapter": GGAspectRatioAdapter,
    "GGAspectRatioLatent": GGAspectRatioLatent,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGAspectRatioAdapter": "GG 图像宽高",
    "GGAspectRatioLatent": "GG Latent",
}
