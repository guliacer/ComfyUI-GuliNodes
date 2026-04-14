import random

# Global last seed for "use previous" mode
_last_seed = 1


class GGSeedGenerator:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "seed": ("INT", {"default": -1, "min": -1, "max": 0xffffffffffffffff}),
                "use_previous": ("BOOLEAN", {"default": False, "label": "使用上次种子"}),
            }
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("seed",)
    FUNCTION = "generate"
    CATEGORY = "GuliNodes/工具"
    DESCRIPTION = "生成随机种子，支持使用上次种子"

    def generate(self, seed: int, use_previous: bool) -> tuple:
        """生成种子值"""
        global _last_seed
        
        if use_previous:
            return (_last_seed,)
        
        if seed == -1:
            # Generate a random seed
            seed = random.randint(0, 0xffffffffffffffff)
        
        # Update the last seed
        _last_seed = seed
        
        return (seed,)


NODE_CLASS_MAPPINGS = {
    "GGSeedGenerator": GGSeedGenerator,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGSeedGenerator": "GG 种子生成器",
}
