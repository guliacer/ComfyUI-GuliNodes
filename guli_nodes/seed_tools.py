import random
from datetime import datetime


class GGSeedGenerator:
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
        seed = random.randint(1, 1125899906842624)
        cls._gg_seed_random_state = random.getstate()
        random.setstate(prev_state)
        return seed

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "control": (["随机", "手动", "上次", "增加", "减少", "增加50", "减少50", "固定"], {"default": "随机"}),
                "seed": ("INT", {"default": 1, "min": -1, "max": 0xffffffffffffffff}),
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

    def generate(self, control: str = "随机", seed: int = 1, prompt: dict = None, extra_pnginfo: dict = None, unique_id: str = None) -> tuple:
        if control == "随机":
            if seed == -1:
                result_seed = random.randint(0, 0xffffffffffffffff)
            else:
                result_seed = GGSeedGenerator._gg_new_random_seed()
        elif control == "手动":
            result_seed = seed if seed != -1 else random.randint(0, 0xffffffffffffffff)
        elif control == "上次":
            result_seed = GGSeedGenerator._last_seed
        elif control == "增加":
            result_seed = GGSeedGenerator._last_seed + 1
        elif control == "减少":
            result_seed = GGSeedGenerator._last_seed - 1
        elif control == "增加50":
            result_seed = GGSeedGenerator._last_seed + 50
        elif control == "减少50":
            result_seed = GGSeedGenerator._last_seed - 50
        elif control == "固定":
            result_seed = GGSeedGenerator._last_seed
        else:
            result_seed = seed if seed != -1 else random.randint(0, 0xffffffffffffffff)

        GGSeedGenerator._last_seed = result_seed

        return (result_seed,)


GGSeedGenerator._init_random_state()


NODE_CLASS_MAPPINGS = {
    "GGSeedGenerator": GGSeedGenerator,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGSeedGenerator": "GG 种子生成器",
}
