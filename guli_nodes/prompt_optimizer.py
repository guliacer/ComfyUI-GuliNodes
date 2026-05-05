import random
import gc
import torch
from datetime import datetime

import comfy.model_management as mm

from .image_prompt.model_loader import _QwenStorage, _Gemma4Storage, _调用chat_completion, _重置llm推理状态, _清洗think块文本, _清洗gemma4输出文本

默认提示词规则 = "你是一名专业的AI绘图提示词优化专家。请根据以下规则优化提示词：\n\n1. 保持原始提示词的核心意图不变\n2. 增加更多具体的视觉细节描述\n3. 优化关键词的排列顺序，将最重要的描述放在前面\n4. 添加适当的画质和风格关键词\n5. 使用英文输出优化后的提示词\n6. 直接输出优化后的提示词，不要添加任何解释或前缀"


class _PromptOptimizerSeed:
    _MAX_SEED = 0xFFFFFFFF
    _SOURCE_RANDOM = "随机"
    _SOURCE_MANUAL = "手动"
    _SOURCE_LAST = "上次"
    _OFFSET_KEEP = "保持"
    _OFFSET_ADD = "增加"
    _OFFSET_SUB = "减少"
    _last_seed = 1

    @classmethod
    def _init_random_state(cls):
        initial_random_state = random.getstate()
        random.seed(datetime.now().timestamp())
        cls._gg_seed_random_state = random.getstate()
        random.setstate(initial_random_state)

    @classmethod
    def _gg_new_random_seed(cls) -> int:
        prev_state = random.getstate()
        random.setstate(cls._gg_seed_random_state)
        seed = random.randint(0, cls._MAX_SEED)
        cls._gg_seed_random_state = random.getstate()
        random.setstate(prev_state)
        return seed

    @classmethod
    def _normalize_seed(cls, seed_value: int) -> int:
        return int(seed_value) % (cls._MAX_SEED + 1)

    @classmethod
    def _resolve_base_seed(cls, source_mode: str, seed: int) -> int:
        if source_mode == cls._SOURCE_RANDOM:
            return cls._gg_new_random_seed()
        if source_mode == cls._SOURCE_MANUAL:
            return seed
        return cls._last_seed

    @classmethod
    def _apply_offset(cls, seed: int, offset_mode: str, step: int) -> int:
        if offset_mode == cls._OFFSET_ADD:
            return seed + step
        if offset_mode == cls._OFFSET_SUB:
            return seed - step
        return seed


_PromptOptimizerSeed._init_random_state()


def _执行内存清理(清理缓存: bool = True, 卸载模型: bool = True) -> None:
    if 卸载模型:
        try:
            mm.unload_all_models()
        except Exception as exc:
            print(f"GG 提示词优化: 卸载模型失败: {exc}")
        try:
            mm.cleanup_models()
        except Exception as exc:
            print(f"GG 提示词优化: 清理模型引用失败: {exc}")

    gc.collect()

    if 清理缓存:
        try:
            mm.soft_empty_cache(force=True)
        except Exception as exc:
            print(f"GG 提示词优化: 清理缓存失败: {exc}")
        if torch.cuda.is_available():
            try:
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
            except Exception as exc:
                print(f"GG 提示词优化: CUDA 缓存清理失败: {exc}")


class GG提示词优化:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("GGLLAMA",),
                "提示词A": ("STRING", {"default": "", "multiline": True}),
                "提示词规则": ("STRING", {"default": 默认提示词规则, "multiline": True}),
                "种子来源": (["随机", "手动", "上次"], {"default": "随机"}),
                "种子": ("INT", {"default": 1, "min": 0, "max": 0xFFFFFFFF}),
                "偏移模式": (["保持", "增加", "减少"], {"default": "保持"}),
                "步长": ("INT", {"default": 500, "min": 1, "max": 0xFFFFFFFF}),
                "最大生成token": ("INT", {"default": 2048, "min": 20, "max": 8192}),
                "温度": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01}),
                "top_k": ("INT", {"default": 20, "min": 0, "max": 200}),
                "输出think块": ("BOOLEAN", {"default": False}),
                "内存清理": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "提示词B": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("优化提示词",)
    FUNCTION = "optimize"
    CATEGORY = "GuliNodes/AI工具"

    def optimize(
        self,
        模型,
        提示词A,
        提示词规则,
        种子来源,
        种子,
        偏移模式,
        步长,
        最大生成token,
        温度,
        top_p,
        top_k,
        输出think块,
        内存清理=True,
        提示词B="",
    ):
        seed = _PromptOptimizerSeed._normalize_seed(种子)
        step = max(1, _PromptOptimizerSeed._normalize_seed(步长))

        result_seed = _PromptOptimizerSeed._resolve_base_seed(种子来源, seed)
        result_seed = _PromptOptimizerSeed._apply_offset(result_seed, 偏移模式, step)
        result_seed = _PromptOptimizerSeed._normalize_seed(result_seed)

        _PromptOptimizerSeed._last_seed = result_seed

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

        messages = []
        system_text = (提示词规则 or "").strip()
        if system_text:
            messages.append({"role": "system", "content": system_text})

        user_text = (提示词A or "").strip()
        提示词B_text = (提示词B or "").strip() if 提示词B else ""
        if 提示词B_text:
            user_text = user_text + "\n" + 提示词B_text if user_text else 提示词B_text

        messages.append({"role": "user", "content": user_text})

        params = {
            "max_tokens": int(最大生成token),
            "temperature": float(温度),
            "top_p": float(top_p),
            "top_k": int(top_k),
            "stream": False,
            "stop": ["</s>"],
            "seed": result_seed,
        }

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


NODE_CLASS_MAPPINGS = {
    "GG提示词优化": GG提示词优化,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GG提示词优化": "GG 提示词优化",
}
