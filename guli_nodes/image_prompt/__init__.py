from .model_loader import GG反推模型
from .image_prompt import GG图像反推

NODE_CLASS_MAPPINGS = {
    "GG反推模型": GG反推模型,
    "GG图像反推": GG图像反推
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GG反推模型": "GG 反推模型",
    "GG图像反推": "GG 图像反推"
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
