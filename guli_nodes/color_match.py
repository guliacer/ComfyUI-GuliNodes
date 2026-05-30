import logging
import os
from concurrent.futures import ThreadPoolExecutor

import torch

try:
    from comfy import model_management
except Exception:
    model_management = None

try:
    from comfy_api.latest import io
except Exception:
    io = None


COLOR_MATCH_METHODS = [
    "mkl",
    "hm",
    "reinhard",
    "mvgd",
    "hm-mvgd-hm",
    "hm-mkl-hm",
    "reinhard_lab_gpu",
]


def _reference_for_index(image_ref: torch.Tensor, index: int) -> torch.Tensor:
    ref_count = int(image_ref.shape[0])
    if ref_count <= 1:
        return image_ref[0]
    return image_ref[min(index, ref_count - 1)]


def _match_reference_batch(image_ref: torch.Tensor, batch_size: int) -> torch.Tensor:
    if image_ref.shape[0] == batch_size:
        return image_ref
    if image_ref.shape[0] == 1:
        return image_ref.expand(batch_size, -1, -1, -1)
    refs = [_reference_for_index(image_ref, index) for index in range(batch_size)]
    return torch.stack(refs, dim=0)


def _color_match_with_color_matcher(
    image_target: torch.Tensor,
    image_ref: torch.Tensor,
    method: str,
    strength: float,
    multithread: bool,
) -> torch.Tensor:
    try:
        from color_matcher import ColorMatcher
    except ImportError as exc:
        raise ImportError(
            "GG Color Match requires color-matcher. Install it with: pip install color-matcher"
        ) from exc

    image_target_cpu = image_target.detach().cpu()
    image_ref_cpu = image_ref.detach().cpu()
    batch_size = int(image_target_cpu.shape[0])

    def process(index: int) -> torch.Tensor:
        matcher = ColorMatcher()
        target_np = image_target_cpu[index].numpy()
        ref_np = _reference_for_index(image_ref_cpu, index).numpy()
        try:
            result_np = matcher.transfer(src=target_np, ref=ref_np, method=method)
            if strength != 1.0:
                result_np = target_np + float(strength) * (result_np - target_np)
            return torch.from_numpy(result_np)
        except Exception as exc:
            logging.warning("GG Color Match failed on batch item %s: %s", index, exc)
            return torch.from_numpy(target_np)

    if multithread and batch_size > 1:
        max_workers = min(os.cpu_count() or 1, batch_size)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            output = list(executor.map(process, range(batch_size)))
    else:
        output = [process(index) for index in range(batch_size)]

    return torch.stack(output, dim=0).to(torch.float32).clamp_(0.0, 1.0)


def _color_match_reinhard_lab_gpu(
    image_target: torch.Tensor,
    image_ref: torch.Tensor,
    strength: float,
) -> torch.Tensor:
    try:
        import kornia
    except ImportError as exc:
        raise ImportError(
            "GG Color Match method reinhard_lab_gpu requires kornia. Install it with: pip install kornia"
        ) from exc

    device = (
        model_management.get_torch_device()
        if model_management is not None
        else image_target.device
    )
    source = image_target.to(device=device, dtype=torch.float32)
    reference = _match_reference_batch(image_ref, int(source.shape[0])).to(
        device=device, dtype=torch.float32
    )

    source_bchw = source.permute(0, 3, 1, 2).contiguous()
    reference_bchw = reference.permute(0, 3, 1, 2).contiguous()

    source_lab = kornia.color.rgb_to_lab(source_bchw)
    reference_lab = kornia.color.rgb_to_lab(reference_bchw)

    batch_size, channels, height, width = source_lab.shape
    source_flat = source_lab.view(batch_size, channels, -1)
    reference_flat = reference_lab.view(batch_size, channels, -1)

    source_std, source_mean = torch.std_mean(
        source_flat, dim=-1, keepdim=True, unbiased=False
    )
    reference_std, reference_mean = torch.std_mean(
        reference_flat, dim=-1, keepdim=True, unbiased=False
    )
    source_std = source_std.clamp_min_(1e-6)

    corrected_flat = (source_flat - source_mean) * (reference_std / source_std) + reference_mean
    corrected_lab = corrected_flat.view(batch_size, channels, height, width)
    corrected_rgb = kornia.color.lab_to_rgb(corrected_lab)

    if strength != 1.0:
        corrected_rgb = (1.0 - float(strength)) * source_bchw + float(strength) * corrected_rgb

    output = corrected_rgb.permute(0, 2, 3, 1).contiguous()
    return output.cpu().float().clamp_(0.0, 1.0)


