# 图像反推模块初始化

from .model_loader import GG模型加载器
from .image_prompt import GG图像推理

NODE_CLASS_MAPPINGS = {
    "GG模型加载器": GG模型加载器,
    "GG图像推理": GG图像推理
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GG模型加载器": "GG 模型加载器",
    "GG图像推理": "GG 图像推理"
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]