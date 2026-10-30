"""蒙版诊断：把「用户画的蒙版到底被识别成了什么」直接画出来看。

不参与生成、不修改输入，只做两件事：
1. 输出一张预览图——原图上把「人物有效区」染成半透明色，背景轻微压暗，
   让用户一眼确认颜色是不是落在人物身上（涂反、没涂上、涂成整张都能立刻看出来）；
2. 输出一段中文诊断——尺寸是否一致、有效占比、平均权重、结论与改法。

本节点刻意**不抛错**：它的用途就是在正式节点报错之前先把问题显示出来。
真正拦截仍由 `GG 分区编辑准备` 负责，两处的判定口径保持一致（阈值 0.1、有效区 ≥ 0.2%）。
"""

import torch

try:
    from comfy_api.latest import io
except ImportError:
    io = None


_NODE_ID = "GGMaskCheck"
_DISPLAY_NAME = "GG 蒙版诊断"
_CATEGORY = "GuliNodes/图像"
_COLORS = {"青绿": (0.16, 0.85, 0.66), "品红": (0.93, 0.32, 0.6), "橙黄": (1.0, 0.67, 0.2)}
_THRESHOLD = 0.1
_MIN_RATIO = 0.002
_DESCRIPTION = (
    "检查人像遮罩是否被正确识别：原图上把人物有效区染成半透明色、背景轻微压暗，"
    "并给出尺寸、有效占比、平均权重与结论。不修改图像，不报错；正式拦截由分区编辑准备负责。"
)
_INPUT_TOOLTIPS = {
    "图像": "用于叠加预览的原图，单张或多张（只用第一张诊断）。",
    "人像遮罩": "遮罩编辑器保存后的人像选区：白色为人物、黑色为背景。",
    "叠加颜色": "人物有效区在图上的染色，仅影响预览。",
    "叠加不透明度": "染色强度：太小看不清选区，太大会盖住细节。",
    "背景压暗": "把人物以外的区域压暗多少，用于对比；0 表示不压暗。",
}
_OUTPUT_TOOLTIPS = (
    "叠加了人物选区的预览图，尺寸与输入图像一致。",
    "中文诊断：尺寸、有效占比、平均权重、结论与建议改法。",
    "与分区编辑准备同口径：尺寸一致且人物有效区不少于 0.2%、未覆盖整图时为真。",
)


def _first_image(图像):
    if not isinstance(图像, torch.Tensor) or 图像.is_complex():
        return None
    if 图像.ndim == 4 and 图像.shape[0] >= 1 and 图像.shape[3] in (3, 4):
        return 图像[:1]
    return None


def _normalize_mask(人像遮罩):
    """返回 ([1,H,W] 遮罩, 失败原因, 附加提示)；形状不支持时遮罩为 None。"""
    if not isinstance(人像遮罩, torch.Tensor) or 人像遮罩.is_complex():
        return None, "人像遮罩不是有效张量", ""
    批次 = 0
    if 人像遮罩.ndim == 4 and 人像遮罩.shape[1] == 1:
        批次 = 人像遮罩.shape[0]
        m = 人像遮罩[:1, 0]
    elif 人像遮罩.ndim == 4 and 人像遮罩.shape[:3] == (1, 1, 1):
        批次 = 1
        m = 人像遮罩.reshape(1, 人像遮罩.shape[2], 人像遮罩.shape[3])
    elif 人像遮罩.ndim == 3:
        批次 = 人像遮罩.shape[0]
        m = 人像遮罩[:1]
    elif 人像遮罩.ndim == 2:
        批次 = 1
        m = 人像遮罩.unsqueeze(0)
    else:
        return None, f"遮罩形状 {tuple(人像遮罩.shape)} 不支持（需要 [高,宽] / [1,高,宽] / [1,1,高,宽]）", ""
    if m.shape[1] <= 0 or m.shape[2] <= 0:
        return None, "遮罩宽高必须大于零", ""
    if not torch.isfinite(m).all().item():
        return None, "遮罩含 NaN/Inf", ""
    if ((m < 0) | (m > 1)).any().item():
        return None, "遮罩数值超出 0–1", ""
    提示 = f"遮罩含 {批次} 张，只诊断第一张；正式节点会拒绝多张批次，请拆分后使用。" if 批次 > 1 else ""
    # 统一成 float32 统计：消费端（裁剪/采样）也按 float32 处理，口径一致。
    return m.to(dtype=torch.float32), "", 提示


