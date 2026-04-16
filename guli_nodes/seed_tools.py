import random
from datetime import datetime

# Global last seed for "use previous" mode
_last_seed = 1

# Random seed state
initial_random_state = random.getstate()
random.seed(datetime.now().timestamp())
_gg_seed_random_state = random.getstate()
random.setstate(initial_random_state)


def _gg_new_random_seed() -> int:
    """生成新的随机种子"""
    global _gg_seed_random_state
    prev_state = random.getstate()
    random.setstate(_gg_seed_random_state)
    seed = random.randint(1, 1125899906842624)
    _gg_seed_random_state = random.getstate()
    random.setstate(prev_state)
    return seed


class GGSeedGenerator:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "mode": (["随机", "手动", "上次", "增加50"], {"default": "随机"}),
                "seed": ("INT", {"default": 1, "min": -1, "max": 0xffffffffffffffff}),
                "use_previous": ("BOOLEAN", {"default": False, "label": "使用上次种子"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("seed",)
    FUNCTION = "generate"
    CATEGORY = "GuliNodes/工具"
    DESCRIPTION = "生成随机种子，支持多种模式和使用上次种子"

    def generate(self, mode: str = "随机", seed: int = 1, use_previous: bool = False, prompt: dict = None, extra_pnginfo: dict = None, unique_id: str = None) -> tuple:
        """生成种子值"""
        global _last_seed
        
        # 优先使用上次种子
        if use_previous:
            return (_last_seed,)
        
        # 根据模式生成种子
        if mode == "随机":
            if seed == -1:
                # 使用内置随机函数
                result_seed = random.randint(0, 0xffffffffffffffff)
            else:
                # 使用专用随机函数
                result_seed = _gg_new_random_seed()
        elif mode == "手动":
            result_seed = seed if seed != -1 else random.randint(0, 0xffffffffffffffff)
        elif mode == "上次":
            result_seed = _last_seed
        elif mode == "增加50":
            result_seed = _last_seed + 50
        else:
            result_seed = seed if seed != -1 else random.randint(0, 0xffffffffffffffff)
        
        # 更新上次种子
        _last_seed = result_seed
        
        return (result_seed,)


NODE_CLASS_MAPPINGS = {
    "GGSeedGenerator": GGSeedGenerator,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGSeedGenerator": "GG 种子生成器",
}