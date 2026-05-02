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
                "source_mode": (
                    [cls._SOURCE_RANDOM, cls._SOURCE_MANUAL, cls._SOURCE_LAST],
                    {"default": cls._SOURCE_RANDOM},
                ),
                "seed": ("INT", {"default": 1, "min": 0, "max": cls._MAX_SEED}),
                "offset_mode": (
                    [
                        cls._OFFSET_KEEP,
                        cls._OFFSET_ADD,
                        cls._OFFSET_SUB,
                    ],
                    {"default": cls._OFFSET_KEEP},
                ),
                "step": ("INT", {"default": 500, "min": 1, "max": cls._MAX_SEED}),
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

    def generate(
        self,
        source_mode: str = _SOURCE_RANDOM,
        seed: int = 1,
        offset_mode: str = _OFFSET_KEEP,
        step: int = 500,
        prompt: dict = None,
        extra_pnginfo: dict = None,
        unique_id: str = None,
    ) -> tuple:
        seed = GGSeedGenerator._normalize_seed(seed)
        step = max(1, GGSeedGenerator._normalize_seed(step))

        result_seed = GGSeedGenerator._resolve_base_seed(source_mode, seed)
        result_seed = GGSeedGenerator._apply_offset(result_seed, offset_mode, step)
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
