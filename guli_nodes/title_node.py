try:
    from comfy_api.latest import io
except Exception:
    io = None


NODE_ID = "GGTitleNode"
DISPLAY_NAME = "GG 标题"
CATEGORY = "GuliNodes/工作流"
TEXT_ALIGN_OPTIONS = ["左对齐", "居中", "右对齐"]
TEXT_DECORATION_OPTIONS = ["无", "下划线", "删除线"]
LETTER_SPACING_OPTIONS = ["正常", "加宽", "紧凑"]
DEFAULT_TEXT = "GG 标题"


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
                    io.String.Input(
                        "标题文本",
                        default=DEFAULT_TEXT,
                        multiline=True,
                        placeholder="输入要显示在画布上的标题",
                    ),
                    io.Int.Input("字体大小", default=32, min=1, max=256, step=1),
                    io.String.Input("字体族", default="Arial", multiline=False),
                    io.String.Input("字体颜色", default="#ffffff", multiline=False),
                    io.Combo.Input("字体粗细", options=["正常", "粗体"], default="正常"),
                    io.Combo.Input("字体斜体", options=["正常", "斜体"], default="正常"),
                    io.Combo.Input("文本装饰", options=TEXT_DECORATION_OPTIONS, default="无"),
                    io.Combo.Input("字符间距", options=LETTER_SPACING_OPTIONS, default="正常"),
                    io.Combo.Input("文本对齐", options=TEXT_ALIGN_OPTIONS, default="左对齐"),
                    io.String.Input("背景颜色", default="transparent", multiline=False),
                    io.Int.Input("内边距", default=0, min=0, max=256, step=1),
                    io.Int.Input("圆角半径", default=0, min=0, max=256, step=1),
                    io.Int.Input("旋转角度", default=0, min=-360, max=360, step=1),
                    io.Int.Input("背景不透明度", default=0, min=0, max=100, step=1),
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

else:

    class GGTitleNode:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    "标题文本": (
                        "STRING",
                        {
                            "default": DEFAULT_TEXT,
                            "multiline": True,
                            "placeholder": "输入要显示在画布上的标题",
                        },
                    ),
                    "字体大小": ("INT", {"default": 32, "min": 1, "max": 256, "step": 1}),
                    "字体族": ("STRING", {"default": "Arial", "multiline": False}),
                    "字体颜色": ("STRING", {"default": "#ffffff", "multiline": False}),
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


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGTitleNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}
