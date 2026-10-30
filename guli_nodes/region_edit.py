"""人像/背景分区编辑的纯准备节点；不加载模型、不执行生成、不修改原始张量。"""

import torch

try:
    from comfy_api.latest import io
except ImportError:
    io = None

from .text_tools import _join_texts


_NODE_ID = "GGRegionEditPrepare"
_DISPLAY_NAME = "GG 分区编辑准备"
_CATEGORY = "GuliNodes/图像"
_REGIONS = ["人像", "背景"]
_RETURN_TYPES = ("IMAGE", "MASK", "STRING", "STRING", "BOOLEAN")
_RETURN_NAMES = ("图像", "区域遮罩", "区域请求", "锁定约束", "是否编辑")
_DESCRIPTION = "准备人像或背景的区域遮罩、编辑请求与固定锁定约束；编辑需求留空时不编辑，不加载模型。"
_INPUT_TOOLTIPS = {
    "图像": "单张 RGB 或 RGBA 图像，数值须在 0–1；去除透明通道时保留原始 RGB，不合成白底。",
    "人像遮罩": "白色涂选人物、黑色表示背景；请在加载图像的遮罩编辑器涂选人物并保存。编辑需求为空时不校验遮罩。",
    "处理区域": "人像使用原始人物遮罩，背景使用其反相；始终先校验人物涂选有效。",
    "编辑需求": "仅此文本决定是否编辑；留空或只填空白时返回原图与全黑区域遮罩。",
    "全局要求": "可选的统一风格等要求，仅在编辑需求非空时附加；不能单独启用编辑或覆盖固定约束。",
}
_OUTPUT_TOOLTIPS = (
    "保持原始画布和 RGB 像素的图像。",
    "当前区域的软遮罩；未启用编辑时为与图像同尺寸的全黑遮罩。",
    "当前编辑目标、编辑需求与可选的全局要求；未启用编辑时为空。",
    "固定的人物、画布与非目标区域保护约束，不受用户文本覆盖。",
    "仅当编辑需求去除首尾空白后非空且输入校验通过时为真。",
)


def _validated_rgb(图像):
    if not isinstance(图像, torch.Tensor) or 图像.is_complex():
        raise ValueError("图像必须是单张 RGB 或 RGBA 张量，请连接加载图像的图像输出。")
    if 图像.ndim != 4 or 图像.shape[0] != 1:
        raise ValueError("图像必须是单张 [1,高,宽,通道] 图像，请拆分批次后再连接。")
    if 图像.shape[1] <= 0 or 图像.shape[2] <= 0 or 图像.shape[3] not in (3, 4):
        raise ValueError("图像宽高必须大于零且通道数为 3 或 4，请连接有效的 RGB 或 RGBA 图像。")
    if not torch.isfinite(图像).all().item():
        raise ValueError("图像含有非有限数值，请清除无效数值后重新输入 0–1 图像。")
    if ((图像 < 0) | (图像 > 1)).any().item():
        raise ValueError("图像数值超出 0–1，请先将图像归一化到 0–1。")
    # 只去掉 alpha，不合成背景，也不原地修改输入。
    return 图像 if 图像.shape[3] == 3 else 图像[..., :3]


def _ratio_text(有效像素, 总像素):
    """有效像素占比的百分比文本，放进报错帮用户自查涂选范围。"""
    return f"{有效像素 * 100.0 / 总像素:.2f}%"