def _ratio(count, total):
    if not total:
        return "0.00%"
    pct = count * 100.0 / total
    # 极小占比保留一位有效信息，避免「16 个像素」被显示成 0.00% 让人误判成完全没涂。
    return "<0.01%" if 0 < pct < 0.01 else f"{pct:.2f}%"


def diagnose(图像, 人像遮罩, 叠加颜色="青绿", 叠加不透明度=0.35, 背景压暗=0.12):
    """返回 (预览图, 诊断文本, 是否可用)。任何异常都转成可读诊断，不抛错。"""
    picture = _first_image(图像)
    if picture is None:
        灰色 = torch.full((1, 64, 64, 3), 0.5, dtype=torch.float32)
        return 灰色, "图像输入无效：请连接单张 RGB/RGBA 图像（数值 0–1）。", False

    rgb = picture[..., :3].to(torch.float32)
    高, 宽 = rgb.shape[1:3]
    总像素 = 高 * 宽
    mask, reason, 批次提示 = _normalize_mask(人像遮罩)
    颜色 = _COLORS.get(叠加颜色, _COLORS["青绿"])
    强度 = float(min(max(float(叠加不透明度), 0.0), 1.0))
    压暗 = float(min(max(float(背景压暗), 0.0), 1.0))

    if mask is None:
        return rgb, f"蒙版无法识别：{reason}。\n请用加载图像的遮罩编辑器涂选人物并保存。", False

    遮罩高, 遮罩宽 = mask.shape[1:3]
    尺寸一致 = (遮罩高, 遮罩宽) == (高, 宽)
    预览遮罩 = mask
    尺寸说明 = f"图像 {宽}×{高}，蒙版 {遮罩宽}×{遮罩高}：尺寸一致"
    if 批次提示:
        尺寸说明 += "\n" + 批次提示
    if not 尺寸一致:
        # 只为预览缩放，不改变正式节点的「尺寸必须一致」拦截。
        预览遮罩 = torch.nn.functional.interpolate(mask.unsqueeze(0), size=(高, 宽), mode="bilinear", align_corners=False)[0]
        尺寸说明 = f"图像 {宽}×{高}，蒙版 {遮罩宽}×{遮罩高}：尺寸不一致（预览已临时缩放，正式节点会拒绝）"

    有效像素 = torch.count_nonzero(预览遮罩 > _THRESHOLD).item()
    非零像素 = torch.count_nonzero(预览遮罩 > 0).item()
    # 只统计有效区内的均值：整图均值会被大片 0 稀释，看不出笔刷实际权重。
    有效区均值 = 预览遮罩[预览遮罩 > _THRESHOLD].mean().item() if 有效像素 else 0.0
    反相像素 = 总像素 - 有效像素
    占比 = 有效像素 / 总像素 if 总像素 else 0.0
    反占比 = 反相像素 / 总像素 if 总像素 else 0.0

    # 预览：人物区染色，背景按比例压暗；背景压暗让人一眼区分「颜色落在谁身上」。
    色 = torch.tensor(颜色, dtype=torch.float32, device=rgb.device).view(1, 1, 1, 3)
    色层 = torch.zeros_like(rgb)
    色层[:] = 色
    人物层 = rgb * (1 - 强度) + 色层 * 强度
    背景层 = rgb * (1 - 压暗)
    w = 预览遮罩.unsqueeze(-1).to(rgb.device)
    预览 = 背景层 * (1 - w) + 人物层 * w

    可用 = bool(尺寸一致 and 有效像素 * 500 >= 总像素 and 有效像素 < 总像素)

    lines = [尺寸说明]
    if 有效像素 == 0:
        lines.append("人物有效区 0.00%（全黑）：没有涂上或没有保存成功。")
        lines.append("改法：右键加载图像 → 遮罩编辑器，涂完确认画布上有涂选痕迹再点保存。")
    elif 有效像素 == 总像素:
        lines.append("人物有效区 100.00%（全白）：整张图都被涂成人物。")
        lines.append("改法：只涂人物，背景保持黑色；可用大笔刷先清空再涂。")
    elif 占比 < _MIN_RATIO:
        lines.append(f"人物有效区 {_ratio(有效像素, 总像素)}（不足 0.2%）：涂选范围过小。")
        if 反占比 > 0.05:
            lines.append(
                f"反相后有 {_ratio(反相像素, 总像素)}：如果预览里颜色落在背景上，说明涂反了——白色才是人物。"
            )
        lines.append("改法：放大笔刷覆盖人物主体，不要只描轮廓线。")
    elif 占比 > 0.95:
        lines.append(f"人物有效区 {_ratio(有效像素, 总像素)}：几乎整张图都被涂成人物，请确认是否涂错。")
        lines.append("如果人物确实占满画面可以继续；否则重新涂选，背景留黑。")
    else:
        lines.append(
            f"人物有效区 {_ratio(有效像素, 总像素)}，背景 {_ratio(反相像素, 总像素)}；"
            f"有效区平均权重 {有效区均值:.2f}，最高 {预览遮罩.max().item():.2f}。"
        )

    if 非零像素 > 有效像素:
        lines.append(
            f"另有 {_ratio(非零像素 - 有效像素, 总像素)} 像素权重不高于 0.1（软边或低透明度笔刷），不会参与编辑。"
        )
    if not 尺寸一致:
        lines.append("改法：用同一张图像的遮罩编辑器重新涂选并保存，不要混用不同尺寸的图。")

    lines.append("结论：" + ("可用" if 可用 else "不可用，按上面的改法调整后重跑本节点"))
    return 预览, "\n".join(lines), 可用


