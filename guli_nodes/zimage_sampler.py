import comfy.sample
import comfy.utils
import latent_preview


ZIMAGE_SAMPLERS = ["euler", "euler_a", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde"]
ZIMAGE_SCHEDULERS = ["simple", "normal", "sgm_uniform", "beta"]


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
    CATEGORY = "GuliNodes/采样工具"

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
        return (out,)


NODE_CLASS_MAPPINGS = {
    "GGZImageSampler": GGZImageSampler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGZImageSampler": "GG Z-Image采样器",
}
