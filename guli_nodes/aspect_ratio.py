import torch

ASPECT_RATIOS = ["1:1", "3:2", "4:3", "5:4", "16:9", "21:9", "9:16", "2:3", "3:4", "4:5", "9:21"]
ASPECT_PRESETS = {"1:1": (1, 1), "3:2": (3, 2), "4:3": (4, 3), "5:4": (5, 4), "16:9": (16, 9),
                  "21:9": (21, 9), "9:16": (9, 16), "2:3": (2, 3), "3:4": (3, 4), "4:5": (4, 5), "9:21": (9, 21)}
SIDE_TYPES = ["最长边", "最短边"]


class GGAspectRatioAdapter:
    @staticmethod
    def _align_to_eight(value: int) -> int:
        return max(8, (value // 8) * 8)

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "宽高比例": (ASPECT_RATIOS, {"default": "16:9"}),
                "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "边长类型": (SIDE_TYPES, {"default": "最长边"}),
            }
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("宽度", "高度")
    FUNCTION = "calculate"
    CATEGORY = "GuliNodes/图像尺寸工具"

    def calculate(self, 宽高比例: str, 边长: int, 边长类型: str) -> tuple:
        wr, hr = ASPECT_PRESETS[宽高比例]
        if 边长类型 == "最长边":
            width = 边长 if wr > hr else int(边长 * wr / hr)
            height = int(边长 * hr / wr) if wr > hr else 边长
        else:
            height = 边长 if wr > hr else int(边长 * hr / wr)
            width = int(边长 * wr / hr) if wr > hr else 边长
        width = self._align_to_eight(width)
        height = self._align_to_eight(height)
        return (width, height)


class GGAspectRatioLatent:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "宽高比例": (ASPECT_RATIOS, {"default": "16:9"}),
                "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "边长类型": (SIDE_TYPES, {"default": "最长边"}),
                "批量大小": ("INT", {"default": 1, "min": 1, "max": 64}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "generate"
    CATEGORY = "GuliNodes/图像尺寸工具"

    def generate(self, 宽高比例: str, 边长: int, 边长类型: str, 批量大小: int) -> tuple:
        adapter = GGAspectRatioAdapter()
        width, height = adapter.calculate(宽高比例, 边长, 边长类型)
        latent = torch.zeros([批量大小, 4, height // 8, width // 8])
        return ({"samples": latent},)


class GGImageToLatent:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "模式": (["手动", "参考图像"], {"default": "手动"}),
            },
            "optional": {
                "宽高比例": (ASPECT_RATIOS, {"default": "16:9"}),
                "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "边长类型": (SIDE_TYPES, {"default": "最长边"}),
                "批量大小": ("INT", {"default": 1, "min": 1, "max": 64}),
                "image": ("IMAGE",),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "convert"
    CATEGORY = "GuliNodes/图像尺寸工具"

    def convert(self, 模式: str = "手动", 宽高比例: str = "16:9", 边长: int = 1024, 边长类型: str = "最长边", 批量大小: int = 1, image: torch.Tensor = None) -> tuple:
        if 模式 == "参考图像" and image is not None:
            if len(image.shape) == 4:
                h, w = image.shape[1], image.shape[2]
            else:
                h, w = image.shape[0], image.shape[1]
            height = GGAspectRatioAdapter._align_to_eight(int(h))
            width = GGAspectRatioAdapter._align_to_eight(int(w))
            return ({"samples": torch.zeros([批量大小, 4, height // 8, width // 8])},)
        else:
            adapter = GGAspectRatioAdapter()
            width, height = adapter.calculate(宽高比例, 边长, 边长类型)
            return ({"samples": torch.zeros([批量大小, 4, height // 8, width // 8])},)


NODE_CLASS_MAPPINGS = {
    "GGAspectRatioAdapter": GGAspectRatioAdapter,
    "GGAspectRatioLatent": GGAspectRatioLatent,
    "GGImageToLatent": GGImageToLatent,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGAspectRatioAdapter": "GG 图像比例",
    "GGAspectRatioLatent": "GG Latent",
    "GGImageToLatent": "GG 图像-Latent",
}
