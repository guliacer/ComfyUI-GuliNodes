import comfy.sample
import comfy.utils
import comfy.model_management
import latent_preview
import torch

from .aspect_ratio import ASPECT_PRESETS, LATENT_ASPECT_RATIOS, ORIENTATION_TYPES, SIDE_TYPES


ZIMAGE_SAMPLERS = ["euler", "euler_a", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde"]
ZIMAGE_SCHEDULERS = ["simple", "normal", "sgm_uniform", "beta"]


def _对齐到八(value: int) -> int:
    return max(8, (int(value) // 8) * 8)


def _应用画面方向(width: int, height: int, 画面方向: str) -> tuple[int, int]:
    if 画面方向 == "横屏" and width < height:
        return height, width
    if 画面方向 == "竖屏" and width > height:
        return height, width
    return width, height


def _计算Latent尺寸(宽高比例: str, 边长: int, 边长类型: str, 画面方向: str) -> tuple[int, int]:
    wr, hr = ASPECT_PRESETS[宽高比例]
    wr, hr = _应用画面方向(wr, hr, 画面方向)
    if 边长类型 == "最长边":
        width = 边长 if wr > hr else int(边长 * wr / hr)
        height = int(边长 * hr / wr) if wr > hr else 边长
    else:
        height = 边长 if wr > hr else int(边长 * hr / wr)
        width = int(边长 * wr / hr) if wr > hr else 边长
    return _对齐到八(width), _对齐到八(height)


def _创建空Latent(宽度: int, 高度: int, 批量大小: int) -> dict:
    latent_kwargs = {"device": comfy.model_management.intermediate_device()}
    if hasattr(comfy.model_management, "intermediate_dtype"):
        latent_kwargs["dtype"] = comfy.model_management.intermediate_dtype()
    latent = torch.zeros([批量大小, 4, 高度 // 8, 宽度 // 8], **latent_kwargs)
    return {"samples": latent}


def _执行ZImage采样(
    模型,
    种子,
    步数,
    引导强度,
    采样器,
    调度器,
    正向提示词,
    负向提示词,
    Latent图像,
    降噪强度,
) -> dict:
    latent = Latent图像
    latent_samples = latent["samples"]
    latent_samples = comfy.sample.fix_empty_latent_channels(
        模型, latent_samples, latent.get("downscale_ratio_spacial", None)
    )

    batch_inds = latent.get("batch_index", None)
    noise = comfy.sample.prepare_noise(latent_samples, 种子, batch_inds)

    noise_mask = latent.get("noise_mask", None)

    callback = latent_preview.prepare_callback(模型, 步数)
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED
    try:
        samples = comfy.sample.sample(
            模型,
            noise,
            步数,
            引导强度,
            采样器,
            调度器,
            正向提示词,
            负向提示词,
            latent_samples,
            denoise=降噪强度,
            noise_mask=noise_mask,
            callback=callback,
            disable_pbar=disable_pbar,
            seed=种子,
        )
    except Exception as e:
        raise RuntimeError(f"Z-Image采样失败: {e}") from e
    out = latent.copy()
    out.pop("downscale_ratio_spacial", None)
    out["samples"] = samples
    return out


class GGZImageSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL",),
                "种子": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                    },
                ),
                "步数": (
                    "INT",
                    {"default": 10, "min": 4, "max": 20, "step": 1},
                ),
                "引导强度": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 14.0, "step": 0.1, "round": 0.01},
                ),
                "采样器": (ZIMAGE_SAMPLERS,),
                "调度器": (ZIMAGE_SCHEDULERS,),
                "正向提示词": ("CONDITIONING",),
                "负向提示词": ("CONDITIONING",),
                "Latent图像": ("LATENT",),
                "降噪强度": (
                    "FLOAT",
                    {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
            }
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "sample"
    CATEGORY = "GuliNodes/采样"

    def sample(
        self,
        模型,
        种子,
        步数,
        引导强度,
        采样器,
        调度器,
        正向提示词,
        负向提示词,
        Latent图像,
        降噪强度=1.0,
    ):
        out = _执行ZImage采样(
            模型,
            种子,
            步数,
            引导强度,
            采样器,
            调度器,
            正向提示词,
            负向提示词,
            Latent图像,
            降噪强度,
        )
        return (out,)


class GG采样器:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL",),
                "种子": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                    },
                ),
                "步数": (
                    "INT",
                    {"default": 10, "min": 4, "max": 20, "step": 1},
                ),
                "引导强度": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 14.0, "step": 0.1, "round": 0.01},
                ),
                "采样器": (ZIMAGE_SAMPLERS,),
                "调度器": (ZIMAGE_SCHEDULERS,),
                "正向提示词": ("CONDITIONING",),
                "负向提示词": ("CONDITIONING",),
                "宽高比例": (LATENT_ASPECT_RATIOS, {"default": "9:16"}),
                "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "边长类型": (SIDE_TYPES, {"default": "最长边"}),
                "批量大小": ("INT", {"default": 1, "min": 1, "max": 64}),
                "画面方向": (ORIENTATION_TYPES, {"default": "横屏"}),
                "降噪强度": (
                    "FLOAT",
                    {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("Latent",)
    FUNCTION = "sample"
    CATEGORY = "GuliNodes/采样"

    def sample(
        self,
        模型,
        种子,
        步数,
        引导强度,
        采样器,
        调度器,
        正向提示词,
        负向提示词,
        宽高比例,
        边长,
        边长类型,
        批量大小,
        画面方向,
        降噪强度=0.9,
    ):
        宽度, 高度 = _计算Latent尺寸(宽高比例, 边长, 边长类型, 画面方向)
        Latent图像 = _创建空Latent(宽度, 高度, 批量大小)
        out = _执行ZImage采样(
            模型,
            种子,
            步数,
            引导强度,
            采样器,
            调度器,
            正向提示词,
            负向提示词,
            Latent图像,
            降噪强度,
        )
        return (out,)


NODE_CLASS_MAPPINGS = {
    "GGZImageSampler": GGZImageSampler,
    "GG采样器": GG采样器,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGZImageSampler": "GG Z-Image采样器",
    "GG采样器": "GG 采样器",
}
