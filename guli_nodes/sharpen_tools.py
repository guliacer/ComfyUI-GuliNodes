import torch
import torch.nn.functional as F


def _min_tensors(tensors):
    value = tensors[0]
    for tensor in tensors[1:]:
        value = torch.minimum(value, tensor)
    return value


def _max_tensors(tensors):
    value = tensors[0]
    for tensor in tensors[1:]:
        value = torch.maximum(value, tensor)
    return value


def _pad_neighborhood(image_nchw: torch.Tensor) -> torch.Tensor:
    height, width = image_nchw.shape[-2:]
    mode = "reflect" if height > 1 and width > 1 else "replicate"
    return F.pad(image_nchw, pad=(1, 1, 1, 1), mode=mode)


def _cas_sharpen(image: torch.Tensor, amount: float) -> torch.Tensor:
    if image.ndim != 4:
        raise ValueError("IMAGE must be a BHWC tensor.")

    work = image
    if not torch.is_floating_point(work) or work.dtype in (torch.float16, torch.bfloat16):
        work = work.float()

    amount = max(0.0, min(float(amount), 1.0))
    epsilon = torch.finfo(work.dtype).eps * 16
    padded = _pad_neighborhood(work.permute(0, 3, 1, 2).contiguous())

    a = padded[..., :-2, :-2]
    b = padded[..., :-2, 1:-1]
    c = padded[..., :-2, 2:]
    d = padded[..., 1:-1, :-2]
    e = padded[..., 1:-1, 1:-1]
    f = padded[..., 1:-1, 2:]
    g = padded[..., 2:, :-2]
    h = padded[..., 2:, 1:-1]
    i = padded[..., 2:, 2:]

    cross_min = _min_tensors((b, d, e, f, h))
    cross_max = _max_tensors((b, d, e, f, h))
    diag_min = _min_tensors((a, c, g, i))
    diag_max = _max_tensors((a, c, g, i))

    local_min = cross_min + diag_min
    local_max = cross_max + diag_max
    amp = torch.reciprocal(local_max + epsilon) * torch.minimum(local_min, 2.0 - local_max)
    amp = torch.sqrt(torch.clamp(amp, min=0.0))
    weight = -amp * (amount * (1.0 / 5.0 - 1.0 / 8.0) + 1.0 / 8.0)
    divisor = torch.reciprocal(1.0 + 4.0 * weight)

    output = ((b + d + f + h) * weight + e) * divisor
    output = torch.nan_to_num(output, nan=0.0, posinf=1.0, neginf=0.0)
    return output.clamp(0.0, 1.0).permute(0, 2, 3, 1).contiguous()


class GGImageCASharpeningPlus:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "\u56fe\u50cf": ("IMAGE",),
                "\u5f3a\u5ea6": (
                    "FLOAT",
                    {
                        "default": 0.8,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "round": 0.01,
                        "tooltip": "Contrast-adaptive sharpening amount.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("\u56fe\u50cf",)
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像"
    DESCRIPTION = "CAS-style contrast-adaptive image sharpening implemented with native PyTorch tensors."

    def execute(self, **kwargs):
        image = kwargs["\u56fe\u50cf"]
        amount = kwargs.get("\u5f3a\u5ea6", 0.8)
        return (_cas_sharpen(image, amount),)


NODE_CLASS_MAPPINGS = {
    "GGImageCASharpeningPlus": GGImageCASharpeningPlus,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGImageCASharpeningPlus": "GG \u56fe\u50cfCAS\u9510\u5316+",
}
