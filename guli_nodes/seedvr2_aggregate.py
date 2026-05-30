from __future__ import annotations

import importlib
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

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
COLOR_OPTIONS = ["无", "Lab", "Wavelet", "自适应Wavelet", "HSV", "AdaIN"]
COLOR_TO_SOURCE = {
    "无": "none",
    "Lab": "lab",
    "Wavelet": "wavelet",
    "自适应Wavelet": "wavelet_adaptive",
    "HSV": "hsv",
    "AdaIN": "adain",
}


def _custom_nodes_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def _ensure_seedvr2_path() -> None:
    custom_nodes = str(_custom_nodes_dir())
    if custom_nodes not in sys.path:
        sys.path.insert(0, custom_nodes)


@lru_cache(maxsize=1)
def _seedvr2_interfaces():
    _ensure_seedvr2_path()
    return importlib.import_module(f"{SEEDVR2_PACKAGE}.src.interfaces")


@lru_cache(maxsize=1)
def _seedvr2_registry():
    _ensure_seedvr2_path()
    return importlib.import_module(f"{SEEDVR2_PACKAGE}.src.utils.model_registry")


@lru_cache(maxsize=1)
def _seedvr2_memory():
    _ensure_seedvr2_path()
    return importlib.import_module(f"{SEEDVR2_PACKAGE}.src.optimization.memory_manager")


def _safe_options(load_options, fallback: list[str]) -> list[str]:
    try:
        options = [str(option) for option in load_options() if str(option)]
    except Exception:
        options = []
    return options or fallback


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


def _default_offload_device() -> str:
    offload_devices = _offload_devices()
    if "cpu" in offload_devices:
        return "cpu"
    if "none" in offload_devices:
        return "none"
    return offload_devices[0]


def _normalize_batch_size(value: int) -> int:
    size = max(1, int(value))
    if size == 1:
        return size
    return size if (size - 1) % 4 == 0 else ((size - 1) // 4) * 4 + 1


def _source_color(value: str) -> str:
    return COLOR_TO_SOURCE.get(value, value or "none")


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
    编译参数: dict[str, Any] | None,
) -> dict[str, Any]:
    interfaces = _seedvr2_interfaces()
    result = interfaces.SeedVR2LoadDiTModel.execute(
        model=模型,
        device=设备,
        offload_device=卸载设备,
        cache_model=缓存模型,
        blocks_to_swap=0,
        swap_io_components=False,
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
    VAE分块: bool,
    缓存模型: bool,
    编译参数: dict[str, Any] | None,
) -> dict[str, Any]:
    interfaces = _seedvr2_interfaces()
    result = interfaces.SeedVR2LoadVAEModel.execute(
        model=模型,
        device=设备,
        offload_device=卸载设备,
        cache_model=缓存模型,
        encode_tiled=VAE分块,
        encode_tile_size=1024,
        encode_tile_overlap=128,
        decode_tiled=VAE分块,
        decode_tile_size=1024,
        decode_tile_overlap=128,
        tile_debug="false",
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
    种子: int,
    分辨率: int,
    批次大小: int,
    色彩校正: str,
):
    interfaces = _seedvr2_interfaces()
    卸载设备 = _default_offload_device()
    dit = _build_dit_config(
        DiT模型,
        设备,
        卸载设备,
        "sdpa",
        False,
        None,
    )
    vae = _build_vae_config(
        VAE模型,
        设备,
        卸载设备,
        True,
        False,
        None,
    )
    return interfaces.SeedVR2VideoUpscaler.execute(
        image=图像,
        dit=dit,
        vae=vae,
        seed=种子,
        resolution=分辨率,
        max_resolution=0,
        batch_size=_normalize_batch_size(批次大小),
        uniform_batch_size=False,
        temporal_overlap=0,
        prepend_frames=0,
        color_correction=_source_color(色彩校正),
        input_noise_scale=0.0,
        latent_noise_scale=0.0,
        offload_device=卸载设备,
        enable_debug=False,
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
                description="聚合 SeedVR2 的 DiT 加载、VAE 加载和视频放大流程，只保留核心参数。",
                search_aliases=["SeedVR2", "视频放大", "超分", "Upscaler", "Video Upscaler"],
                inputs=[
                    io.Image.Input("图像", tooltip="输入视频帧图像批次。"),
                    io.Combo.Input("DiT模型", options=dit_models, default=_default_from(dit_models, DEFAULT_DIT)),
                    io.Combo.Input("VAE模型", options=vae_models, default=_default_from(vae_models, DEFAULT_VAE)),
                    io.Combo.Input("设备", options=devices, default=devices[0]),
                    io.Int.Input("种子", default=728846566, min=0, max=2**32 - 1, step=1, control_after_generate=True),
                    io.Int.Input("分辨率", default=2048, min=16, max=16384, step=2),
                    io.Int.Input("批次大小", default=5, min=1, max=16384, step=4),
                    io.Combo.Input("色彩校正", options=COLOR_OPTIONS, default="Lab"),
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
            种子: int = 728846566,
            分辨率: int = 2048,
            批次大小: int = 5,
            色彩校正: str = "Lab",
        ):
            return _execute_seedvr2(
                图像,
                DiT模型,
                VAE模型,
                设备,
                种子,
                分辨率,
                批次大小,
                色彩校正,
            )

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
                    "DiT模型": (dit_models, {"default": _default_from(dit_models, DEFAULT_DIT)}),
                    "VAE模型": (vae_models, {"default": _default_from(vae_models, DEFAULT_VAE)}),
                    "设备": (devices, {"default": devices[0]}),
                    "种子": (
                        "INT",
                        {"default": 728846566, "min": 0, "max": 2**32 - 1, "step": 1, "control_after_generate": True},
                    ),
                    "分辨率": ("INT", {"default": 2048, "min": 16, "max": 16384, "step": 2}),
                    "批次大小": ("INT", {"default": 5, "min": 1, "max": 16384, "step": 4}),
                    "色彩校正": (COLOR_OPTIONS, {"default": "Lab"}),
                },
            }

        RETURN_TYPES = ("IMAGE",)
        RETURN_NAMES = ("图像",)
        FUNCTION = "execute"
        CATEGORY = CATEGORY
        DESCRIPTION = "聚合 SeedVR2 的 DiT 加载、VAE 加载和视频放大流程，只保留核心参数。"

        def execute(
            self,
            图像,
            DiT模型: str = DEFAULT_DIT,
            VAE模型: str = DEFAULT_VAE,
            设备: str = "cuda:0",
            种子: int = 42,
            分辨率: int = 1080,
            批次大小: int = 5,
            色彩校正: str = "Lab",
        ):
            result = _execute_seedvr2(
                图像,
                DiT模型,
                VAE模型,
                设备,
                种子,
                分辨率,
                批次大小,
                色彩校正,
            )
            return result.result


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGSeedVR2VideoUpscaler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}
