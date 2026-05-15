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
    CATEGORY = "GuliNodes/\u6587\u672c\u5de5\u5177"
    DESCRIPTION = "\u53ef\u76f4\u63a5\u6267\u884c\u7684\u6587\u672c\u5c55\u793a\u8282\u70b9\uff0c\u5e76\u63d0\u4f9b\u5feb\u901f\u590d\u5236\u5230\u526a\u8d34\u677f\u7684\u6309\u94ae"
    OUTPUT_NODE = True

    def display(self, 文本: str = "", 文本输入: str | None = None) -> dict:
        display_text = 文本 if 文本输入 is None else str(文本输入)
        return {"ui": {"文本": [display_text]}, "result": (display_text,)}


class GGCLIPTextEncode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "CLIP模型": ("CLIP", {"tooltip": "用于编码文本提示词的 CLIP 模型。"}),
                "文本": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "tooltip": "需要编码为条件的文本提示词。"}),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("条件",)
    FUNCTION = "encode"
    CATEGORY = "GuliNodes/文本工具"
    DESCRIPTION = "带读取剪贴板按钮的 CLIP 文本编码器。"

    def encode(self, CLIP模型, 文本: str = "") -> tuple:
        if CLIP模型 is None:
            raise RuntimeError("CLIP 输入无效：未检测到 CLIP 模型。")
        tokens = CLIP模型.tokenize(文本 or "")
        return (CLIP模型.encode_from_tokens_scheduled(tokens),)

    @classmethod
    def IS_CHANGED(cls, CLIP模型, 文本: str = ""):
        import hashlib
        m = hashlib.sha256()
        m.update(文本.encode("utf-8"))
        clip_id = id(CLIP模型) if CLIP模型 is not None else 0
        m.update(str(clip_id).encode("utf-8"))
        return m.hexdigest()


NODE_CLASS_MAPPINGS = {
    "GGTextDisplayCopy": GGTextDisplayCopy,
    "GGCLIPTextEncode": GGCLIPTextEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGTextDisplayCopy": "GG \u6587\u672c",
    "GGCLIPTextEncode": "GG CLIP文本编码器",
}
