CLIP_TEXT_NODE_ID = "GGCLIPText"
CLIP_TEXT_DISPLAY_NAME = "GG CLIP文本"
class GGTextDisplayCopy:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            },
            "optional": {
                "文本输入": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "display"
    CATEGORY = "GuliNodes/文本"
    DESCRIPTION = "\u53ef\u76f4\u63a5\u6267\u884c\u7684\u6587\u672c\u5c55\u793a\u8282\u70b9\uff0c\u5e76\u63d0\u4f9b\u5feb\u901f\u590d\u5236\u5230\u526a\u8d34\u677f\u7684\u6309\u94ae"
    OUTPUT_NODE = True

    def display(self, 文本: str = "", 文本输入: str | None = None) -> dict:
        display_text = 文本 if 文本输入 is None else str(文本输入)
        return {"ui": {"文本": [display_text]}, "result": (display_text,)}


class GGCLIPText:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "连接 CLIPLoader 的输出；本节点只编码文本，不在内部加载模型。"}),
                "文本": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "tooltip": "需要编码为条件的提示词文本。"}),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("条件",)
    FUNCTION = "encode"
    CATEGORY = "GuliNodes/文本"
    DESCRIPTION = "使用外接 CLIP 编码文本，不在节点内部加载或缓存模型。"

    def encode(self, clip, 文本="") -> tuple:
        if clip is None:
            raise RuntimeError("未连接 CLIP：请连接上游 CLIPLoader 的输出。")
        text = 文本 or ""
        tokens = clip.tokenize(text)
        return (clip.encode_from_tokens_scheduled(tokens),)


NODE_CLASS_MAPPINGS = {
    "GGTextDisplayCopy": GGTextDisplayCopy,
    CLIP_TEXT_NODE_ID: GGCLIPText,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGTextDisplayCopy": "GG \u6587\u672c",
    CLIP_TEXT_NODE_ID: CLIP_TEXT_DISPLAY_NAME,
}
