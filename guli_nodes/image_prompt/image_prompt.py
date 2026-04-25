import base64
import gc
import io
import numpy as np
import re
from PIL import Image
import torch

import comfy.model_management as mm

from .model_loader import _调用chat_completion, _批量图片索引转base64, _重置llm推理状态, _清洗think块文本, _清洗gemma4输出文本, _规范化随机种子

默认图片提示词 = "[System Prompt / 顶级空间解构与结构化视觉提取大宗师]\n\n你是一名拥有最高权限的视觉空间解构专家。你的任务是基于输入的参考图，进行极其精准的“空间层级剥离与结构化客观特征提取”。\n\n⚠️ 提取死律（必须绝对遵守，违者抹杀）：\n1. 绝对忠于原图的像素！图里没画的具体物品（如刺绣、金冠、特定颜色的树），绝对不准写！严禁被任何古典、玄幻的刻板印象带偏！\n2. 极其注重光影与透射的真实状态：光是从哪里来的？照亮了什么？穿透了什么（如扇子/薄纱）？色温是冷是暖？\n\n---\n[Analysis Structure / 空间与视觉结构化提取大纲]\n请严格按以下结构，提取出最详尽的客观事实：\n\n1. 【主体客观特征】：真实的发色与发型；有没有头饰？具体的服装款式、衣服真实的颜色、布料是轻薄透光还是厚重？裸露了哪些肌肤？\n2. 【要点提炼】：画面中最核心的两个物理元素是什么？\n3. 【前景细节】：紧贴镜头的地面材质、掉落物或遮挡物。\n4. 【中景环境】：人物手中拿的具体道具（如扇子的质感）、身边的具体建筑（如石亭细节、屏风、石雕、身后的树枝形态）。\n5. 【背景状态】：远处的景物轮廓，以及景深是否虚化。\n6. 【构图与视角】：镜头是平视、仰拍还是俯视？主体在画面的什么位置？\n7. 【视觉与视线引导】：她的神情是怎样的？眼神看向哪个具体的物体或方向？\n8. 【全局色调】：画面真正的主色调是什么？冷暖对比是如何分布的？\n9. 【风格锚定】：提取画面的现实主义质感。\n10. 【光影与光感分布】：光源的具体方向；光线照射在人脸、扇子或建筑上产生的具体光感与阴影；是否有斑驳的透射光。\n\n【水印处理】\n绝对无痕去除水印。"
默认图片系统提示词 = ""


def _执行内存清理(清理缓存: bool = True, 卸载模型: bool = True) -> None:
    if 卸载模型:
        try:
            mm.unload_all_models()
        except Exception as exc:
            print(f"GG 图像反推: 卸载模型失败: {exc}")
        try:
            mm.cleanup_models()
        except Exception as exc:
            print(f"GG 图像反推: 清理模型引用失败: {exc}")

    gc.collect()

    if 清理缓存:
        try:
            mm.soft_empty_cache(force=True)
        except Exception as exc:
            print(f"GG 图像反推: 清理缓存失败: {exc}")
        if torch.cuda.is_available():
            try:
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
            except Exception as exc:
                print(f"GG 图像反推: CUDA 缓存清理失败: {exc}")

class GG图像反推:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "模型": ("GGLLAMA",),
                "提示词": ("STRING", {"default": 默认图片提示词, "multiline": True}),
                "系统提示词": ("STRING", {"default": 默认图片系统提示词, "multiline": True}),
                "最大边长": ("INT", {"default": 8192, "min": 128, "max": 16384, "step": 64, "tooltip": "对输入图片做缩放以提速（取最长边）。"}),
                "最大生成token": ("INT", {"default": 8192, "min": 20, "max": 8192, "step": 1, "tooltip": "模型生成的最大 token 数量。"}),
                "温度": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01, "tooltip": "控制生成的随机性，值越高越随机。"}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "核采样参数，控制生成的多样性。"}),
                "top_k": ("INT", {"default": 20, "min": 0, "max": 200, "step": 1, "tooltip": "从 top_k 个最可能的 token 中采样。"}),
                "输出think块": ("BOOLEAN", {"default": False, "tooltip": "开启=保留模型原始思考输出；关闭=仅保留最终答案。"}),
                "内存清理": ("BOOLEAN", {"default": True, "tooltip": "执行完成后自动卸载模型并清理缓存。"}),
            },
            "optional": {
                "图像": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "run"
    CATEGORY = "GuliNodes/图像分析"

    def run(
        self,
        模型,
        提示词,
        系统提示词,
        最大边长,
        最大生成token,
        温度,
        top_p,
        top_k,
        输出think块,
        内存清理=True,
        图像=None,
    ):
        from .model_loader import _QwenStorage, _Gemma4Storage
        
        model_family = getattr(模型, "settings", {}).get("family", "")
        if model_family in ["Qwen3-VL", "Qwen3.5-VL"]:
            storage = _QwenStorage
        elif model_family == "Gemma4":
            storage = _Gemma4Storage
        else:
            raise ValueError(f"未知模型类型：{model_family}")
        
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

        if system_text:
            messages.append({"role": "system", "content": system_text})

        if 图像 is None:
            raise ValueError("未检测到图像输入。")
        if chat_handler is None:
            raise RuntimeError('当前模型未加载 mmproj，无法进行图像推理。请在"GG 模型加载器"里选择对应的 mmproj。')

        params = {
            "max_tokens": int(最大生成token),
            "temperature": float(温度),
            "top_p": float(top_p),
            "top_k": int(top_k),
            "stream": False,
            "stop": ["</s>"],
        }

        prompt_text = (提示词 or "").strip()
        img_b64 = _批量图片索引转base64(图像, 0, int(最大边长))
        if not img_b64:
            raise ValueError("图像转换失败，请检查输入图像。")

        user_content = [{"type": "text", "text": prompt_text}, {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}}]
        messages.append({"role": "user", "content": user_content})
        _重置llm推理状态(llm)
        out = _调用chat_completion(llm, messages=messages, params=params)
        try:
            text = out["choices"][0]["message"]["content"]
        except Exception:
            text = str(out)

        if model_family == "Gemma4":
            text = _清洗gemma4输出文本(text, bool(输出think块))
        elif not bool(输出think块):
            text = _清洗think块文本(text)

        if mm.processing_interrupted():
            raise mm.InterruptProcessingException()

        result_text = text.lstrip().removeprefix(": ").strip()

        if bool(内存清理):
            _执行内存清理(True, True)

        return (result_text,)
