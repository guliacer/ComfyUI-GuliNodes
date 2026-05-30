from .dype_patch import apply_dype_to_model

try:
    from comfy_api.latest import io
except Exception:
    io = None


NODE_ID = "GGDyPEPatch"
DISPLAY_NAME = "GG DyPE动态位置"
CATEGORY = "GuliNodes/模型"
MODEL_TYPES = ["auto", "flux", "qwen", "zimage"]
METHODS = ["vision_yarn", "yarn", "ntk", "base"]


if io is not None:

    class GGDyPEFluxPatch(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id=NODE_ID,
                display_name=DISPLAY_NAME,
                category=CATEGORY,
                description="为 FLUX / Qwen / Z-Image 模型应用 DyPE 动态位置外推补丁，用于高分辨率生成。",
                search_aliases=["DyPE", "FLUX DyPE", "GG DyPE", "动态位置外推", "高分辨率模型补丁"],
                inputs=[
                    io.Model.Input("模型", tooltip="要应用 DyPE 补丁的模型。"),
                    io.Int.Input("宽度", default=1024, min=16, max=8192, step=8, tooltip="目标图像宽度，需与 Latent 宽度对应。"),
                    io.Int.Input("高度", default=1024, min=16, max=8192, step=8, tooltip="目标图像高度，需与 Latent 高度对应。"),
                    io.Combo.Input("模型类型", options=MODEL_TYPES, default="auto", tooltip="模型架构，auto 会自动识别。"),
                    io.Combo.Input("外推方法", options=METHODS, default="vision_yarn", tooltip="位置编码外推方法。"),
                    io.Boolean.Input(
                        "YaRN替代缩放",
                        default=False,
                        label_on="各向异性",
                        label_off="各向同性",
                        tooltip="仅 YaRN 使用，高分辨率时可尝试开启。",
                    ),
                    io.Boolean.Input(
                        "启用DyPE",
                        default=True,
                        label_on="启用",
                        label_off="关闭",
                        tooltip="启用或关闭动态位置外推。",
                    ),
                    io.Int.Input("基准分辨率", default=1024, min=256, max=4096, step=16, tooltip="模型原生训练分辨率。"),
                    io.Float.Input(
                        "DyPE起始sigma",
                        default=1.0,
                        min=0.0,
                        max=1.0,
                        step=0.01,
                        tooltip="从采样进度的哪个 sigma 开始衰减缩放效果。",
                    ),
                    io.Float.Input("DyPE强度", default=2.0, min=0.0, max=8.0, step=0.1, tooltip="控制 DyPE 作用幅度。"),
                    io.Float.Input(
                        "DyPE衰减指数",
                        default=2.0,
                        min=0.0,
                        max=1000.0,
                        step=0.1,
                        tooltip="控制 DyPE 衰减速度，越大衰减越快。",
                    ),
                    io.Float.Input("基础shift", default=0.5, min=0.0, max=10.0, step=0.01, tooltip="噪声调度基础 shift。"),
                    io.Float.Input("最大shift", default=1.15, min=0.0, max=10.0, step=0.01, tooltip="高分辨率时的最大 shift。"),
                ],
                outputs=[
                    io.Model.Output(display_name="修补模型", tooltip="已应用 DyPE 补丁的模型。"),
                ],
            )

        @classmethod
        def execute(
            cls,
            模型,
            宽度,
            高度,
            模型类型,
            外推方法,
            YaRN替代缩放,
            启用DyPE,
            基准分辨率=1024,
            DyPE起始sigma=1.0,
            DyPE强度=2.0,
            DyPE衰减指数=2.0,
            基础shift=0.5,
            最大shift=1.15,
        ):
            patched_model = apply_dype_to_model(
                模型,
                模型类型,
                宽度,
                高度,
                外推方法,
                YaRN替代缩放,
                启用DyPE,
                DyPE强度,
                DyPE衰减指数,
                基础shift,
                最大shift,
                基准分辨率,
                DyPE起始sigma,
            )
            return io.NodeOutput(patched_model)

else:

    class GGDyPEFluxPatch:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    "模型": ("MODEL",),
                    "宽度": ("INT", {"default": 1024, "min": 16, "max": 8192, "step": 8}),
                    "高度": ("INT", {"default": 1024, "min": 16, "max": 8192, "step": 8}),
                    "模型类型": (MODEL_TYPES, {"default": "auto"}),
                    "外推方法": (METHODS, {"default": "vision_yarn"}),
                    "YaRN替代缩放": ("BOOLEAN", {"default": False}),
                    "启用DyPE": ("BOOLEAN", {"default": True}),
                    "基准分辨率": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 16}),
                    "DyPE起始sigma": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                    "DyPE强度": ("FLOAT", {"default": 2.0, "min": 0.0, "max": 8.0, "step": 0.1}),
                    "DyPE衰减指数": ("FLOAT", {"default": 2.0, "min": 0.0, "max": 1000.0, "step": 0.1}),
                    "基础shift": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 10.0, "step": 0.01}),
                    "最大shift": ("FLOAT", {"default": 1.15, "min": 0.0, "max": 10.0, "step": 0.01}),
                }
            }

        RETURN_TYPES = ("MODEL",)
        RETURN_NAMES = ("修补模型",)
        FUNCTION = "execute"
        CATEGORY = CATEGORY
        DESCRIPTION = "为 FLUX / Qwen / Z-Image 模型应用 DyPE 动态位置外推补丁，用于高分辨率生成。"

        def execute(
            self,
            模型,
            宽度,
            高度,
            模型类型,
            外推方法,
            YaRN替代缩放,
            启用DyPE,
            基准分辨率=1024,
            DyPE起始sigma=1.0,
            DyPE强度=2.0,
            DyPE衰减指数=2.0,
            基础shift=0.5,
            最大shift=1.15,
        ):
            return (
                apply_dype_to_model(
                    模型,
                    模型类型,
                    宽度,
                    高度,
                    外推方法,
                    YaRN替代缩放,
                    启用DyPE,
                    DyPE强度,
                    DyPE衰减指数,
                    基础shift,
                    最大shift,
                    基准分辨率,
                    DyPE起始sigma,
                ),
            )


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGDyPEFluxPatch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}