def _execute_color_match(
    image_target: torch.Tensor,
    image_ref: torch.Tensor,
    method: str,
    strength: float,
    multithread: bool,
) -> torch.Tensor:
    image_target = image_target[..., :3].contiguous()
    image_ref = image_ref[..., :3].contiguous()
    if method not in COLOR_MATCH_METHODS:
        method = "mkl"
    if strength <= 0.0:
        return image_target
    if method == "reinhard_lab_gpu":
        return _color_match_reinhard_lab_gpu(image_target, image_ref, strength)
    return _color_match_with_color_matcher(
        image_target=image_target,
        image_ref=image_ref,
        method=method,
        strength=strength,
        multithread=multithread,
    )


if io is not None:

    class GGColorMatch(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGColorMatch",
                display_name="GG 色彩匹配",
                category="GuliNodes/图像",
                description=(
                    "Transfer color from a reference image to a target image. "
                    "CPU methods use color-matcher; reinhard_lab_gpu uses Kornia on the ComfyUI torch device."
                ),
                inputs=[
                    io.Image.Input("参考图像"),
                    io.Image.Input("目标图像"),
                    io.Combo.Input("匹配方法", options=COLOR_MATCH_METHODS, default="mkl"),
                    io.Float.Input("强度", default=0.3, min=0.0, max=10.0, step=0.01),
                    io.Boolean.Input("多线程", default=True),
                ],
                outputs=[
                    io.Image.Output(display_name="图像"),
                ],
            )

        @classmethod
        def execute(
            cls,
            参考图像: torch.Tensor,
            目标图像: torch.Tensor,
            匹配方法: str,
            强度: float = 0.3,
            多线程: bool = True,
        ):
            output = _execute_color_match(
                image_target=目标图像,
                image_ref=参考图像,
                method=匹配方法,
                strength=强度,
                multithread=多线程,
            )
            return io.NodeOutput(output)

else:

    class GGColorMatch:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    "参考图像": ("IMAGE",),
                    "目标图像": ("IMAGE",),
                    "匹配方法": (COLOR_MATCH_METHODS, {"default": "mkl"}),
                    "强度": (
                        "FLOAT",
                        {"default": 0.3, "min": 0.0, "max": 10.0, "step": 0.01},
                    ),
                    "多线程": ("BOOLEAN", {"default": True}),
                },
            }

        RETURN_TYPES = ("IMAGE",)
        RETURN_NAMES = ("图像",)
        FUNCTION = "color_match"
        CATEGORY = "GuliNodes/图像"
        DESCRIPTION = (
            "Transfer color from a reference image to a target image. "
            "CPU methods use color-matcher; reinhard_lab_gpu uses Kornia on the ComfyUI torch device."
        )

        def color_match(
            self,
            参考图像: torch.Tensor,
            目标图像: torch.Tensor,
            匹配方法: str,
            强度: float = 0.3,
            多线程: bool = True,
        ):
            return (
                _execute_color_match(
                    image_target=目标图像,
                    image_ref=参考图像,
                    method=匹配方法,
                    strength=强度,
                    multithread=多线程,
                ),
            )


NODE_CLASS_MAPPINGS = {
    "GGColorMatch": GGColorMatch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGColorMatch": "GG 色彩匹配",
}
