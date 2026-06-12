from __future__ import annotations

import importlib
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

try:
    from comfy_api.latest import io
except Exception:
    io = None


NODE_ID = "GGSeedVR2VideoUpscaler"
DISPLAY_NAME = "GG SeedVR2视频放大器"
CATEGORY = "GuliNodes/视频"
SEEDVR2_PACKAGE = "ComfyUI-SeedVR2_VideoUpscaler"

DEFAULT_DIT = "seedvr2_ema_7b-Q8_K_M.gguf"
DEFAULT_VAE = "ema_vae_fp16.safetensors"
DEFAULT_SEED = 2147483647
DEFAULT_RESOLUTION = 2048
DEFAULT_BATCH_SIZE = 5
DEFAULT_TILE_SIZE = 1024
DEFAULT_TILE_OVERLAP = 128

ATTENTION_OPTIONS = ["sdpa", "flash_attn_2", "flash_attn_3", "sageattn_2", "sageattn_3"]
COMPILE_BACKENDS = ["inductor", "cudagraphs"]
COMPILE_MODES = ["default", "reduce-overhead", "max-autotune", "max-autotune-no-cudagraphs"]
TILE_DEBUG_OPTIONS = ["关闭", "编码", "解码"]
TILE_DEBUG_TO_SOURCE = {
    "关闭": "false",
    "编码": "encode",
    "解码": "decode",
    "false": "false",
    "encode": "encode",
    "decode": "decode",
}
COLOR_OPTIONS = ["无", "Lab", "Wavelet", "自适应Wavelet", "HSV", "AdaIN"]
COLOR_TO_SOURCE = {
    "无": "none",
    "Lab": "lab",
    "Wavelet": "wavelet",
    "自适应Wavelet": "wavelet_adaptive",
    "HSV": "hsv",
    "AdaIN": "adain",
    "none": "none",
    "lab": "lab",
    "wavelet": "wavelet",
    "wavelet_adaptive": "wavelet_adaptive",
    "hsv": "hsv",
    "adain": "adain",
}


def _custom_nodes_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def _ensure_seedvr2_path() -> None:
    custom_nodes = str(_custom_nodes_dir())
    if custom_nodes not in sys.path:
        sys.path.insert(0, custom_nodes)


def _import_seedvr2_module(module_path: str):
    _ensure_seedvr2_path()
    try:
        return importlib.import_module(module_path)
    except ModuleNotFoundError as exc:
        missing = exc.name or module_path
        raise RuntimeError(
            f"无法加载 SeedVR2 插件或依赖 `{missing}`。请确认已安装 `{SEEDVR2_PACKAGE}` 并重启 ComfyUI。"
        ) from exc
    except Exception as exc:
        raise RuntimeError(f"加载 SeedVR2 插件失败：{exc}") from exc


@lru_cache(maxsize=1)
def _seedvr2_interfaces():
    return _import_seedvr2_module(f"{SEEDVR2_PACKAGE}.src.interfaces")


@lru_cache(maxsize=1)
def _seedvr2_registry():
    return _import_seedvr2_module(f"{SEEDVR2_PACKAGE}.src.utils.model_registry")


@lru_cache(maxsize=1)
def _seedvr2_memory():
    return _import_seedvr2_module(f"{SEEDVR2_PACKAGE}.src.optimization.memory_manager")


def _safe_options(load_options: Callable[[], list[Any]], fallback: list[str]) -> list[str]:
    try:
        options = [str(option) for option in load_options() if str(option)]
    except Exception:
        options = []
    return options or fallback


def _default_dit_name() -> str:
    try:
        return str(getattr(_seedvr2_registry(), "DEFAULT_DIT", DEFAULT_DIT))
    except Exception:
        return DEFAULT_DIT


def _default_vae_name() -> str:
    try:
        return str(getattr(_seedvr2_registry(), "DEFAULT_VAE", DEFAULT_VAE))
    except Exception:
        return DEFAULT_VAE


def _dit_models() -> list[str]:
    return _safe_options(
        lambda: _seedvr2_registry().get_available_dit_models(),
        [DEFAULT_DIT],
    )


def _vae_models() -> list[str]:
    return _safe_options(
        lambda: _seedvr2_registry().get_available_vae_models(),
        [DEFAULT_VAE],
    )


def _devices() -> list[str]:
    options = _safe_options(lambda: _seedvr2_memory().get_device_list(), [])
    if options:
        return options

    try:
        import torch

        if torch.cuda.is_available():
            return [f"cuda:{index}" for index in range(torch.cuda.device_count())]
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return ["mps"]
    except Exception:
        pass
    return ["cpu"]


