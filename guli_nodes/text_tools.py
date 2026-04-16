class GGTextJoin:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text_a": ("STRING", {"default": "", "multiline": True}),
                "text_b": ("STRING", {"default": "", "multiline": True}),
                "separator": ("STRING", {"default": "\n"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "join"
    CATEGORY = "GuliNodes/文本工具"

    def join(self, text_a: str = "", text_b: str = "", separator: str = "\n") -> tuple:
        """合并两个文本"""
        combined = text_a + separator + text_b if text_a and text_b else (text_a or text_b)
        return (combined,)


NODE_CLASS_MAPPINGS = {
    "GGTextJoin": GGTextJoin,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGTextJoin": "GG 文本合并",
}