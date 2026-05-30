from __future__ import annotations

from typing import Any

import torch
import torch.nn.functional as F

try:
    import comfy.model_management as model_management
except Exception:
    model_management = None

try:
    from comfy_api.latest import io
except Exception:
    io = None


GG_NODE_ID = "GGDrawMaskOnImage"
GG_DISPLAY_NAME = "GG 绘制蒙版"
CATEGORY = "GuliNodes/图像"
DEVICE_OPTIONS = ["auto", "cpu", "gpu"]


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _parse_color(color: str) -> tuple[tuple[float, float, float], float]:
    text = str(color).strip()
    if not text:
        raise ValueError("Color cannot be empty.")

    values: list[float]
    if text.startswith("#"):
        hex_color = text[1:].strip()
        if len(hex_color) in (3, 4):
            values = [int(ch * 2, 16) / 255.0 for ch in hex_color]
        elif len(hex_color) in (6, 8):
            values = [int(hex_color[index : index + 2], 16) / 255.0 for index in range(0, len(hex_color), 2)]
        else:
            raise ValueError(f"Invalid hex color format: {color}")
    else:
        try:
            values = [float(part.strip()) for part in text.split(",")]
        except ValueError as exc:
            raise ValueError(f"Invalid color value: {color}") from exc
        values = [value / 255.0 if value > 1.0 else value for value in values]

    if len(values) not in (3, 4):
        raise ValueError("Color must be RGB or RGBA, such as #00ff00 or 0, 255, 0, 128.")

    rgb = tuple(_clamp01(value) for value in values[:3])
    alpha = _clamp01(values[3]) if len(values) == 4 else 1.0
    return rgb, alpha


def _resolve_device(device: str, image: torch.Tensor) -> torch.device:
    normalized = str(device or "auto").lower()
    if normalized == "cpu" or model_management is None:
        return torch.device("cpu")
    if normalized == "gpu":
        return model_management.get_torch_device()
    if image.device.type != "cpu":
        return image.device
    return torch.device("cpu")


def _normalize_mask(mask: torch.Tensor) -> torch.Tensor:
    if mask.ndim == 2:
        return mask.unsqueeze(0)
    if mask.ndim == 3:
        return mask
    if mask.ndim == 4:
        if mask.shape[-1] == 1:
            return mask[..., 0]
        if mask.shape[1] == 1:
            return mask[:, 0]
    raise ValueError(f"Expected MASK shape [B,H,W], got {tuple(mask.shape)}.")


def _resize_mask(mask: torch.Tensor, height: int, width: int) -> torch.Tensor:
    if int(mask.shape[-2]) == height and int(mask.shape[-1]) == width:
        return mask
    try:
        return F.interpolate(mask.unsqueeze(1), size=(height, width), mode="nearest-exact").squeeze(1)
    except ValueError:
        return F.interpolate(mask.unsqueeze(1), size=(height, width), mode="nearest").squeeze(1)


def _match_mask_batch(mask: torch.Tensor, batch_size: int) -> torch.Tensor:
    mask_batch = int(mask.shape[0])
    if mask_batch == batch_size:
        return mask
    if mask_batch <= 0:
        raise ValueError("Mask batch is empty.")
    if mask_batch < batch_size:
        repeats = (batch_size + mask_batch - 1) // mask_batch
        return mask.repeat((repeats, 1, 1))[:batch_size]
    return mask[:batch_size]


