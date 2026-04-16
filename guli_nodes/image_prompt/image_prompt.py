import base64
import io
import numpy as np
import re
from PIL import Image

import comfy.model_management as mm

from .model_loader import _调用chat_completion, _批量图片索引转base64, _重置llm推理状态, _清洗think块文本, _清洗gemma4输出文本, _规范化随机种子

默认图片提示词 = ""
默认图片系统提示词 = "描述这张图,300字左右."
默认文本系统提示词 = "描述这张图,300字左右."

class GG图像推理:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "模型": ("GGLLAMA",),
                "输入模式": (["图片", "文本"], {"default": "图片", "tooltip": "图片=使用图片输入进行推理；文本=使用文本输入进行推理。"}),
                "提示词": ("STRING", {"default": 默认图片提示词, "multiline": True}),
                "系统提示词": ("STRING", {"default": 默认图片系统提示词, "multiline": True}),
                "最大边长": ("INT", {"default": 512, "min": 128, "max": 16384, "step": 64, "tooltip": "对输入图片做缩放以提速（取最长边）。"}),
                "最大生成token": ("INT", {"default": 1024, "min": 20, "max": 8192, "step": 1, "tooltip": "模型生成的最大 token 数量。"}),
                "温度": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01, "tooltip": "控制生成的随机性，值越高越随机。"}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "核采样参数，控制生成的多样性。"}),
                "top_k": ("INT", {"default": 20, "min": 0, "max": 200, "step": 1, "tooltip": "从 top_k 个最可能的 token 中采样。"}),
                "输出think块": ("BOOLEAN", {"default": True, "tooltip": "开启=保留模型原始思考输出；关闭=仅保留最终答案。"}),
            },
            "optional": {
                "图片": ("IMAGE",),
                "文本": ("STRING", {"default": "", "multiline": True, "tooltip": "当输入模式为文本时使用的文本输入。"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "run"
    CATEGORY = "GuliNodes/图像分析"

    def run(
        self,
        模型,
        输入模式,
        提示词,
        系统提示词,
        最大边长,
        最大生成token,
        温度,
        top_p,
        top_k,
        输出think块,
        图片=None,
        文本=None,
    ):
        from .model_loader import _QwenStorage, _Gemma4Storage
        
        # 确定模型类型和存储
        model_family = getattr(模型, "settings", {}).get("family", "")
        if model_family in ["Qwen3-VL", "Qwen3.5-VL"]:
            storage = _QwenStorage
        elif model_family == "Gemma4":
            storage = _Gemma4Storage
        else:
            raise ValueError(f"未知模型类型：{model_family}")
        
        # 卸载后 / 引用失效时：自动重载与同步到当前有效模型
        need_reload = False
        if storage.model is None:
            need_reload = True
        elif 模型 is not storage.model:
            if hasattr(模型, "settings") and getattr(模型, "settings") == storage.model.settings:
                模型 = storage.model
            else:
                need_reload = True

        if need_reload:
            if not hasattr(模型, "settings"):
                raise RuntimeError('输入的模型对象缺少配置信息，无法自动重载。请先运行"GG 模型加载器"。')
            storage.load(模型.settings)
            模型 = storage.model

        if not hasattr(模型, "llm") or 模型.llm is None:
            raise RuntimeError('模型对象内部 llm 实例无效，请检查模型文件完整性，或重新加载模型。')

        llm = 模型.llm
        chat_handler = getattr(模型, "chat_handler", None)

        messages = []
        system_text = (系统提示词 or "").strip()

        if 输入模式 == "文本":
            if not system_text or system_text == 默认图片系统提示词:
                system_text = 默认文本系统提示词

        if system_text:
            messages.append({"role": "system", "content": system_text})

        # 根据输入模式检查相应的输入
        if 输入模式 == "图片":
            if 图片 is None:
                raise ValueError("输入模式为图片时，未检测到图片输入。")
            if chat_handler is None:
                raise RuntimeError('当前模型未加载 mmproj，无法进行图像推理。请在"GG 模型加载器"里选择对应的 mmproj。')
        elif 输入模式 == "文本":
            if 文本 is None or (文本 or "").strip() == "":
                raise ValueError("输入模式为文本时，未检测到文本输入。")
        else:
            raise ValueError(f"未知输入模式：{输入模式}")

        # 根据模型类型调整参数
        params = {
            "max_tokens": int(最大生成token),
            "temperature": float(温度),
            "top_p": float(top_p),
            "top_k": int(top_k),
            "stream": False,
            "stop": ["</s>"],
        }

        prompt_text = (提示词 or "").strip()
        if 输入模式 == "文本":
            text_input = (文本 or "").strip()
            if not text_input:
                raise ValueError("文本模式下，文本输入不能为空。")

            # 使用文本输入作为用户内容
            user_content = text_input
            if prompt_text:
                user_content = f"{prompt_text}\n\n{text_input}"
            
            messages.append({"role": "user", "content": user_content})
            _重置llm推理状态(llm)
            out = _调用chat_completion(llm, messages=messages, params=params)
            try:
                text = out["choices"][0]["message"]["content"]
            except Exception:
                text = str(out)
        else:  # 图片模式
            # 只处理第一张图片
            img_b64 = _批量图片索引转base64(图片, 0, int(最大边长))
            if not img_b64:
                raise ValueError("图片转换失败，请检查输入图片。")
            
            user_content = [{"type": "text", "text": prompt_text}, {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}}]
            messages.append({"role": "user", "content": user_content})
            _重置llm推理状态(llm)
            out = _调用chat_completion(llm, messages=messages, params=params)
            try:
                text = out["choices"][0]["message"]["content"]
            except Exception:
                text = str(out)

        # 根据模型类型清洗输出
        if model_family == "Gemma4":
            text = _清洗gemma4输出文本(text, bool(输出think块))
        elif not bool(输出think块):
            text = _清洗think块文本(text)

        if mm.processing_interrupted():
            raise mm.InterruptProcessingException()

        return (text.lstrip().removeprefix(": ").strip(),)