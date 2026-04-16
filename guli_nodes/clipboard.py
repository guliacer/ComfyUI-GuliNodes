class GGClipboardReader:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "optional": {
                "text": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "read"
    CATEGORY = "GuliNodes/文本工具"
    DESCRIPTION = "读取系统剪贴板内容，无需手动复制粘贴"

    def read(self, text: str = "") -> tuple:
        """读取剪贴板内容"""
        return (text,)


NODE_CLASS_MAPPINGS = {
    "GGClipboardReader": GGClipboardReader,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGClipboardReader": "GG 剪贴板读取",
}