"""镜头打光提示词：把面板里选中的机位、光效、光线方向与补充说明合并成一段提示词。

前端面板（web/gg-lighting-prompt.js）负责机位/光效表与拼装，拼好的成品写进 `提示词` 控件并随工作流序列化；
本模块只做规范化与「上游基础提示词 + 面板成品」的合并，避免同一套拼装规则存在两份。
"""

import re

NODE_ID = "GGLightingPrompt"
DISPLAY_NAME = "GG 镜头打光提示词"
CATEGORY = "GuliNodes/文本"
PROMPT_NAME = "提示词"
BASE_NAME = "基础提示词"

# 中文字符（含扩展 A 区），用于决定两段提示词之间的连接符。
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
# 拼接前去掉的尾部分隔与空白，避免出现「，，」「, ,」这类重复标点。
_TRAILING_TRIM = " \t\r\n,，、;；"


def _clean_prompt(value) -> str:
    return str(value or "").strip().strip(_TRAILING_TRIM)


def _join_prompts(base: str, prompt: str) -> str:
    """把上游基础提示词与打光提示词拼成一段。

    两侧都为空时返回空串（不抛错，避免打断已有工作流）；中文之间用全角逗号，
    其余用半角逗号，让中文提示词不会被半角标点切开。
    """
    base = _clean_prompt(base)
    prompt = _clean_prompt(prompt)
    if not base:
        return prompt
    if not prompt:
        return base
    separator = "，" if _CJK_RE.search(base[-1]) or _CJK_RE.search(prompt[0]) else ", "
    return f"{base}{separator}{prompt}"


class GGLightingPrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                PROMPT_NAME: (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "由节点面板按所选机位与光效自动生成；面板不可用时也可以在这里直接手写。",
                    },
                ),
            },
            "optional": {
                BASE_NAME: (
                    "STRING",
                    {
                        "forceInput": True,
                        "tooltip": "可接入上游的正面提示词，会自动拼在打光提示词前面。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    FUNCTION = "build"
    CATEGORY = CATEGORY
    DESCRIPTION = (
        "在面板里选机位（20 种镜头角度）与光效（72 种，可多选：常用 8、人像布光 22、产品布光 12、"
        "环境 14、创意 16，非常用分组默认收起）、光线方向，自动拼成一段提示词；可合并上游基础提示词。"
    )

    def build(self, 提示词="", 基础提示词=""):
        return (_join_prompts(基础提示词, 提示词),)


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGLightingPrompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}
