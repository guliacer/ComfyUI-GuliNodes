import random
from datetime import datetime


class GGSeedGenerator:
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
    def INPUT_TYPES(cls):
        return {
            "required": {
                "种子来源": (
                    [cls._SOURCE_RANDOM, cls._SOURCE_MANUAL, cls._SOURCE_LAST],
                    {"default": cls._SOURCE_RANDOM},
                ),
                "种子": ("INT", {"default": 1, "min": 0, "max": cls._MAX_SEED}),
                "偏移模式": (
                    [
                        cls._OFFSET_KEEP,
                        cls._OFFSET_ADD,
                        cls._OFFSET_SUB,
                    ],
                    {"default": cls._OFFSET_KEEP},
                ),
                "步长": ("INT", {"default": 500, "min": 1, "max": cls._MAX_SEED}),
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

    @classmethod
    def _resolve_base_seed(cls, 种子来源: str, 种子: int) -> int:
        if 种子来源 == cls._SOURCE_RANDOM:
            return cls._gg_new_random_seed()
        if 种子来源 == cls._SOURCE_MANUAL:
            return 种子
        return cls._last_seed

    @classmethod
    def _apply_offset(cls, 种子: int, 偏移模式: str, 步长: int) -> int:
        if 偏移模式 == cls._OFFSET_ADD:
            return 种子 + 步长
        if 偏移模式 == cls._OFFSET_SUB:
            return 种子 - 步长
        return 种子

    def generate(
        self,
        种子来源: str = _SOURCE_RANDOM,
        种子: int = 1,
        偏移模式: str = _OFFSET_KEEP,
        步长: int = 500,
        prompt: dict = None,
        extra_pnginfo: dict = None,
        unique_id: str = None,
    ) -> tuple:
        种子 = GGSeedGenerator._normalize_seed(种子)
        步长 = max(1, GGSeedGenerator._normalize_seed(步长))

        result_seed = GGSeedGenerator._resolve_base_seed(种子来源, 种子)
        result_seed = GGSeedGenerator._apply_offset(result_seed, 偏移模式, 步长)
        result_seed = GGSeedGenerator._normalize_seed(result_seed)

        GGSeedGenerator._last_seed = result_seed
        return (result_seed,)


GGSeedGenerator._init_random_state()


NODE_CLASS_MAPPINGS = {
    "GGSeedGenerator": GGSeedGenerator,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGSeedGenerator": "GG 种子生成器",
}
