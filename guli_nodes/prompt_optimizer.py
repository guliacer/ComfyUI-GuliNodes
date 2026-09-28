import math
import re

import comfy.utils
import node_helpers

from .clipboard import GGCLIPText, _list_clip_files, _list_clip_types
from .model_loaders import GGVaeDecode, _list_vae_files

try:
    from comfy_api.latest import io
except Exception:
    io = None


NODE_ID = "GGPromptOptimizer"
DISPLAY_NAME = "GG 提示词优化qwen2.1"
CATEGORY = "GuliNodes/文本"
CLIP_NAME = "CLIP名称"
CLIP_TYPE = "CLIP类型"
VAE_NAME = "VAE名称"
POSITIVE_PROMPT = "正向提示词"
NEGATIVE_PROMPT = "负向提示词"
RESOLUTION = "分辨率"
IMAGE_PREFIX = "图像"
MAX_IMAGES = 20
QWEN_CLIP_TYPE = "qwen_image"
QWEN_VAE_NAME = "qwen_image_vae.safetensors"


def _default_option(options: list[str], preferred: str) -> str:
    if preferred in options:
        return preferred
    return options[0] if options else ""


def _image_index(name: str) -> int:
    match = re.search(r"(\d+)$", str(name))
    return int(match.group(1)) if match else 0


def _ordered_images(images) -> list[tuple[str, object]]:
    if not isinstance(images, dict):
        return []
    return [
        (name, image)
        for name, image in sorted(images.items(), key=lambda item: _image_index(item[0]))
        if image is not None
    ]


def _prepare_reference_image(image, resolution: int):
    samples = image[:1].movedim(-1, 1)
    if resolution > 0:
        ratio = samples.shape[3] / samples.shape[2]
        width = round(math.sqrt(resolution * resolution * ratio) / 32) * 32
        height = round(math.sqrt(resolution * resolution / ratio) / 32) * 32
    else:
        width = round(samples.shape[3] / 32) * 32
        height = round(samples.shape[2] / 32) * 32

    width, height = max(32, width), max(32, height)
    if (width, height) == (samples.shape[3], samples.shape[2]):
        resized = image[:1]
    else:
        resized = comfy.utils.common_upscale(
            samples,
            width,
            height,
            "lanczos",
            "disabled",
        ).movedim(1, -1)
    return resized


def _encode_qwen_image21(
    clip,
    vae,
    positive_prompt: str,
    negative_prompt: str,
    resolution: int,
    images,
):
    images_vl = []
    reference_latents = []

    for _, image in _ordered_images(images):
        resized = _prepare_reference_image(image, resolution)
        rgb = resized[:, :, :, :3]
        if resized.shape[-1] > 3:
            rgb = rgb * resized[:, :, :, 3:] + (1.0 - resized[:, :, :, 3:])
        images_vl.append(rgb)
        if vae is not None:
            reference_latents.append(vae.encode(resized))

    keep_vision = len(reference_latents) == 0
    positive = clip.encode_from_tokens_scheduled(
        clip.tokenize(
            positive_prompt or "",
            images=images_vl,
            keep_vision=keep_vision,
            prevent_empty_text=True,
        )
    )
    negative = clip.encode_from_tokens_scheduled(
        clip.tokenize(
            negative_prompt or "",
            images=images_vl,
            keep_vision=keep_vision,
            prevent_empty_text=True,
        )
    )

    if reference_latents:
        values = {"reference_latents": reference_latents}
        positive = node_helpers.conditioning_set_values(positive, values, append=True)
        negative = node_helpers.conditioning_set_values(negative, values, append=True)
    return positive, negative


def _encode_from_values(clip_name, clip_type, vae_name, positive_prompt, negative_prompt, resolution, images):
    clip = GGCLIPText._get_clip(clip_name, clip_type)
    ordered_images = _ordered_images(images)
    vae = GGVaeDecode._get_vae(vae_name) if ordered_images else None
    return _encode_qwen_image21(
        clip,
        vae,
        positive_prompt,
        negative_prompt,
        max(0, int(resolution or 0)),
        dict(ordered_images),
    )


