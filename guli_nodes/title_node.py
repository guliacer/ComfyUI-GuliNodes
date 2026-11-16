try:
    from comfy_api.latest import io
except Exception:
    io = None


NODE_ID = "GGTitleNode"
DISPLAY_NAME = "GG 标题"
TIMER_NODE_ID = "GGWorkflowTimer"
TIMER_DISPLAY_NAME = "GG 耗时"
CATEGORY = "GuliNodes/工作流"
TEXT_ALIGN_OPTIONS = ["左对齐", "居中", "右对齐"]
TEXT_DECORATION_OPTIONS = ["无", "下划线", "删除线"]
LETTER_SPACING_OPTIONS = ["正常", "加宽", "紧凑"]
DEFAULT_TEXT = "GG 标题"
TIMER_DISPLAY_OPTIONS = ["全部", "总用时", "耗时最长的三个节点"]
TIMER_DESCRIPTION = "在工作流画布中显示总用时和耗时最长的三个节点，统计由前端更新。"


def _style_inputs(font_color="#ffffff"):
    # This order is part of GGTitleNode's saved widget values.
    inputs = {
        "字体大小": ("INT", {"default": 32, "min": 1, "max": 256, "step": 1}),
        "字体族": ("STRING", {"default": "Arial", "multiline": False}),
        "字体颜色": ("STRING", {"default": font_color, "multiline": False}),
        "字体粗细": (["正常", "粗体"], {"default": "正常"}),
        "字体斜体": (["正常", "斜体"], {"default": "正常"}),
        "文本装饰": (TEXT_DECORATION_OPTIONS, {"default": "无"}),
        "字符间距": (LETTER_SPACING_OPTIONS, {"default": "正常"}),
        "文本对齐": (TEXT_ALIGN_OPTIONS, {"default": "左对齐"}),
        "背景颜色": ("STRING", {"default": "transparent", "multiline": False}),
        "内边距": ("INT", {"default": 0, "min": 0, "max": 256, "step": 1}),
        "圆角半径": ("INT", {"default": 0, "min": 0, "max": 256, "step": 1}),
        "旋转角度": ("INT", {"default": 0, "min": -360, "max": 360, "step": 1}),
        "背景不透明度": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
    }
    if io is None:
        return inputs
    scalar_inputs = {"INT": io.Int.Input, "STRING": io.String.Input}
    return [
        io.Combo.Input(name, options=kind, **options)
        if isinstance(kind, list)
        else scalar_inputs[kind](name, **options)
        for name, (kind, options) in inputs.items()
    ]


if io is not None:

    class GGTitleNode(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id=NODE_ID,
                display_name=DISPLAY_NAME,
                category=CATEGORY,
                description="在工作流画布中放置可配置样式的浮动标题。",
                search_aliases=["GG 标题", "标题", "注释", "Label", "Title"],
                inputs=[
                    *_style_inputs(),
                    io.String.Input(
                        "标题文本",
                        default=DEFAULT_TEXT,
                        multiline=True,
                        placeholder="输入要显示在画布上的标题",
                    ),
                ],
                outputs=[],
            )

        @classmethod
        def execute(
            cls,
            标题文本: str = DEFAULT_TEXT,
            字体大小: int = 32,
            字体族: str = "Arial",
            字体颜色: str = "#ffffff",
            字体粗细: str = "正常",
            字体斜体: str = "正常",
            文本装饰: str = "无",
            字符间距: str = "正常",
            文本对齐: str = "左对齐",
            背景颜色: str = "transparent",
            内边距: int = 0,
            圆角半径: int = 0,
            旋转角度: int = 0,
            背景不透明度: int = 0,
        ):
            return io.NodeOutput()

    class GGWorkflowTimer(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id=TIMER_NODE_ID,
                display_name=TIMER_DISPLAY_NAME,
                category=CATEGORY,
                description=TIMER_DESCRIPTION,
                search_aliases=["GG 耗时", "耗时", "工作流计时", "Timer"],
                inputs=[
                    *_style_inputs(font_color=""),
                    io.Combo.Input("展示内容", options=TIMER_DISPLAY_OPTIONS, default="全部"),
                ],
                outputs=[],
                is_output_node=False,
            )

        @classmethod
        def execute(cls, 展示内容: str = "全部", **kwargs):
            return io.NodeOutput()

else:

    class GGTitleNode:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    **_style_inputs(),
                    "标题文本": (
                        "STRING",
                        {
                            "default": DEFAULT_TEXT,
                            "multiline": True,
                            "placeholder": "输入要显示在画布上的标题",
                        },
                    ),
                },
            }

        RETURN_TYPES = ()
        FUNCTION = "execute"
        CATEGORY = CATEGORY
        DESCRIPTION = "在工作流画布中放置可配置样式的浮动标题。"
        OUTPUT_NODE = False

        def execute(
            self,
            标题文本: str = DEFAULT_TEXT,
            字体大小: int = 32,
            字体族: str = "Arial",
            字体颜色: str = "#ffffff",
            字体粗细: str = "正常",
            字体斜体: str = "正常",
            文本装饰: str = "无",
            字符间距: str = "正常",
            文本对齐: str = "左对齐",
            背景颜色: str = "transparent",
            内边距: int = 0,
            圆角半径: int = 0,
            旋转角度: int = 0,
            背景不透明度: int = 0,
        ):
            return ()

    class GGWorkflowTimer:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    **_style_inputs(font_color=""),
                    "展示内容": (TIMER_DISPLAY_OPTIONS, {"default": "全部"}),
                },
            }

        RETURN_TYPES = ()
        FUNCTION = "execute"
        CATEGORY = CATEGORY
        DESCRIPTION = TIMER_DESCRIPTION
        OUTPUT_NODE = False

        def execute(self, 展示内容: str = "全部", **kwargs):
            return ()


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGTitleNode,
    TIMER_NODE_ID: GGWorkflowTimer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
    TIMER_NODE_ID: TIMER_DISPLAY_NAME,
}