def _draw_mask_on_image(
    image: torch.Tensor,
    mask: torch.Tensor,
    color: str = "#00ff00",
    device: str = "auto",
    opacity: float = 1.0,
    invert_mask: bool = False,
) -> torch.Tensor:
    if image.ndim != 4:
        raise ValueError(f"Expected IMAGE shape [B,H,W,C], got {tuple(image.shape)}.")
    if image.shape[-1] < 3:
        raise ValueError("Draw Mask On Image requires an RGB or RGBA image.")

    batch_size, height, width, channels = image.shape
    target_device = _resolve_device(device, image)
    rgb, color_alpha = _parse_color(color)

    images = image.to(device=target_device, dtype=torch.float32).clamp(0.0, 1.0)
    masks = _normalize_mask(mask).to(device=target_device, dtype=torch.float32)
    masks = _resize_mask(masks, int(height), int(width))
    masks = _match_mask_batch(masks, int(batch_size)).clamp(0.0, 1.0)
    if invert_mask:
        masks = 1.0 - masks

    blend = masks.unsqueeze(-1) * _clamp01(opacity) * color_alpha
    fill = torch.tensor(rgb, dtype=images.dtype, device=target_device).view(1, 1, 1, 3)
    out_rgb = images[..., :3] * (1.0 - blend) + fill * blend

    if channels == 3:
        output = out_rgb
    elif channels == 4:
        output_alpha = torch.maximum(images[..., 3:4], blend)
        output = torch.cat((out_rgb, output_alpha), dim=-1)
    else:
        output = torch.cat((out_rgb, images[..., 3:]), dim=-1)

    return output.to(device="cpu", dtype=image.dtype).clamp(0.0, 1.0)


if io is not None:

    class GGDrawMaskOnImage(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id=GG_NODE_ID,
                display_name=GG_DISPLAY_NAME,
                category=CATEGORY,
                description=(
                    "Draws a mask over an image using vectorized alpha blending. "
                    "Supports RGB/RGBA hex colors and comma-separated RGB/RGBA values."
                ),
                search_aliases=["DrawMaskOnImage", "Draw Mask On Image", "KJNodes"],
                inputs=[
                    io.Image.Input("图像"),
                    io.Custom("MASK").Input("蒙版"),
                    io.Color.Input("颜色", default="#00ff00"),
                    io.Combo.Input("设备", options=DEVICE_OPTIONS, default="auto"),
                    io.Float.Input("不透明度", default=1.0, min=0.0, max=1.0, step=0.01),
                    io.Boolean.Input("反转蒙版", default=False),
                ],
                outputs=[
                    io.Image.Output(display_name="图像"),
                ],
            )

        @classmethod
        def execute(
            cls,
            图像: torch.Tensor,
            蒙版: torch.Tensor,
            颜色: str = "#00ff00",
            设备: str = "auto",
            不透明度: float = 1.0,
            反转蒙版: bool = False,
        ):
            return io.NodeOutput(
                _draw_mask_on_image(
                    image=图像,
                    mask=蒙版,
                    color=颜色,
                    device=设备,
                    opacity=不透明度,
                    invert_mask=反转蒙版,
                )
            )

else:

    class GGDrawMaskOnImage:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    "图像": ("IMAGE",),
                    "蒙版": ("MASK",),
                    "颜色": ("COLOR", {"default": "#00ff00"}),
                    "设备": (DEVICE_OPTIONS, {"default": "auto"}),
                    "不透明度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                    "反转蒙版": ("BOOLEAN", {"default": False}),
                },
            }

        RETURN_TYPES = ("IMAGE",)
        RETURN_NAMES = ("图像",)
        FUNCTION = "apply"
        CATEGORY = CATEGORY
        DESCRIPTION = (
            "Draws a mask over an image using vectorized alpha blending. "
            "Supports RGB/RGBA hex colors and comma-separated RGB/RGBA values."
        )

        def apply(
            self,
            图像: torch.Tensor,
            蒙版: torch.Tensor,
            颜色: str = "#00ff00",
            设备: str = "auto",
            不透明度: float = 1.0,
            反转蒙版: bool = False,
        ):
            return (
                _draw_mask_on_image(
                    image=图像,
                    mask=蒙版,
                    color=颜色,
                    device=设备,
                    opacity=不透明度,
                    invert_mask=反转蒙版,
                ),
            )


NODE_CLASS_MAPPINGS = {
    GG_NODE_ID: GGDrawMaskOnImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    GG_NODE_ID: GG_DISPLAY_NAME,
}
