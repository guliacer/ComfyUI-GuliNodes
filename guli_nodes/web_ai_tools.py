
WEB_AI_PLATFORMS = [
    "豆包",
    "腾讯元宝",
    "文心一言",
    "自定义",
]


class GGWebAIReverseImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "平台": (WEB_AI_PLATFORMS, {"default": "豆包"}),
            },
            "optional": {
                "自定义网址": ("STRING", {"default": "", "multiline": False, "dynamicPrompts": False}),
                "节点高度": ("INT", {"default": 1100, "min": 360, "max": 1500, "step": 20}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "open_web"
    CATEGORY = "GuliNodes/AI"
    OUTPUT_NODE = True
    DESCRIPTION = "在节点内打开 AI 平台网页版。"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        import hashlib
        m = hashlib.sha256()
        m.update(str(kwargs.get("平台", "豆包")).encode("utf-8"))
        m.update(str(kwargs.get("自定义网址", "")).encode("utf-8"))
        m.update(str(kwargs.get("节点高度", 820)).encode("utf-8"))
        return m.hexdigest()

    def open_web(self, 平台="豆包", 自定义网址="", 节点高度=820):
        try:
            panel_height = int(节点高度)
        except (TypeError, ValueError):
            panel_height = 820
        panel_height = max(360, min(1500, panel_height))

        return {
            "ui": {
                "guli_web_ai_reverse": [
                    {
                        "platform": str(平台 or "豆包"),
                        "custom_url": str(自定义网址 or ""),
                        "height": panel_height,
                    }
                ]
            }
        }


NODE_CLASS_MAPPINGS = {
    "GGWebAIReverseImage": GGWebAIReverseImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGWebAIReverseImage": "GG 网页AI图像反推",
}