def _offload_devices() -> list[str]:
    options = _safe_options(
        lambda: _seedvr2_memory().get_device_list(include_none=True, include_cpu=True),
        [],
    )
    if options:
        return options
    devices = _devices()
    merged = ["none", "cpu", *devices]
    return list(dict.fromkeys(merged))


def _default_from(options: list[str], preferred: str) -> str:
    return preferred if preferred in options else options[0]


def _default_device() -> str:
    devices = _devices()
    return _default_from(devices, "cuda:0")


def _default_offload_device() -> str:
    offload_devices = _offload_devices()
    if "cpu" in offload_devices:
        return "cpu"
    if "none" in offload_devices:
        return "none"
    return offload_devices[0]


def _to_int(名称: str, value: Any, minimum: int | None = None, maximum: int | None = None) -> int:
    try:
        result = int(value)
    except Exception as exc:
        raise ValueError(f"{名称}必须是整数。") from exc
    if minimum is not None:
        result = max(minimum, result)
    if maximum is not None:
        result = min(maximum, result)
    return result


def _to_float(名称: str, value: Any, minimum: float | None = None, maximum: float | None = None) -> float:
    try:
        result = float(value)
    except Exception as exc:
        raise ValueError(f"{名称}必须是数字。") from exc
    if minimum is not None:
        result = max(minimum, result)
    if maximum is not None:
        result = min(maximum, result)
    return result


def _even_int(名称: str, value: Any, minimum: int = 0, maximum: int = 16384) -> int:
    result = _to_int(名称, value, minimum=minimum, maximum=maximum)
    if result > 0 and result % 2:
        result = result - 1 if result > minimum else result + 1
    return result


def _normalize_choice(value: Any, options: list[str], default: str) -> str:
    text = str(value or default)
    return text if text in options else default


