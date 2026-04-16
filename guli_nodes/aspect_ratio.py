import torch
import torch.nn.functional as torch_F

ASPECT_RATIOS = ["1:1", "3:2", "4:3", "5:4", "16:9", "21:9", "9:16", "2:3", "3:4", "4:5", "9:21"]
ASPECT_PRESETS = {"1:1": (1, 1), "3:2": (3, 2), "4:3": (4, 3), "5:4": (5, 4), "16:9": (16, 9),
                  "21:9": (21, 9), "9:16": (9, 16), "2:3": (2, 3), "3:4": (3, 4), "4:5": (4, 5), "9:21": (9, 21)}
SIDE_TYPES = ["最长边", "最短边"]


class GGAspectRatioAdapter:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "aspect_ratio": (ASPECT_RATIOS, {"default": "16:9"}),
                "side_length": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "side_type": (SIDE_TYPES, {"default": "最长边"}),
            }
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "calculate"
    CATEGORY = "GuliNodes/图像尺寸工具"

    def calculate(self, aspect_ratio: str, side_length: int, side_type: str) -> tuple:
        """计算指定比例和边长的宽高"""
        wr, hr = ASPECT_PRESETS[aspect_ratio]
        if side_type == "最长边":
            width = side_length if wr > hr else int(side_length * wr / hr)
            height = int(side_length * hr / wr) if wr > hr else side_length
        else:
            height = side_length if wr > hr else int(side_length * hr / wr)
            width = int(side_length * wr / hr) if wr > hr else side_length
        width = (width // 8) * 8
        height = (height // 8) * 8
        return (width, height)


class GGAspectRatioLatent:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "aspect_ratio": (ASPECT_RATIOS, {"default": "16:9"}),
                "side_length": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "side_type": (SIDE_TYPES, {"default": "最长边"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "generate"
    CATEGORY = "GuliNodes/图像尺寸工具"

    def generate(self, aspect_ratio: str, side_length: int, side_type: str, batch_size: int) -> tuple:
        """生成指定比例的Latent"""
        adapter = GGAspectRatioAdapter()
        width, height = adapter.calculate(aspect_ratio, side_length, side_type)
        latent = torch.zeros([batch_size, 4, height // 8, width // 8])
        return ({"samples": latent},)


class GGImageToLatent(GGAspectRatioLatent):
    @classmethod
    def INPUT_TYPES(s):
        base = GGAspectRatioLatent.INPUT_TYPES()
        base["optional"] = base["required"]
        base["required"] = {
            "mode": (["手动", "参考图像"], {"default": "手动"}),
        }
        base["optional"]["image"] = ("IMAGE",)
        return base

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "convert"
    CATEGORY = "GuliNodes/图像尺寸工具"

    def convert(self, mode: str = "手动", aspect_ratio: str = "16:9", side_length: int = 1024, side_type: str = "最长边", batch_size: int = 1, image: torch.Tensor = None) -> tuple:
        """根据手动设置或参考图像生成Latent"""
        if mode == "参考图像" and image is not None:
            # Get image dimensions from input image
            if len(image.shape) == 4:
                h, w = image.shape[1], image.shape[2]
            else:
                h, w = image.shape[0], image.shape[1]
            # Create latent with image dimensions
            return ({"samples": torch.zeros([batch_size, 4, h // 8, w // 8])},)
        else:
            # Use manual settings like AspectRatioLatent
            adapter = GGAspectRatioAdapter()
            width, height = adapter.calculate(aspect_ratio, side_length, side_type)
            return ({"samples": torch.zeros([batch_size, 4, height // 8, width // 8])},)


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