def _validated_human_mask(人像遮罩, 高, 宽, device):
    if not isinstance(人像遮罩, torch.Tensor) or 人像遮罩.is_complex():
        raise ValueError("人像遮罩必须是人物涂选张量，请在加载图像的遮罩编辑器涂选人物并保存。")
    if 人像遮罩.ndim == 2:
        遮罩 = 人像遮罩.unsqueeze(0)
    elif 人像遮罩.ndim == 3 and 人像遮罩.shape[0] == 1:
        遮罩 = 人像遮罩
    elif 人像遮罩.ndim == 4 and 人像遮罩.shape[:2] == (1, 1):
        遮罩 = 人像遮罩[:, 0]
    else:
        raise ValueError("人像遮罩仅支持 [高,宽]、[1,高,宽] 或 [1,1,高,宽]，请拆分批次并使用单张遮罩。")
    if not torch.isfinite(遮罩).all().item():
        raise ValueError("人像遮罩含有非有限数值，请重新涂选并保存有效的 0–1 遮罩。")
    if ((遮罩 < 0) | (遮罩 > 1)).any().item():
        raise ValueError("人像遮罩数值超出 0–1，请先将遮罩归一化到 0–1。")
    # 普通加载图像的无涂选占位遮罩常为 64×64，优先给出编辑器操作建议。
    if 遮罩.shape[1:] == (64, 64) and torch.count_nonzero(遮罩).item() == 0:
        raise ValueError("人像遮罩为空，请在加载图像的遮罩编辑器涂选人物并保存。")
    if 遮罩.shape[1:] != (高, 宽):
        遮罩高, 遮罩宽 = 遮罩.shape[1:]
        raise ValueError(
            f"人像遮罩尺寸 {遮罩高}×{遮罩宽} 与图像 {高}×{宽} 不一致，"
            "请使用同一图像的遮罩编辑器重新涂选并保存。"
        )
    # 保留浮点软权重用于最终合成；消费端归一化的安全性在准备函数中另行校验。
    dtype = 遮罩.dtype if 遮罩.is_floating_point() else torch.float32
    return 遮罩.to(device=device, dtype=dtype)


def prepare_region(图像, 人像遮罩, 处理区域="人像", 编辑需求="", 全局要求=""):
    """返回固定顺序的图像、区域遮罩、区域请求、锁定约束、是否编辑。"""
    RGB图像 = _validated_rgb(图像)
    if not isinstance(处理区域, str) or 处理区域 not in _REGIONS:
        raise ValueError("处理区域无效，请选择「人像」或「背景」。")
    if not isinstance(编辑需求, str):
        raise ValueError("编辑需求必须是文本，请填写区域修改要求或留空以关闭编辑。")
    需求 = 编辑需求.strip()
    其它区域 = "背景" if 处理区域 == "人像" else "人像"
    锁定约束 = (
        "保持原图人物的身份、姿态、位置、比例和外轮廓基本不变；保持相同画布、镜头和透视。\n\n"
        f"仅编辑{处理区域}区域，不得编辑{其它区域}区域；{其它区域}仅作为上下文，不是编辑目标。"
    )
    高, 宽 = RGB图像.shape[1:3]
    if not 需求:
        空遮罩 = torch.zeros((1, 高, 宽), device=RGB图像.device, dtype=torch.float32)
        return RGB图像, 空遮罩, "", 锁定约束, False

    遮罩 = _validated_human_mask(人像遮罩, 高, 宽, RGB图像.device)
    总像素 = 高 * 宽
    人物像素 = torch.count_nonzero(遮罩 > 0.1).item()
    # 占比 0 与占比极小分开提示：前者通常是没涂上，后者才涉及涂反或范围过小。
    if 人物像素 == 0:
        raise ValueError(
            "人像遮罩全部为黑色（有效区域 0.00%），人物选区没有涂上或没有保存成功；"
            "请右键加载图像进入遮罩编辑器涂选人物（白色）并保存。"
        )
    if 人物像素 == 总像素:
        raise ValueError(
            f"人像遮罩有效区域 {_ratio_text(人物像素, 总像素)}（全白），"
            "请只涂选人物并保留背景为黑色。"
        )
    # 0.002 = 1/500；整数比较避免 float32 mean 在临界值附近产生漂移。
    if 人物像素 * 500 < 总像素:
        raise ValueError(
            f"人像遮罩有效区域仅 {_ratio_text(人物像素, 总像素)}（不足 0.2%）；"
            "若预览中人物是黑色而背景是白色，说明人物与背景涂反了；"
            "请进入遮罩编辑器重新涂选人物（白色）并保存。"
        )
    # GG 遮罩裁剪先转 float32；还须按消费端精度校验，避免触发其整图回退。
    消费人物像素 = torch.count_nonzero(遮罩.float() > 0.1).item()
    if 消费人物像素 * 500 < 总像素:
        raise ValueError(
            f"人像遮罩转为 float32 后有效区域仅 {_ratio_text(消费人物像素, 总像素)}（不足 0.2%，"
            "精度导致像素落到 0.1 阈值），请重新涂选人物并让有效权重明显高于 0.1。"
        )
    # 人物有效性必须先于反相校验，防止空人物遮罩反相后变成全图编辑。
    区域遮罩 = 遮罩 if 处理区域 == "人像" else 1 - 遮罩
    区域像素 = torch.count_nonzero(区域遮罩 > 0.1).item()
    if 区域像素 * 500 < 总像素:
        raise ValueError(
            f"{处理区域}区域有效面积仅 {_ratio_text(区域像素, 总像素)}（不足 0.2%），"
            "请检查人物涂选并为当前区域保留足够面积。"
        )
    消费区域像素 = torch.count_nonzero(区域遮罩.float() > 0.1).item()
    if 消费区域像素 * 500 < 总像素:
        raise ValueError(
            f"{处理区域}区域转为 float32 后有效面积仅 {_ratio_text(消费区域像素, 总像素)}（不足 0.2%，"
            "精度导致像素落到 0.1 阈值），请检查人物涂选并让当前区域的有效权重明显高于 0.1。"
        )
    if not isinstance(全局要求, str):
        raise ValueError("全局要求必须是文本，请填写统一要求或留空。")
    全局文本 = 全局要求.strip()
    区域请求 = _join_texts([
        f"编辑目标：{处理区域}",
        f"编辑需求：{需求}",
        f"全局要求：{全局文本}" if 全局文本 else "",
    ])
    return RGB图像, 区域遮罩, 区域请求, 锁定约束, True


