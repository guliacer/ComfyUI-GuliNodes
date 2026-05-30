import torch

try:
    from comfy_api.latest import io
except Exception:
    io = None

ASPECT_RATIOS = ["1:1", "3:2", "4:3", "5:4", "16:9", "21:9", "9:16", "2:3", "3:4", "4:5", "9:21"]
LATENT_ASPECT_RATIOS = [
    "1:1",
    "1:2",
    "2:3",
    "3:4",
    "4:5",
    "5:7",
    "9:16",
    "10:16",
    "9:21",
]
ASPECT_PRESETS = {
    ratio: tuple(int(part) for part in ratio.split(":", 1))
    for ratio in [*ASPECT_RATIOS, *LATENT_ASPECT_RATIOS]
}
SIDE_TYPES = ["最长边", "最短边"]
ORIENTATION_TYPES = ["横屏", "竖屏"]


if io is not None:

    class GGAspectRatioAdapter(io.ComfyNode):
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGAspectRatioAdapter",
                display_name="GG 图像宽高",
                category="GuliNodes/图像",
                description="按预设宽高比自动计算尺寸并规范对齐。",
                inputs=[
                    io.Combo.Input("宽高比例", options=ASPECT_RATIOS, default="16:9", tooltip="预设的宽高比例。"),
                    io.Int.Input("边长", default=1024, min=64, max=8192, step=8, tooltip="边长（最长边或最短边）。"),
                    io.Combo.Input("边长类型", options=SIDE_TYPES, default="最长边", tooltip="指定边长是最长边还是最短边。"),
                    io.Combo.Input("画面方向", options=ORIENTATION_TYPES, default="横屏", tooltip="强制指定画面方向。"),
                ],
                outputs=[
                    io.Int.Output(display_name="宽度", tooltip="计算后的宽度（已对齐到8的倍数）。"),
                    io.Int.Output(display_name="高度", tooltip="计算后的高度（已对齐到8的倍数）。"),
                ],
            )

        @classmethod
        def execute(cls, 宽高比例, 边长, 边长类型, 画面方向="横屏"):
            wr, hr = ASPECT_PRESETS[宽高比例]
            wr, hr = cls._apply_orientation(wr, hr, 画面方向)
            if 边长类型 == "最长边":
                width = 边长 if wr > hr else int(边长 * wr / hr)
                height = int(边长 * hr / wr) if wr > hr else 边长
            else:
                height = 边长 if wr > hr else int(边长 * hr / wr)
                width = int(边长 * wr / hr) if wr > hr else 边长
            width = cls._align_to_eight(width)
            height = cls._align_to_eight(height)
            return io.NodeOutput(width, height)

    GGAspectRatioAdapter = GGAspectRatioAdapter


    class GGAspectRatioLatent(io.ComfyNode):
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGAspectRatioLatent",
                display_name="GG Latent",
                category="GuliNodes/潜空间",
                description="生成指定比例和尺寸的空Latent。",
                inputs=[
                    io.Combo.Input("宽高比例", options=LATENT_ASPECT_RATIOS, default="9:16", tooltip="预设的宽高比例。"),
                    io.Int.Input("边长", default=1024, min=64, max=8192, step=8, tooltip="边长（最长边或最短边）。"),
                    io.Combo.Input("边长类型", options=SIDE_TYPES, default="最长边", tooltip="指定边长是最长边还是最短边。"),
                    io.Int.Input("批量大小", default=1, min=1, max=64, tooltip="生成的Latent数量。"),
                    io.Combo.Input("画面方向", options=ORIENTATION_TYPES, default="横屏", tooltip="强制指定画面方向。"),
                ],
                outputs=[
                    io.Latent.Output(display_name="Latent", tooltip="生成的空Latent。"),
                ],
            )

        @classmethod
        def execute(cls, 宽高比例, 边长, 边长类型, 批量大小, 画面方向="横屏"):
            wr, hr = ASPECT_PRESETS[宽高比例]
            wr, hr = cls._apply_orientation(wr, hr, 画面方向)
            if 边长类型 == "最长边":
                width = 边长 if wr > hr else int(边长 * wr / hr)
                height = int(边长 * hr / wr) if wr > hr else 边长
            else:
                height = 边长 if wr > hr else int(边长 * hr / wr)
                width = int(边长 * wr / hr) if wr > hr else 边长
            width = cls._align_to_eight(width)
            height = cls._align_to_eight(height)
            latent = torch.zeros([批量大小, 4, height // 8, width // 8])
            return io.NodeOutput({"samples": latent})

    GGAspectRatioLatent = GGAspectRatioLatent


    class GGAspectRatioLatent2(io.ComfyNode):
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGAspectRatioLatent2",
                display_name="GG Latent2",
                category="GuliNodes/潜空间",
                description="生成指定比例和尺寸的空Latent，并输出宽度和高度。",
                inputs=[
                    io.Combo.Input("宽高比例", options=LATENT_ASPECT_RATIOS, default="9:16", tooltip="预设的宽高比例。"),
                    io.Int.Input("边长", default=1024, min=64, max=8192, step=8, tooltip="边长（最长边或最短边）。"),
                    io.Combo.Input("边长类型", options=SIDE_TYPES, default="最长边", tooltip="指定边长是最长边还是最短边。"),
                    io.Int.Input("批量大小", default=1, min=1, max=64, tooltip="生成的Latent数量。"),
                    io.Combo.Input("画面方向", options=ORIENTATION_TYPES, default="横屏", tooltip="强制指定画面方向。"),
                ],
                outputs=[
                    io.Latent.Output(display_name="Latent", tooltip="生成的空Latent。"),
                    io.Int.Output(display_name="宽度", tooltip="计算后的宽度。"),
                    io.Int.Output(display_name="高度", tooltip="计算后的高度。"),
                ],
            )

        @classmethod
        def execute(cls, 宽高比例, 边长, 边长类型, 批量大小, 画面方向="横屏"):
            wr, hr = ASPECT_PRESETS[宽高比例]
            wr, hr = cls._apply_orientation(wr, hr, 画面方向)
            if 边长类型 == "最长边":
                width = 边长 if wr > hr else int(边长 * wr / hr)
                height = int(边长 * hr / wr) if wr > hr else 边长
            else:
                height = 边长 if wr > hr else int(边长 * hr / wr)
                width = int(边长 * wr / hr) if wr > hr else 边长
            width = cls._align_to_eight(width)
            height = cls._align_to_eight(height)
            latent = torch.zeros([批量大小, 4, height // 8, width // 8])
            return io.NodeOutput({"samples": latent}, width, height)

    GGAspectRatioLatent2 = GGAspectRatioLatent2


    class GGImageToLatent(io.ComfyNode):
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGImageToLatent",
                display_name="GG 图像-Latent",
                category="GuliNodes/潜空间",
                description="手动或参考图像尺寸生成Latent。",
                inputs=[
                    io.Combo.Input("模式", options=["手动", "参考图像"], default="手动", tooltip="选择手动设置或参考图像尺寸。"),
                    io.Combo.Input("宽高比例", options=LATENT_ASPECT_RATIOS, default="9:16", tooltip="手动模式：预设的宽高比例。"),
                    io.Int.Input("边长", default=1024, min=64, max=8192, step=8, tooltip="手动模式：边长（最长边或最短边）。"),
                    io.Combo.Input("边长类型", options=SIDE_TYPES, default="最长边", tooltip="手动模式：指定边长是最长边还是最短边。"),
                    io.Int.Input("批量大小", default=1, min=1, max=64, tooltip="生成的Latent数量。"),
                    io.Combo.Input("画面方向", options=ORIENTATION_TYPES, default="横屏", tooltip="强制指定画面方向。"),
                    io.Image.Input("图像", optional=True, tooltip="参考图像模式：用于获取尺寸的图像。"),
                ],
                outputs=[
                    io.Latent.Output(display_name="Latent", tooltip="生成的空Latent。"),
                ],
            )

        @classmethod
        def execute(cls, 模式, 宽高比例="9:16", 边长=1024, 边长类型="最长边", 批量大小=1, 图像=None, 画面方向="横屏"):
            if 模式 == "参考图像":
                if 图像 is None:
                    raise ValueError("模式设置为「参考图像」时，必须连接图像输入。")
                if len(图像.shape) == 4:
                    h, w = 图像.shape[1], 图像.shape[2]
                else:
                    h, w = 图像.shape[0], 图像.shape[1]
                w, h = cls._apply_orientation(int(w), int(h), 画面方向)
                height = cls._align_to_eight(int(h))
                width = cls._align_to_eight(int(w))
                return io.NodeOutput({"samples": torch.zeros([批量大小, 4, height // 8, width // 8])})
            else:
                wr, hr = ASPECT_PRESETS[宽高比例]
                wr, hr = cls._apply_orientation(wr, hr, 画面方向)
                if 边长类型 == "最长边":
                    width = 边长 if wr > hr else int(边长 * wr / hr)
                    height = int(边长 * hr / wr) if wr > hr else 边长
                else:
                    height = 边长 if wr > hr else int(边长 * hr / wr)
                    width = int(边长 * wr / hr) if wr > hr else 边长
                width = cls._align_to_eight(width)
                height = cls._align_to_eight(height)
                return io.NodeOutput({"samples": torch.zeros([批量大小, 4, height // 8, width // 8])})

    GGImageToLatent = GGImageToLatent


    class GGImageSizeScale(io.ComfyNode):
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGImageSizeScale",
                display_name="GG 图像尺寸缩放",
                category="GuliNodes/图像",
                description="基于输入图像尺寸，按自定义缩放系数计算宽度和高度。",
                inputs=[
                    io.Image.Input("图像", tooltip="用于获取原始尺寸的图像。"),
                    io.Float.Input("缩放系数", default=1.0, min=0.1, max=10.0, step=0.05, tooltip="缩放比例系数，1.0表示保持原始尺寸。"),
                ],
                outputs=[
                    io.Int.Output(display_name="宽度", tooltip="计算后的图像宽度（已对齐到8的倍数）。"),
                    io.Int.Output(display_name="高度", tooltip="计算后的图像高度（已对齐到8的倍数）。"),
                ],
            )

        @classmethod
        def execute(cls, 图像, 缩放系数=1.0):
            if len(图像.shape) == 4:
                h, w = 图像.shape[1], 图像.shape[2]
            else:
                h, w = 图像.shape[0], 图像.shape[1]
            width = cls._align_to_eight(int(w * 缩放系数))
            height = cls._align_to_eight(int(h * 缩放系数))
            return io.NodeOutput(width, height)

    GGImageSizeScale = GGImageSizeScale


else:

    class GGAspectRatioAdapter:
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def INPUT_TYPES(s):
            return {
                "required": {
                    "宽高比例": (ASPECT_RATIOS, {"default": "16:9"}),
                    "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                    "边长类型": (SIDE_TYPES, {"default": "最长边"}),
                },
                "optional": {
                    "画面方向": (ORIENTATION_TYPES, {"default": "横屏"}),
                }
            }

        RETURN_TYPES = ("INT", "INT")
        RETURN_NAMES = ("宽度", "高度")
        FUNCTION = "calculate"
        CATEGORY = "GuliNodes/图像"

        def calculate(self, 宽高比例: str, 边长: int, 边长类型: str, 画面方向: str = "横屏") -> tuple:
            wr, hr = ASPECT_PRESETS[宽高比例]
            wr, hr = self._apply_orientation(wr, hr, 画面方向)
            if 边长类型 == "最长边":
                width = 边长 if wr > hr else int(边长 * wr / hr)
                height = int(边长 * hr / wr) if wr > hr else 边长
            else:
                height = 边长 if wr > hr else int(边长 * hr / wr)
                width = int(边长 * wr / hr) if wr > hr else 边长
            width = self._align_to_eight(width)
            height = self._align_to_eight(height)
            return (width, height)


    class GGAspectRatioLatent:
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def INPUT_TYPES(s):
            return {
                "required": {
                    "宽高比例": (LATENT_ASPECT_RATIOS, {"default": "9:16"}),
                    "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                    "边长类型": (SIDE_TYPES, {"default": "最长边"}),
                    "批量大小": ("INT", {"default": 1, "min": 1, "max": 64}),
                    "画面方向": (ORIENTATION_TYPES, {"default": "横屏"}),
                }
            }

        RETURN_TYPES = ("LATENT",)
        FUNCTION = "generate"
        CATEGORY = "GuliNodes/潜空间"

        def generate(self, 宽高比例: str, 边长: int, 边长类型: str, 批量大小: int, 画面方向: str = "横屏") -> tuple:
            wr, hr = ASPECT_PRESETS[宽高比例]
            wr, hr = self._apply_orientation(wr, hr, 画面方向)
            if 边长类型 == "最长边":
                width = 边长 if wr > hr else int(边长 * wr / hr)
                height = int(边长 * hr / wr) if wr > hr else 边长
            else:
                height = 边长 if wr > hr else int(边长 * hr / wr)
                width = int(边长 * wr / hr) if wr > hr else 边长
            width = self._align_to_eight(width)
            height = self._align_to_eight(height)
            latent = torch.zeros([批量大小, 4, height // 8, width // 8])
            return ({"samples": latent},)


    class GGAspectRatioLatent2:
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def INPUT_TYPES(s):
            return {
                "required": {
                    "宽高比例": (LATENT_ASPECT_RATIOS, {"default": "9:16"}),
                    "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                    "边长类型": (SIDE_TYPES, {"default": "最长边"}),
                    "批量大小": ("INT", {"default": 1, "min": 1, "max": 64}),
                    "画面方向": (ORIENTATION_TYPES, {"default": "横屏"}),
                }
            }

        RETURN_TYPES = ("LATENT", "INT", "INT")
        RETURN_NAMES = ("LATENT", "宽度", "高度")
        FUNCTION = "generate"
        CATEGORY = "GuliNodes/潜空间"

        def generate(self, 宽高比例: str, 边长: int, 边长类型: str, 批量大小: int, 画面方向: str = "横屏") -> tuple:
            wr, hr = ASPECT_PRESETS[宽高比例]
            wr, hr = self._apply_orientation(wr, hr, 画面方向)
            if 边长类型 == "最长边":
                width = 边长 if wr > hr else int(边长 * wr / hr)
                height = int(边长 * hr / wr) if wr > hr else 边长
            else:
                height = 边长 if wr > hr else int(边长 * hr / wr)
                width = int(边长 * wr / hr) if wr > hr else 边长
            width = self._align_to_eight(width)
            height = self._align_to_eight(height)
            latent = torch.zeros([批量大小, 4, height // 8, width // 8])
            return ({"samples": latent}, width, height)


    class GGImageToLatent:
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @staticmethod
        def _apply_orientation(width: int, height: int, 画面方向: str) -> tuple[int, int]:
            if 画面方向 == "横屏" and width < height:
                return height, width
            if 画面方向 == "竖屏" and width > height:
                return height, width
            return width, height

        @classmethod
        def INPUT_TYPES(s):
            return {
                "required": {
                    "模式": (["手动", "参考图像"], {"default": "手动"}),
                },
                "optional": {
                    "宽高比例": (LATENT_ASPECT_RATIOS, {"default": "9:16"}),
                    "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                    "边长类型": (SIDE_TYPES, {"default": "最长边"}),
                    "批量大小": ("INT", {"default": 1, "min": 1, "max": 64}),
                    "画面方向": (ORIENTATION_TYPES, {"default": "横屏"}),
                    "图像": ("IMAGE",),
                }
            }

        RETURN_TYPES = ("LATENT",)
        RETURN_NAMES = ("Latent",)
        FUNCTION = "convert"
        CATEGORY = "GuliNodes/潜空间"

        def convert(self, 模式: str = "手动", 宽高比例: str = "16:9", 边长: int = 1024, 边长类型: str = "最长边", 批量大小: int = 1, 图像: torch.Tensor = None, 画面方向: str = "横屏") -> tuple:
            if 模式 == "参考图像":
                if 图像 is None:
                    raise ValueError("模式设置为「参考图像」时，必须连接图像输入。")
                if len(图像.shape) == 4:
                    h, w = 图像.shape[1], 图像.shape[2]
                else:
                    h, w = 图像.shape[0], 图像.shape[1]
                w, h = self._apply_orientation(int(w), int(h), 画面方向)
                height = self._align_to_eight(int(h))
                width = self._align_to_eight(int(w))
                return ({"samples": torch.zeros([批量大小, 4, height // 8, width // 8])},)
            else:
                wr, hr = ASPECT_PRESETS[宽高比例]
                wr, hr = self._apply_orientation(wr, hr, 画面方向)
                if 边长类型 == "最长边":
                    width = 边长 if wr > hr else int(边长 * wr / hr)
                    height = int(边长 * hr / wr) if wr > hr else 边长
                else:
                    height = 边长 if wr > hr else int(边长 * hr / wr)
                    width = int(边长 * wr / hr) if wr > hr else 边长
                width = self._align_to_eight(width)
                height = self._align_to_eight(height)
                return ({"samples": torch.zeros([批量大小, 4, height // 8, width // 8])},)


    class GGImageSizeScale:
        @staticmethod
        def _align_to_eight(value: int) -> int:
            return max(8, (value // 8) * 8)

        @classmethod
        def INPUT_TYPES(s):
            return {
                "required": {
                    "图像": ("IMAGE",),
                    "缩放系数": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 10.0, "step": 0.05}),
                }
            }

        RETURN_TYPES = ("INT", "INT")
        RETURN_NAMES = ("宽度", "高度")
        FUNCTION = "calculate"
        CATEGORY = "GuliNodes/图像"

        def calculate(self, 图像: torch.Tensor, 缩放系数: float = 1.0) -> tuple:
            if len(图像.shape) == 4:
                h, w = 图像.shape[1], 图像.shape[2]
            else:
                h, w = 图像.shape[0], 图像.shape[1]
            width = self._align_to_eight(int(w * 缩放系数))
            height = self._align_to_eight(int(h * 缩放系数))
            return (width, height)


NODE_CLASS_MAPPINGS = {
    "GGAspectRatioAdapter": GGAspectRatioAdapter,
    "GGAspectRatioLatent": GGAspectRatioLatent,
    "GGAspectRatioLatent2": GGAspectRatioLatent2,
    "GGImageToLatent": GGImageToLatent,
    "GGImageSizeScale": GGImageSizeScale,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGAspectRatioAdapter": "GG 图像宽高",
    "GGAspectRatioLatent": "GG Latent",
    "GGAspectRatioLatent2": "GG Latent2",
    "GGImageToLatent": "GG 图像-Latent",
    "GGImageSizeScale": "GG 图像尺寸缩放",
}
