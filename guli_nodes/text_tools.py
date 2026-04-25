import re


class GGTextJoin:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本A": ("STRING", {"default": "", "multiline": True}),
                "文本B": ("STRING", {"default": "", "multiline": True}),
                "分隔符": ("STRING", {"default": "\n"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "join"
    CATEGORY = "GuliNodes/文本工具"

    def join(self, 文本A: str = "", 文本B: str = "", 分隔符: str = "\n") -> tuple:
        combined = 文本A + 分隔符 + 文本B if 文本A and 文本B else (文本A or 文本B)
        return (combined,)


class GGTextSplit:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本": ("STRING", {"default": "", "multiline": True}),
                "分割模式": (["按分隔符", "按长度"], {"default": "按分隔符"}),
            },
            "optional": {
                "分隔符": ("STRING", {"default": ","}),
                "最大长度": ("INT", {"default": 50, "min": 1, "max": 1000, "step": 1}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("部分1", "部分2", "部分3")
    FUNCTION = "split"
    CATEGORY = "GuliNodes/文本工具"

    def split(self, 文本: str = "", 分割模式: str = "按分隔符", 分隔符: str = ",", 最大长度: int = 50) -> tuple:
        parts = ["", "", ""]
        if not 文本:
            return tuple(parts)

        if 分割模式 == "按分隔符":
            split_text = 文本.split(分隔符)
            for i, part in enumerate(split_text[:3]):
                parts[i] = part.strip()
        else:
            parts[0] = 文本[:最大长度]
            if len(文本) > 最大长度:
                parts[1] = 文本[最大长度:最大长度*2]
                if len(文本) > 最大长度*2:
                    parts[2] = 文本[最大长度*2:]

        return tuple(parts)


class GGTextFilter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本": ("STRING", {"default": "", "multiline": True}),
                "过滤模式": (["移除多余空格", "移除特定字符", "移除空白行"], {"default": "移除多余空格"}),
            },
            "optional": {
                "要移除的字符": ("STRING", {"default": "!@#$%^&*"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "filter"
    CATEGORY = "GuliNodes/文本工具"

    def filter(self, 文本: str = "", 过滤模式: str = "移除多余空格", 要移除的字符: str = "!@#$%^&*") -> tuple:
        if not 文本:
            return ("",)

        if 过滤模式 == "移除多余空格":
            return (re.sub(r'\s+', ' ', 文本).strip(),)
        elif 过滤模式 == "移除特定字符":
            for char in 要移除的字符:
                文本 = 文本.replace(char, '')
            return (文本,)
        else:
            lines = 文本.split('\n')
            non_empty_lines = [line for line in lines if line.strip()]
            return ('\n'.join(non_empty_lines),)


class GGTextReplace:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本": ("STRING", {"default": "", "multiline": True}),
                "要替换的文本": ("STRING", {"default": ""}),
                "替换为": ("STRING", {"default": ""}),
                "使用正则": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "replace"
    CATEGORY = "GuliNodes/文本工具"

    def replace(self, 文本: str = "", 要替换的文本: str = "", 替换为: str = "", 使用正则: bool = False) -> tuple:
        if not 文本 or not 要替换的文本:
            return (文本,)

        if 使用正则:
            try:
                return (re.sub(要替换的文本, 替换为, 文本),)
            except:
                return (文本,)
        else:
            return (文本.replace(要替换的文本, 替换为),)


class GGTextCounter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("INT", "INT", "INT")
    RETURN_NAMES = ("字符数", "单词数", "行数")
    FUNCTION = "count"
    CATEGORY = "GuliNodes/文本工具"

    def count(self, 文本: str = "") -> tuple:
        if not 文本:
            return (0, 0, 0)

        char_count = len(文本)
        word_count = len(re.findall(r'\b\w+\b', 文本))
        line_count = len(文本.split('\n'))

        return (char_count, word_count, line_count)


class GGTextFormat:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本": ("STRING", {"default": "", "multiline": True}),
                "格式模式": (["添加前缀", "添加后缀", "左右对齐", "居中对齐"], {"default": "添加前缀"}),
            },
            "optional": {
                "前缀": ("STRING", {"default": ""}),
                "后缀": ("STRING", {"default": ""}),
                "宽度": ("INT", {"default": 50, "min": 1, "max": 200, "step": 1}),
                "填充字符": ("STRING", {"default": " "})
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "format"
    CATEGORY = "GuliNodes/文本工具"

    def format(self, 文本: str = "", 格式模式: str = "添加前缀",
               前缀: str = "", 后缀: str = "",
               宽度: int = 50, 填充字符: str = " ") -> tuple:
        if not 文本:
            return ("",)

        if 格式模式 == "添加前缀":
            return (前缀 + 文本,)
        elif 格式模式 == "添加后缀":
            return (文本 + 后缀,)
        elif 格式模式 == "左右对齐":
            return (文本.ljust(宽度, 填充字符[0] if 填充字符 else ' '),)
        else:
            return (文本.center(宽度, 填充字符[0] if 填充字符 else ' '),)


NODE_CLASS_MAPPINGS = {
    "GGTextJoin": GGTextJoin,
    "GGTextSplit": GGTextSplit,
    "GGTextFilter": GGTextFilter,
    "GGTextReplace": GGTextReplace,
    "GGTextCounter": GGTextCounter,
    "GGTextFormat": GGTextFormat,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGTextJoin": "GG 文本合并",
    "GGTextSplit": "GG 文本分割",
    "GGTextFilter": "GG 文本过滤",
    "GGTextReplace": "GG 文本替换",
    "GGTextCounter": "GG 文本计数",
    "GGTextFormat": "GG 文本格式化",
}