class GGRegionEditPrepare:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE", {"tooltip": _INPUT_TOOLTIPS["图像"]}),
                "人像遮罩": ("MASK", {"tooltip": _INPUT_TOOLTIPS["人像遮罩"]}),
                "处理区域": (_REGIONS, {"default": "人像", "tooltip": _INPUT_TOOLTIPS["处理区域"]}),
                "编辑需求": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False, "tooltip": _INPUT_TOOLTIPS["编辑需求"]}),
                "全局要求": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False, "tooltip": _INPUT_TOOLTIPS["全局要求"]}),
            },
        }

    RETURN_TYPES = _RETURN_TYPES
    RETURN_NAMES = _RETURN_NAMES
    OUTPUT_TOOLTIPS = _OUTPUT_TOOLTIPS
    FUNCTION = "execute"
    CATEGORY = _CATEGORY
    DESCRIPTION = _DESCRIPTION

    def execute(self, 图像, 人像遮罩, 处理区域="人像", 编辑需求="", 全局要求=""):
        return prepare_region(图像, 人像遮罩, 处理区域, 编辑需求, 全局要求)


if io is not None:
    class GGRegionEditPrepare_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id=_NODE_ID,
                display_name=_DISPLAY_NAME,
                category=_CATEGORY,
                description=_DESCRIPTION,
                inputs=[
                    io.Image.Input("图像", tooltip=_INPUT_TOOLTIPS["图像"]),
                    io.Mask.Input("人像遮罩", tooltip=_INPUT_TOOLTIPS["人像遮罩"]),
                    io.Combo.Input("处理区域", options=_REGIONS, default="人像", tooltip=_INPUT_TOOLTIPS["处理区域"]),
                    io.String.Input("编辑需求", default="", multiline=True, dynamic_prompts=False, tooltip=_INPUT_TOOLTIPS["编辑需求"]),
                    io.String.Input("全局要求", default="", multiline=True, dynamic_prompts=False, tooltip=_INPUT_TOOLTIPS["全局要求"]),
                ],
                outputs=[
                    io.Image.Output("图像", tooltip=_OUTPUT_TOOLTIPS[0]),
                    io.Mask.Output("区域遮罩", tooltip=_OUTPUT_TOOLTIPS[1]),
                    io.String.Output("区域请求", tooltip=_OUTPUT_TOOLTIPS[2]),
                    io.String.Output("锁定约束", tooltip=_OUTPUT_TOOLTIPS[3]),
                    io.Boolean.Output("是否编辑", tooltip=_OUTPUT_TOOLTIPS[4]),
                ],
            )

        @classmethod
        def execute(cls, 图像, 人像遮罩, 处理区域="人像", 编辑需求="", 全局要求=""):
            return io.NodeOutput(*prepare_region(图像, 人像遮罩, 处理区域, 编辑需求, 全局要求))

    GGRegionEditPrepare = GGRegionEditPrepare_V3


NODE_CLASS_MAPPINGS = {_NODE_ID: GGRegionEditPrepare}
NODE_DISPLAY_NAME_MAPPINGS = {_NODE_ID: _DISPLAY_NAME}