if io is not None:

    class GGPromptOptimizer(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            clip_names = _list_clip_files()
            clip_types = _list_clip_types()
            vae_names = _list_vae_files()
            return io.Schema(
                node_id=NODE_ID,
                display_name=DISPLAY_NAME,
                category=CATEGORY,
                description=(
                    "将 CLIP、VAE、提示词和最多20张参考图像整合到一个 Qwen Image 2.1 条件编码节点中。"
                    "VAE 用于把参考图像编码为 Conditioning 内的 reference_latents。"
                ),
                search_aliases=["Prompt Optimizer", "Qwen Image 2.1", "Text Encode Qwen Image 2.1", "提示词优化"],
                inputs=[
                    io.Combo.Input(CLIP_NAME, options=clip_names, default=_default_option(clip_names, "qwen_2.5_vl_7b_fp8_scaled.safetensors"), tooltip="选择用于 Qwen Image 2.1 文本和图像编码的 CLIP。"),
                    io.Combo.Input(CLIP_TYPE, options=clip_types, default=_default_option(clip_types, QWEN_CLIP_TYPE), tooltip="选择与 CLIP 文件匹配的 ComfyUI CLIP 类型。"),
                    io.Combo.Input(VAE_NAME, options=vae_names, default=_default_option(vae_names, QWEN_VAE_NAME), tooltip="选择用于参考图像 reference_latents 编码的 VAE。"),
                    io.Int.Input(RESOLUTION, default=1024, min=0, max=4096, step=32, tooltip="参考图像会按此近似面积缩放并对齐到32；设为0时保留各图像自身尺寸。"),
                    io.String.Input(POSITIVE_PROMPT, multiline=True, dynamic_prompts=True, placeholder="输入正向提示词"),
                    io.String.Input(NEGATIVE_PROMPT, multiline=True, dynamic_prompts=True, placeholder="输入负向提示词"),
                    io.Autogrow.Input(
                        IMAGE_PREFIX,
                        template=io.Autogrow.TemplateNames(
                            io.Image.Input(IMAGE_PREFIX),
                            names=[f"{IMAGE_PREFIX}{index}" for index in range(1, MAX_IMAGES + 1)],
                            # The node can run without reference images. Keep one empty
                            # slot visible, then let Autogrow add more after connections.
                            min=0,
                        ),
                        tooltip="参考图像，连接最后一个图像输入后会自动增加下一个输入，最多20个。",
                    ),
                ],
                outputs=[
                    io.Conditioning.Output(display_name="正面条件"),
                    io.Conditioning.Output(display_name="负面条件"),
                ],
            )

        @classmethod
        def execute(
            cls,
            CLIP名称,
            CLIP类型,
            VAE名称,
            正向提示词="",
            负向提示词="",
            分辨率=1024,
            图像=None,
        ):
            positive, negative = _encode_from_values(
                CLIP名称,
                CLIP类型,
                VAE名称,
                正向提示词,
                负向提示词,
                分辨率,
                图像 or {},
            )
            return io.NodeOutput(positive, negative)

else:

    class GGPromptOptimizer:
        @classmethod
        def INPUT_TYPES(cls):
            clip_names = _list_clip_files()
            clip_types = _list_clip_types()
            vae_names = _list_vae_files()
            return {
                "required": {
                    CLIP_NAME: (clip_names, {"default": _default_option(clip_names, "qwen_2.5_vl_7b_fp8_scaled.safetensors"), "tooltip": "选择用于 Qwen Image 2.1 文本和图像编码的 CLIP。"}),
                    CLIP_TYPE: (clip_types, {"default": _default_option(clip_types, QWEN_CLIP_TYPE), "tooltip": "选择与 CLIP 文件匹配的 ComfyUI CLIP 类型。"}),
                    VAE_NAME: (vae_names, {"default": _default_option(vae_names, QWEN_VAE_NAME), "tooltip": "选择用于参考图像 reference_latents 编码的 VAE。"}),
                    RESOLUTION: ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 32}),
                    POSITIVE_PROMPT: ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "placeholder": "输入正向提示词"}),
                    NEGATIVE_PROMPT: ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "placeholder": "输入负向提示词"}),
                },
                "optional": {
                    f"{IMAGE_PREFIX}{index}": ("IMAGE", {"tooltip": "参考图像；连接最后一个图像输入后会自动增加下一个输入。"})
                    for index in range(1, MAX_IMAGES + 1)
                },
            }

        RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
        RETURN_NAMES = ("正面条件", "负面条件")
        FUNCTION = "encode"
        CATEGORY = CATEGORY
        DESCRIPTION = "将 CLIP、VAE、提示词和最多20张参考图像整合到一个 Qwen Image 2.1 条件编码节点中。"

        def encode(self, **kwargs):
            images = {
                f"{IMAGE_PREFIX}{index}": kwargs.get(f"{IMAGE_PREFIX}{index}")
                for index in range(1, MAX_IMAGES + 1)
            }
            return _encode_from_values(
                kwargs.get(CLIP_NAME, ""),
                kwargs.get(CLIP_TYPE, QWEN_CLIP_TYPE),
                kwargs.get(VAE_NAME, ""),
                kwargs.get(POSITIVE_PROMPT, ""),
                kwargs.get(NEGATIVE_PROMPT, ""),
                kwargs.get(RESOLUTION, 1024),
                images,
            )


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGPromptOptimizer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}
