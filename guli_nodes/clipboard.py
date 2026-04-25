class GGClipboardReader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "text": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "read"
    CATEGORY = "GuliNodes/\u6587\u672c\u5de5\u5177"
    DESCRIPTION = "\u8bfb\u53d6\u7cfb\u7edf\u526a\u8d34\u677f\u5185\u5bb9\uff0c\u65e0\u9700\u624b\u52a8\u590d\u5236\u7c98\u8d34"

    def read(self, text: str = "") -> tuple:
        return (text,)


class GGTextDisplayCopy:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            },
            "optional": {
                "text_input": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "display"
    CATEGORY = "GuliNodes/\u6587\u672c\u5de5\u5177"
    DESCRIPTION = "\u53ef\u76f4\u63a5\u6267\u884c\u7684\u6587\u672c\u5c55\u793a\u8282\u70b9\uff0c\u5e76\u63d0\u4f9b\u5feb\u901f\u590d\u5236\u5230\u526a\u8d34\u677f\u7684\u6309\u94ae"
    OUTPUT_NODE = True

    def display(self, text: str = "", text_input: str | None = None) -> dict:
        display_text = text if text_input is None else str(text_input)
        return {"ui": {"text": [display_text]}, "result": (display_text,)}


class GGCLIPTextEncode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "用于编码文本提示词的 CLIP 模型。"}),
                "text": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "tooltip": "需要编码为条件的文本提示词。"}),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("条件",)
    FUNCTION = "encode"
    CATEGORY = "GuliNodes/文本工具"
    DESCRIPTION = "带读取剪贴板按钮的 CLIP 文本编码器。"

    def encode(self, clip, text: str = "") -> tuple:
        if clip is None:
            raise RuntimeError("CLIP 输入无效：未检测到 CLIP 模型。")
        tokens = clip.tokenize(text or "")
        return (clip.encode_from_tokens_scheduled(tokens),)


NODE_CLASS_MAPPINGS = {
    "GGClipboardReader": GGClipboardReader,
    "GGTextDisplayCopy": GGTextDisplayCopy,
    "GGCLIPTextEncode": GGCLIPTextEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGClipboardReader": "GG \u526a\u8d34\u677f\u8bfb\u53d6",
    "GGTextDisplayCopy": "GG \u6587\u672c\u5c55\u793a\u590d\u5236",
    "GGCLIPTextEncode": "GG CLIP文本编码器",
}