class GGMaskCheck:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE", {"tooltip": _INPUT_TOOLTIPS["图像"]}),
                "人像遮罩": ("MASK", {"tooltip": _INPUT_TOOLTIPS["人像遮罩"]}),
                "叠加颜色": (list(_COLORS), {"default": "青绿", "tooltip": _INPUT_TOOLTIPS["叠加颜色"]}),
                "叠加不透明度": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": _INPUT_TOOLTIPS["叠加不透明度"]}),
                "背景压暗": ("FLOAT", {"default": 0.12, "min": 0.0, "max": 0.8, "step": 0.02, "tooltip": _INPUT_TOOLTIPS["背景压暗"]}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "BOOLEAN")
    RETURN_NAMES = ("预览图", "诊断", "是否可用")
    OUTPUT_TOOLTIPS = _OUTPUT_TOOLTIPS
    FUNCTION = "execute"
    CATEGORY = _CATEGORY
    DESCRIPTION = _DESCRIPTION

    def execute(self, 图像, 人像遮罩, 叠加颜色="青绿", 叠加不透明度=0.35, 背景压暗=0.12):
        return diagnose(图像, 人像遮罩, 叠加颜色, 叠加不透明度, 背景压暗)


if io is not None:
    class GGMaskCheck_V3(io.ComfyNode):
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
                    io.Combo.Input("叠加颜色", options=list(_COLORS), default="青绿", tooltip=_INPUT_TOOLTIPS["叠加颜色"]),
                    io.Float.Input("叠加不透明度", default=0.35, min=0.0, max=1.0, step=0.05, tooltip=_INPUT_TOOLTIPS["叠加不透明度"]),
                    io.Float.Input("背景压暗", default=0.12, min=0.0, max=0.8, step=0.02, tooltip=_INPUT_TOOLTIPS["背景压暗"]),
                ],
                outputs=[
                    io.Image.Output("预览图", tooltip=_OUTPUT_TOOLTIPS[0]),
                    io.String.Output("诊断", tooltip=_OUTPUT_TOOLTIPS[1]),
                    io.Boolean.Output("是否可用", tooltip=_OUTPUT_TOOLTIPS[2]),
                ],
            )

        @classmethod
        def execute(cls, 图像, 人像遮罩, 叠加颜色="青绿", 叠加不透明度=0.35, 背景压暗=0.12):
            return io.NodeOutput(*diagnose(图像, 人像遮罩, 叠加颜色, 叠加不透明度, 背景压暗))

    GGMaskCheck = GGMaskCheck_V3


NODE_CLASS_MAPPINGS = {_NODE_ID: GGMaskCheck}
NODE_DISPLAY_NAME_MAPPINGS = {_NODE_ID: _DISPLAY_NAME}