def _normalize_batch_size(value: Any, 自动修正: bool = True) -> int:
    size = _to_int("批次大小", value, minimum=1, maximum=16384)
    if (size - 1) % 4 == 0:
        return size
    if not 自动修正:
        raise ValueError("批次大小必须符合 SeedVR2 的 4n+1 规则，例如 1、5、9、13、17。")
    return max(1, ((size - 1) // 4) * 4 + 1)


def _normalize_temporal_overlap(value: Any, batch_size: int) -> int:
    overlap = _to_int("时间重叠", value, minimum=0, maximum=16)
    if batch_size <= 1:
        return 0
    return min(overlap, batch_size - 1)


def _normalize_tile_settings(前缀: str, enabled: bool, size: Any, overlap: Any) -> tuple[int, int]:
    tile_size = _to_int(f"{前缀}分块大小", size, minimum=64, maximum=8192)
    tile_overlap = _to_int(f"{前缀}重叠", overlap, minimum=0, maximum=8191)
    if enabled and tile_overlap >= tile_size:
        raise ValueError(f"{前缀}重叠必须小于{前缀}分块大小。")
    return tile_size, tile_overlap


def _validate_cache_config(名称: str, 缓存模型: bool, 卸载设备: str) -> None:
    if 缓存模型 and 卸载设备 == "none":
        raise ValueError(f"启用{名称}缓存时，卸载设备不能为 none；请选择 cpu 或其它设备。")


def _validate_blockswap(BlockSwap块数: int, 交换输入输出组件: bool, 设备: str, 卸载设备: str) -> None:
    if BlockSwap块数 <= 0 and not 交换输入输出组件:
        return
    if 卸载设备 == "none" or 卸载设备 == 设备:
        raise ValueError("启用 BlockSwap 时，卸载设备必须不是 none，且不能与主设备相同。")


def _build_compile_args(
    启用编译: bool,
    编译后端: str,
    编译模式: str,
    完整图编译: bool,
    动态形状编译: bool,
    Dynamo缓存上限: int,
    Dynamo重编译上限: int,
) -> dict[str, Any] | None:
    if not 启用编译:
        return None

    try:
        import torch
    except Exception as exc:
        raise RuntimeError("启用 torch.compile 需要可用的 PyTorch 环境。") from exc
    if not hasattr(torch, "compile"):
        raise RuntimeError("当前 PyTorch 版本不支持 torch.compile，请关闭编译或升级 PyTorch。")

    return {
        "backend": _normalize_choice(编译后端, COMPILE_BACKENDS, "inductor"),
        "mode": _normalize_choice(编译模式, COMPILE_MODES, "default"),
        "fullgraph": bool(完整图编译),
        "dynamic": bool(动态形状编译),
        "dynamo_cache_size_limit": _to_int("Dynamo缓存上限", Dynamo缓存上限, minimum=0, maximum=1024),
        "dynamo_recompile_limit": _to_int("Dynamo重编译上限", Dynamo重编译上限, minimum=0, maximum=1024),
    }


def _source_color(value: str) -> str:
    return COLOR_TO_SOURCE.get(str(value or "Lab"), "lab")


def _source_tile_debug(value: str) -> str:
    return TILE_DEBUG_TO_SOURCE.get(str(value or "关闭"), "false")


def _source_node_id(suffix: str) -> str:
    try:
        from comfy_execution.utils import get_executing_context

        node_id = get_executing_context().node_id
    except Exception:
        node_id = NODE_ID
    return f"{node_id}:{suffix}"


def _build_dit_config(
    模型: str,
    设备: str,
    卸载设备: str,
    注意力模式: str,
    缓存模型: bool,
    BlockSwap块数: int,
    交换输入输出组件: bool,
    编译参数: dict[str, Any] | None,
) -> dict[str, Any]:
    interfaces = _seedvr2_interfaces()
    result = interfaces.SeedVR2LoadDiTModel.execute(
        model=模型,
        device=设备,
        offload_device=卸载设备,
        cache_model=缓存模型,
        blocks_to_swap=BlockSwap块数,
        swap_io_components=交换输入输出组件,
        attention_mode=注意力模式,
        torch_compile_args=编译参数,
    )
    config = dict(result.result[0])
    config["node_id"] = _source_node_id("dit")
    return config


def _build_vae_config(
    模型: str,
    设备: str,
    卸载设备: str,
    缓存模型: bool,
    VAE编码分块: bool,
    VAE编码分块大小: int,
    VAE编码重叠: int,
    VAE解码分块: bool,
    VAE解码分块大小: int,
    VAE解码重叠: int,
    分块调试: str,
    编译参数: dict[str, Any] | None,
) -> dict[str, Any]:
    interfaces = _seedvr2_interfaces()
    result = interfaces.SeedVR2LoadVAEModel.execute(
        model=模型,
        device=设备,
        offload_device=卸载设备,
        cache_model=缓存模型,
        encode_tiled=VAE编码分块,
        encode_tile_size=VAE编码分块大小,
        encode_tile_overlap=VAE编码重叠,
        decode_tiled=VAE解码分块,
        decode_tile_size=VAE解码分块大小,
        decode_tile_overlap=VAE解码重叠,
        tile_debug=分块调试,
        torch_compile_args=编译参数,
    )
    config = dict(result.result[0])
    config["node_id"] = _source_node_id("vae")
    return config


def _execute_seedvr2(
    图像,
    DiT模型: str,
    VAE模型: str,
    设备: str,
    卸载设备: str,
    种子: int,
    分辨率: int,
    最大分辨率: int,
    批次大小: int,
    自动修正批次: bool,
    统一批次: bool,
    时间重叠: int,
    预置帧数: int,
    色彩校正: str,
    注意力模式: str,
    缓存DiT模型: bool,
    缓存VAE模型: bool,
    BlockSwap块数: int,
    交换输入输出组件: bool,
    VAE编码分块: bool,
    VAE编码分块大小: int,
    VAE编码重叠: int,
    VAE解码分块: bool,
    VAE解码分块大小: int,
    VAE解码重叠: int,
    分块调试: str,
    输入噪声: float,
    Latent噪声: float,
    启用DiT编译: bool,
    启用VAE编译: bool,
    编译后端: str,
    编译模式: str,
    完整图编译: bool,
    动态形状编译: bool,
    Dynamo缓存上限: int,
    Dynamo重编译上限: int,
    调试日志: bool,
):
    if 图像 is None:
        raise ValueError("图像输入不能为空。")
    if hasattr(图像, "shape") and len(图像.shape) > 0 and int(图像.shape[0]) <= 0:
        raise ValueError("图像批次不能为空。")

    设备 = str(设备 or _default_device())
    卸载设备 = str(卸载设备 or _default_offload_device())
    DiT模型 = str(DiT模型 or _default_dit_name())
    VAE模型 = str(VAE模型 or _default_vae_name())
    种子 = _to_int("种子", 种子, minimum=0, maximum=2**32 - 1)
    分辨率 = _even_int("分辨率", 分辨率, minimum=16, maximum=16384)
    最大分辨率 = _even_int("最大分辨率", 最大分辨率, minimum=0, maximum=16384)
    批次大小 = _normalize_batch_size(批次大小, bool(自动修正批次))
    时间重叠 = _normalize_temporal_overlap(时间重叠, 批次大小)
    预置帧数 = _to_int("预置帧数", 预置帧数, minimum=0, maximum=32)
    注意力模式 = _normalize_choice(注意力模式, ATTENTION_OPTIONS, "sdpa")
    BlockSwap块数 = _to_int("BlockSwap块数", BlockSwap块数, minimum=0, maximum=36)
    输入噪声 = _to_float("输入噪声", 输入噪声, minimum=0.0, maximum=1.0)
    Latent噪声 = _to_float("Latent噪声", Latent噪声, minimum=0.0, maximum=1.0)
    VAE编码分块大小, VAE编码重叠 = _normalize_tile_settings(
        "VAE编码", bool(VAE编码分块), VAE编码分块大小, VAE编码重叠
    )
    VAE解码分块大小, VAE解码重叠 = _normalize_tile_settings(
        "VAE解码", bool(VAE解码分块), VAE解码分块大小, VAE解码重叠
    )

    _validate_cache_config("DiT模型", bool(缓存DiT模型), 卸载设备)
    _validate_cache_config("VAE模型", bool(缓存VAE模型), 卸载设备)
    _validate_blockswap(BlockSwap块数, bool(交换输入输出组件), 设备, 卸载设备)

    编译参数 = _build_compile_args(
        bool(启用DiT编译 or 启用VAE编译),
        编译后端,
        编译模式,
        bool(完整图编译),
        bool(动态形状编译),
        Dynamo缓存上限,
        Dynamo重编译上限,
    )
    DiT编译参数 = 编译参数 if 启用DiT编译 else None
    VAE编译参数 = 编译参数 if 启用VAE编译 else None

    dit = _build_dit_config(
        DiT模型,
        设备,
        卸载设备,
        注意力模式,
        bool(缓存DiT模型),
        BlockSwap块数,
        bool(交换输入输出组件),
        DiT编译参数,
    )
    vae = _build_vae_config(
        VAE模型,
        设备,
        卸载设备,
        bool(缓存VAE模型),
        bool(VAE编码分块),
        VAE编码分块大小,
        VAE编码重叠,
        bool(VAE解码分块),
        VAE解码分块大小,
        VAE解码重叠,
        _source_tile_debug(分块调试),
        VAE编译参数,
    )

    interfaces = _seedvr2_interfaces()
    return interfaces.SeedVR2VideoUpscaler.execute(
        image=图像,
        dit=dit,
        vae=vae,
        seed=种子,
        resolution=分辨率,
        max_resolution=最大分辨率,
        batch_size=批次大小,
        uniform_batch_size=bool(统一批次),
        temporal_overlap=时间重叠,
        prepend_frames=预置帧数,
        color_correction=_source_color(色彩校正),
        input_noise_scale=输入噪声,
        latent_noise_scale=Latent噪声,
        offload_device=卸载设备,
        enable_debug=bool(调试日志),
    )


def _execute_seedvr2_core(
    图像,
    DiT模型: str,
    VAE模型: str,
    设备: str,
    种子: int,
    分辨率: int,
    批次大小: int,
    色彩校正: str,
    注意力模式: str,
):
    return _execute_seedvr2(
        图像=图像,
        DiT模型=DiT模型,
        VAE模型=VAE模型,
        设备=设备,
        卸载设备=_default_offload_device(),
        种子=种子,
        分辨率=分辨率,
        最大分辨率=0,
        批次大小=批次大小,
        自动修正批次=True,
        统一批次=False,
        时间重叠=0,
        预置帧数=0,
        色彩校正=色彩校正,
        注意力模式=注意力模式,
        缓存DiT模型=False,
        缓存VAE模型=False,
        BlockSwap块数=0,
        交换输入输出组件=False,
        VAE编码分块=True,
        VAE编码分块大小=DEFAULT_TILE_SIZE,
        VAE编码重叠=DEFAULT_TILE_OVERLAP,
        VAE解码分块=True,
        VAE解码分块大小=DEFAULT_TILE_SIZE,
        VAE解码重叠=DEFAULT_TILE_OVERLAP,
        分块调试="关闭",
        输入噪声=0.0,
        Latent噪声=0.0,
        启用DiT编译=False,
        启用VAE编译=False,
        编译后端="inductor",
        编译模式="default",
        完整图编译=False,
        动态形状编译=False,
        Dynamo缓存上限=64,
        Dynamo重编译上限=128,
        调试日志=False,
    )


if io is not None:

    class GGSeedVR2VideoUpscaler(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            dit_models = _dit_models()
            vae_models = _vae_models()
            devices = _devices()

            return io.Schema(
                node_id=NODE_ID,
                display_name=DISPLAY_NAME,
                category=CATEGORY,
                description="聚合 SeedVR2 的 DiT、VAE 与视频放大流程，只保留必要参数。",
                search_aliases=["SeedVR2", "视频放大", "超分", "Upscaler", "Video Upscaler"],
                inputs=[
                    io.Image.Input("图像", tooltip="输入视频帧图像批次，支持 RGB/RGBA。"),
                    io.Combo.Input("DiT模型", options=dit_models, default=_default_from(dit_models, _default_dit_name())),
                    io.Combo.Input("VAE模型", options=vae_models, default=_default_from(vae_models, _default_vae_name())),
                    io.Combo.Input("设备", options=devices, default=_default_from(devices, "cuda:0")),
                    io.Int.Input("种子", default=DEFAULT_SEED, min=0, max=2**32 - 1, step=1, control_after_generate=True),
                    io.Int.Input("分辨率", default=DEFAULT_RESOLUTION, min=16, max=16384, step=2, tooltip="目标短边尺寸，保持输入比例。"),
                    io.Int.Input("批次大小", default=DEFAULT_BATCH_SIZE, min=1, max=16384, step=4, tooltip="SeedVR2 要求 4n+1，例如 1、5、9、13。"),
                    io.Combo.Input("色彩校正", options=COLOR_OPTIONS, default="自适应Wavelet"),
                    io.Combo.Input("注意力模式", options=ATTENTION_OPTIONS, default="sageattn_2", tooltip="sdpa 最稳；Flash Attention/SageAttention 需要对应 CUDA 扩展。"),
                ],
                outputs=[
                    io.Image.Output(display_name="图像"),
                ],
            )

        @classmethod
        def execute(
            cls,
            图像,
            DiT模型: str = DEFAULT_DIT,
            VAE模型: str = DEFAULT_VAE,
            设备: str = "cuda:0",
            种子: int = DEFAULT_SEED,
            分辨率: int = DEFAULT_RESOLUTION,
            批次大小: int = DEFAULT_BATCH_SIZE,
            色彩校正: str = "自适应Wavelet",
            注意力模式: str = "sageattn_2",
        ):
            return _execute_seedvr2_core(图像, DiT模型, VAE模型, 设备, 种子, 分辨率, 批次大小, 色彩校正, 注意力模式)

else:

    class GGSeedVR2VideoUpscaler:
        @classmethod
        def INPUT_TYPES(cls):
            dit_models = _dit_models()
            vae_models = _vae_models()
            devices = _devices()
            return {
                "required": {
                    "图像": ("IMAGE",),
                    "DiT模型": (dit_models, {"default": _default_from(dit_models, _default_dit_name())}),
                    "VAE模型": (vae_models, {"default": _default_from(vae_models, _default_vae_name())}),
                    "设备": (devices, {"default": _default_from(devices, "cuda:0")}),
                    "种子": ("INT", {"default": DEFAULT_SEED, "min": 0, "max": 2**32 - 1, "step": 1, "control_after_generate": True}),
                    "分辨率": ("INT", {"default": DEFAULT_RESOLUTION, "min": 16, "max": 16384, "step": 2}),
                    "批次大小": ("INT", {"default": DEFAULT_BATCH_SIZE, "min": 1, "max": 16384, "step": 4}),
                    "色彩校正": (COLOR_OPTIONS, {"default": "自适应Wavelet"}),
                    "注意力模式": (ATTENTION_OPTIONS, {"default": "sageattn_2"}),
                },
            }

        RETURN_TYPES = ("IMAGE",)
        RETURN_NAMES = ("图像",)
        FUNCTION = "execute"
        CATEGORY = CATEGORY
        DESCRIPTION = "聚合 SeedVR2 的 DiT、VAE 与视频放大流程，只保留必要参数。"

        def execute(
            self,
            图像,
            DiT模型: str = DEFAULT_DIT,
            VAE模型: str = DEFAULT_VAE,
            设备: str = "cuda:0",
            种子: int = DEFAULT_SEED,
            分辨率: int = DEFAULT_RESOLUTION,
            批次大小: int = DEFAULT_BATCH_SIZE,
            色彩校正: str = "自适应Wavelet",
            注意力模式: str = "sageattn_2",
        ):
            result = _execute_seedvr2_core(图像, DiT模型, VAE模型, 设备, 种子, 分辨率, 批次大小, 色彩校正, 注意力模式)
            return result.result


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGSeedVR2VideoUpscaler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}
