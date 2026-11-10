"""遮罩驱动的图像操作：裁剪、回贴与按遮罩合并。

按遮罩的白色范围裁出一块局部区域（可四边不等量扩展、可按倍数对齐、可缩放到指定宽高），
把裁剪位置与尺寸打包成「接缝」传给下游；处理完成后用 `GG 裁剪恢复` 把结果羽化贴回原图。
`GG 局部重绘裁剪` 是同一套接缝的重绘向变体：裁剪前先对遮罩做低值过滤 / 补洞 / 膨胀 / 反相，
支持按「宽高各自」的比例取上下文、画面外扩（真外扩画布）与强制采样尺寸。
另有 `GG 图像合并（遮罩）`：按遮罩把覆盖图混到背景图上，遮罩可先扩展/羽化。

整条链路只用 torch / numpy / PIL，不引入 cv2、scipy。
"""

import numpy as np
import torch
import torch.nn.functional as torch_F
from PIL import Image, ImageDraw

from .aspect_ratio import (
    IMAGE_ASPECT_RATIOS,
    LATENT_ASPECT_RATIOS,
    ORIENTATION_TYPES,
    RESOLUTION_OPTIONS,
    SIDE_TYPES,
    _unpack_mode,
    align_to_eight,
    dimensions_by_ratio,
    dimensions_by_resolution,
    edge_pixels,
)
from .image_tools import _to_rgb_image

try:
    from comfy_api.latest import io
except Exception:
    io = None


SEAM_TYPE = "GG_SEAM"
_接缝类型 = io.Custom(SEAM_TYPE) if io is not None else None

_扩展方式_统一 = "四边统一"
_扩展方式_分别 = "分别设置"
_输出尺寸_原像素 = "原像素"
_输出尺寸_正方 = "原像素1:1"
_输出尺寸_按边长 = "按边长"
_输出尺寸_按K数 = "按K数分辨率"
_输出尺寸_按宽高 = "按宽高"
_输出尺寸_局部重绘 = "局部重绘"
_输出尺寸选项 = (
    _输出尺寸_原像素,
    _输出尺寸_正方,
    _输出尺寸_按边长,
    _输出尺寸_按K数,
    _输出尺寸_按宽高,
)

_四边 = ("上", "下", "左", "右")

_遮罩阈值 = 0.1
# 遮罩有效像素低于整图这个比例时视为「没有遮罩」，直接按整图裁剪，
# 免得被几个噪点裁出一个针尖大小的区域。
_最小遮罩占比 = 0.002
# 「低值过滤」低于这个值时不起作用：0.01 的阈值只会滤掉 1/255 级别的噪声，
# 不值得为它整片重算一遍遮罩。
_低值过滤阈值 = 0.01


# ---------------------------------------------------------------------------
# 基础转换
# ---------------------------------------------------------------------------


def _图像数组(图像, 名称="图像"):
    """返回 (单图列表, 整批张量)。统一转成 RGB 浮点，避免 1/2/4 通道分支散落各处。"""
    if 图像 is None:
        raise ValueError(f"没有收到图像。请把图像接到「{名称}」输入。")
    张量 = _to_rgb_image(图像)
    数组 = 张量.detach().float().cpu().numpy()
    if 数组.ndim == 3:
        数组 = 数组[None, ...]
    return [数组[i] for i in range(数组.shape[0])], 张量


def _遮罩数组(遮罩, 名称="遮罩"):
    数组 = 遮罩
    if isinstance(数组, torch.Tensor):
        数组 = 数组.detach().float().cpu().numpy()
    数组 = np.asarray(数组, dtype=np.float32)
    if 数组.ndim == 3:
        数组 = 数组[0]
    while 数组.ndim > 2:
        数组 = 数组[..., 0]
    if 数组.ndim != 2 or 数组.size == 0:
        raise ValueError(f"「{名称}」不是有效的遮罩数据。请接 MASK 类型的输出。")
    return np.clip(数组, 0.0, 1.0)


def _缩放图像(图像, 宽, 高):
    """按 LANCZOS 缩放单张图像数组。"""
    if 图像.shape[1] == 宽 and 图像.shape[0] == 高:
        return 图像
    pil = Image.fromarray(np.clip(图像 * 255.0, 0, 255).astype(np.uint8))
    return np.asarray(pil.resize((宽, 高), Image.LANCZOS)).astype(np.float32) / 255.0


def _缩放遮罩(遮罩, 宽, 高):
    """遮罩缩放走浮点插值，避免 8 位量化在大半径羽化后出现断层。"""
    if 遮罩.shape[1] == 宽 and 遮罩.shape[0] == 高:
        return 遮罩
    张量 = torch.from_numpy(np.clip(遮罩, 0.0, 1.0).astype(np.float32))[None, None]
    if 高 <= 遮罩.shape[0] and 宽 <= 遮罩.shape[1]:
        模式 = "area"
    else:
        模式 = "bilinear"
    结果 = torch_F.interpolate(张量, size=(高, 宽), mode=模式, align_corners=None if 模式 == "area" else False)
    return 结果[0, 0].clamp(0.0, 1.0).numpy()


# ---------------------------------------------------------------------------
# 遮罩处理
# ---------------------------------------------------------------------------


def _填充孔洞(二值遮罩):
    """把遮罩内部被围住的空洞补实（用 PIL 的洪水填充，无需 scipy）。"""
    高, 宽 = 二值遮罩.shape
    画布 = Image.new("L", (宽 + 2, 高 + 2), 0)
    画布.paste(Image.fromarray(二值遮罩.astype(np.uint8) * 255), (1, 1))
    # 外圈补一圈 0 之后，从 (0,0) 洪水填充一次就能覆盖所有与边界连通的背景，
    # 剩下的 0 值像素就是被前景围住的孔洞。
    ImageDraw.floodfill(画布, (0, 0), 128)
    外部 = np.asarray(画布)[1:-1, 1:-1]
    return 二值遮罩 | (外部 == 0)


def _膨胀遮罩(遮罩, 半径):
    """矩形膨胀（可分离的最大池化），比按 (2r+1)² 的核做一次卷积便宜得多。"""
    if 半径 <= 0:
        return 遮罩
    核 = 2 * int(半径) + 1
    张量 = torch.from_numpy(遮罩.astype(np.float32))[None, None]
    张量 = torch_F.max_pool2d(张量, (1, 核), stride=1, padding=(0, 核 // 2))
    张量 = torch_F.max_pool2d(张量, (核, 1), stride=1, padding=(核 // 2, 0))
    return 张量[0, 0].numpy()


def _高斯羽化(遮罩, 半径):
    if 半径 <= 0:
        return 遮罩
    σ = float(半径)
    半 = max(1, int(round(σ * 3)))
    坐标 = np.arange(-半, 半 + 1, dtype=np.float32)
    核 = np.exp(-0.5 * (坐标 / σ) ** 2)
    核 = (核 / 核.sum()).astype(np.float32)
    张量 = torch.from_numpy(np.clip(遮罩, 0.0, 1.0).astype(np.float32))[None, None]
    张量 = torch_F.conv2d(torch_F.pad(张量, (半, 半, 0, 0), mode="replicate"), torch.from_numpy(核).view(1, 1, 1, -1))
    张量 = torch_F.conv2d(torch_F.pad(张量, (0, 0, 半, 半), mode="replicate"), torch.from_numpy(核).view(1, 1, -1, 1))
    return 张量[0, 0].clamp(0.0, 1.0).numpy()


def _平滑阶跃(值):
    return 值 * 值 * (3.0 - 2.0 * 值)


def _边缘淡出(遮罩, 淡出上, 淡出下, 淡出左, 淡出右, 半径):
    """裁剪框超出原图的那一侧没有真实图像，让遮罩在人工边界内平滑降到 0。"""
    if 半径 <= 0:
        return 遮罩
    高, 宽 = 遮罩.shape
    if 淡出上 or 淡出下:
        位置 = np.arange(高, dtype=np.float32)
        权重 = np.ones(高, dtype=np.float32)
        if 淡出上:
            权重 = np.minimum(权重, 位置 / float(半径))
        if 淡出下:
            权重 = np.minimum(权重, (高 - 1 - 位置) / float(半径))
        遮罩 = 遮罩 * _平滑阶跃(np.clip(权重, 0.0, 1.0))[:, None]
    if 淡出左 or 淡出右:
        位置 = np.arange(宽, dtype=np.float32)
        权重 = np.ones(宽, dtype=np.float32)
        if 淡出左:
            权重 = np.minimum(权重, 位置 / float(半径))
        if 淡出右:
            权重 = np.minimum(权重, (宽 - 1 - 位置) / float(半径))
        遮罩 = 遮罩 * _平滑阶跃(np.clip(权重, 0.0, 1.0))[None, :]
    return 遮罩


# ---------------------------------------------------------------------------
# 裁剪
# ---------------------------------------------------------------------------


def _边缘众数颜色(图像, 框, 方向, 采样宽度=10):
    """取该方向边缘一窄条像素里出现最多的颜色（按 16 级量化），用于填补越界区域。"""
    左, 上, 右, 下 = 框
    高, 宽 = 图像.shape[:2]
    if 方向 == "左" and 左 < 0:
        x0, x1 = 0, min(采样宽度, 宽)
        y0, y1 = max(0, 上), min(高, 下)
    elif 方向 == "右" and 右 > 宽:
        x1 = 宽
        x0 = max(0, 宽 - 采样宽度)
        y0, y1 = max(0, 上), min(高, 下)
    elif 方向 == "上" and 上 < 0:
        y0, y1 = 0, min(采样宽度, 高)
        x0, x1 = max(0, 左), min(宽, 右)
    elif 方向 == "下" and 下 > 高:
        y1 = 高
        y0 = max(0, 高 - 采样宽度)
        x0, x1 = max(0, 左), min(宽, 右)
    else:
        return None
    条带 = 图像[y0:y1, x0:x1]
    if 条带.size == 0:
        return None
    量化 = (np.clip(条带, 0.0, 1.0) * 255.0 // 16.0 * 16.0).astype(np.int16).reshape(-1, 3)
    颜色值, 次数 = np.unique(量化, axis=0, return_counts=True)
    return (颜色值[int(次数.argmax())].astype(np.float32) / 255.0)


def _裁剪图像(图像, 框):
    """按框裁图，越界部分用对应方向的边缘众数颜色补，四角取最后填充的方向。"""
    左, 上, 右, 下 = 框
    高, 宽 = 图像.shape[:2]
    输出宽, 输出高 = 右 - 左, 下 - 上
    输出 = np.zeros((输出高, 输出宽, 3), dtype=np.float32)

    if 左 < 0:
        颜色 = _边缘众数颜色(图像, 框, "左")
        if 颜色 is not None:
            输出[:, : min(-左, 输出宽)] = 颜色
    if 右 > 宽:
        颜色 = _边缘众数颜色(图像, 框, "右")
        if 颜色 is not None:
            输出[:, max(0, 输出宽 - (右 - 宽)) :] = 颜色
    if 上 < 0:
        颜色 = _边缘众数颜色(图像, 框, "上")
        if 颜色 is not None:
            输出[: min(-上, 输出高), :] = 颜色
    if 下 > 高:
        颜色 = _边缘众数颜色(图像, 框, "下")
        if 颜色 is not None:
            输出[max(0, 输出高 - (下 - 高)) :, :] = 颜色

    有效左, 有效上 = max(0, 左), max(0, 上)
    有效右, 有效下 = min(宽, 右), min(高, 下)
    if 有效右 > 有效左 and 有效下 > 有效上:
        输出[有效上 - 上 : 有效下 - 上, 有效左 - 左 : 有效右 - 左] = 图像[有效上:有效下, 有效左:有效右]
    return 输出


def _裁剪遮罩(遮罩, 框):
    """遮罩越界部分一律补黑。"""
    左, 上, 右, 下 = 框
    高, 宽 = 遮罩.shape[:2]
    输出 = np.zeros((下 - 上, 右 - 左), dtype=np.float32)
    有效左, 有效上 = max(0, 左), max(0, 上)
    有效右, 有效下 = min(宽, 右), min(高, 下)
    if 有效右 > 有效左 and 有效下 > 有效上:
        输出[有效上 - 上 : 有效下 - 上, 有效左 - 左 : 有效右 - 左] = 遮罩[有效上:有效下, 有效左:有效右]
    return 输出


def _对齐倍数(值, 倍数, 向上):
    if 倍数 <= 1:
        return int(值)
    商 = 值 / 倍数
    return int(np.ceil(商) * 倍数) if 向上 else int(np.floor(商) * 倍数)


def _需要缩放补边(尺寸方式):
    """按边长 / 按K数 / 按宽高 要先缩放到目标尺寸再居中补边；原像素两种直接裁。"""
    return 尺寸方式 in (_输出尺寸_按边长, _输出尺寸_按K数, _输出尺寸_按宽高)


def _按配置算宽高(尺寸方式, 配置):
    """按「输出尺寸」当前方式自带的配置算出目标像素宽高（已对齐到 8）。"""
    if 尺寸方式 == _输出尺寸_按宽高:
        宽 = edge_pixels(配置.get("宽度", 1024), "宽度")
        高 = edge_pixels(配置.get("高度", 1024), "高度")
        return align_to_eight(宽), align_to_eight(高)
    if 尺寸方式 == _输出尺寸_按K数:
        return dimensions_by_resolution(
            配置.get("宽高比例", "9:16"),
            配置.get("分辨率", "1K"),
            配置.get("画面方向", "横屏"),
        )
    return dimensions_by_ratio(
        配置.get("宽高比例", "16:9"),
        配置.get("边长", 1024),
        配置.get("边长类型", "最长边"),
        配置.get("画面方向", "横屏"),
    )


def _计算裁剪框(二值遮罩, 扩展量, 尺寸方式, 配置):
    """返回 (裁剪框, 遮罩白色区域宽高, 目标宽高)。"""
    高, 宽 = 二值遮罩.shape
    纵, 横 = np.nonzero(二值遮罩)
    if 纵.size == 0:
        raise ValueError("遮罩里没有白色区域。请检查遮罩来源，或把「遮罩填充」关掉后重试。")

    上沿, 下沿 = int(纵.min()), int(纵.max())
    左沿, 右沿 = int(横.min()), int(横.max())
    遮罩宽, 遮罩高 = 右沿 - 左沿 + 1, 下沿 - 上沿 + 1
    短边 = min(遮罩宽, 遮罩高)

    上扩 = max(0, min(int(短边 * (扩展量["上"] - 1.0)), 上沿))
    下扩 = max(0, min(int(短边 * (扩展量["下"] - 1.0)), 高 - 下沿 - 1))
    左扩 = max(0, min(int(短边 * (扩展量["左"] - 1.0)), 左沿))
    右扩 = max(0, min(int(短边 * (扩展量["右"] - 1.0)), 宽 - 右沿 - 1))

    基础左, 基础上 = 左沿 - 左扩, 上沿 - 上扩
    基础右, 基础下 = 右沿 + 1 + 右扩, 下沿 + 1 + 下扩
    基础宽, 基础高 = 基础右 - 基础左, 基础下 - 基础上
    中心x, 中心y = (基础左 + 基础右) // 2, (基础上 + 基础下) // 2

    倍数取整 = int(配置.get("倍数取整", 8))
    if 尺寸方式 == _输出尺寸_原像素:
        裁剪宽, 裁剪高 = 基础宽, 基础高
        if 倍数取整 > 1:
            # 向上取整：宁可多带一圈边缘颜色，也不裁掉遮罩像素。
            裁剪宽 = _对齐倍数(裁剪宽, 倍数取整, True)
            裁剪高 = _对齐倍数(裁剪高, 倍数取整, True)
        裁剪宽, 裁剪高 = max(1, 裁剪宽), max(1, 裁剪高)
        左, 上 = 中心x - 裁剪宽 // 2, 中心y - 裁剪高 // 2
        右, 下 = 左 + 裁剪宽, 上 + 裁剪高
        目标宽, 目标高 = 裁剪宽, 裁剪高

    elif 尺寸方式 == _输出尺寸_正方:
        边长 = max(基础宽, 基础高)
        if 倍数取整 > 1:
            边长 = _对齐倍数(边长, 倍数取整, True)
        边长 = max(1, 边长)
        左, 上 = 中心x - 边长 // 2, 中心y - 边长 // 2
        右, 下 = 左 + 边长, 上 + 边长
        目标宽 = 目标高 = 边长

    else:
        目标宽, 目标高 = _按配置算宽高(尺寸方式, 配置)
        目标宽, 目标高 = max(1, 目标宽), max(1, 目标高)

        # 先把裁剪框按目标宽高比扩到同比例（保持中心），再整体缩放并补边到目标尺寸。
        目标比 = 目标宽 / 目标高
        基础比 = 基础宽 / 基础高
        if 基础比 < 目标比:
            扩展宽, 扩展高 = max(1, int(基础高 * 目标比)), 基础高
        else:
            扩展宽, 扩展高 = 基础宽, max(1, int(基础宽 / 目标比))
        左, 上 = 中心x - 扩展宽 // 2, 中心y - 扩展高 // 2
        右, 下 = 左 + 扩展宽, 上 + 扩展高

    return (int(左), int(上), int(右), int(下)), (遮罩宽, 遮罩高), (目标宽, 目标高)


def _百分比像素(百分比, 遮罩宽高):
    if 百分比 <= 0:
        return 0
    平均值 = (遮罩宽高[0] + 遮罩宽高[1]) / 2.0
    return max(1, int(平均值 * float(百分比) / 100.0))


# ---------------------------------------------------------------------------
# 局部重绘裁剪的几何计算
# ---------------------------------------------------------------------------


def _遮罩范围(二值遮罩):
    """返回白色区域的外接框 (左, 上, 右, 下)，右/下是开区间；全黑返回 None。"""
    纵, 横 = np.nonzero(二值遮罩)
    if 纵.size == 0:
        return None
    return int(横.min()), int(纵.min()), int(横.max()) + 1, int(纵.max()) + 1


def _外接框合并(甲, 乙):
    return (
        min(甲[0], 乙[0]),
        min(甲[1], 乙[1]),
        max(甲[2], 乙[2]),
        max(甲[3], 乙[3]),
    )


def _按系数外扩(框, 系数, 画布宽, 画布高):
    """宽、高各自按 (系数 - 1) / 2 向两边等量扩，再夹到画布内。

    与「GG 遮罩裁剪」的「按短边乘系数」不同：这里宽高分开算，扁长的遮罩
    不会因为短边小而拿不到左右上下文，语义与「Inpaint Crop」一致。
    """
    左, 上, 右, 下 = 框
    扩宽 = int(round((右 - 左) * (float(系数) - 1.0) / 2.0))
    扩高 = int(round((下 - 上) * (float(系数) - 1.0) / 2.0))
    return (
        max(0, 左 - 扩宽),
        max(0, 上 - 扩高),
        min(画布宽, 右 + 扩宽),
        min(画布高, 下 + 扩高),
    )


def _居中裁框(框, 宽, 高, 画布宽, 画布高):
    """以原框中心为准取 宽×高；装得进画布就贴回画布内，装不进就居中溢出。

    溢出部分在裁图时由「边缘颜色」补上：这是「强制采样尺寸比画布还大」时
    唯一能给出完整尺寸的做法，也让 outpainting 与强制尺寸两条路共用同一段代码。
    """
    中心x = (框[0] + 框[2]) / 2.0
    中心y = (框[1] + 框[3]) / 2.0
    左 = int(round(中心x - 宽 / 2.0))
    上 = int(round(中心y - 高 / 2.0))
    if 宽 <= 画布宽:
        左 = min(max(左, 0), 画布宽 - 宽)
    else:
        左 = -((宽 - 画布宽) // 2)
    if 高 <= 画布高:
        上 = min(max(上, 0), 画布高 - 高)
    else:
        上 = -((高 - 画布高) // 2)
    return 左, 上, 左 + 宽, 上 + 高


def _局部重绘目标尺寸(框, 输出宽度, 输出高度, 尺寸对齐):
    """给了输出宽高就用它，没给就按上下文框自身大小向上对齐。"""
    对齐 = max(1, int(尺寸对齐))
    if int(输出宽度) > 0 and int(输出高度) > 0:
        目标宽 = _对齐倍数(max(1, int(输出宽度)), 对齐, True)
        目标高 = _对齐倍数(max(1, int(输出高度)), 对齐, True)
    else:
        目标宽 = _对齐倍数(max(1, 框[2] - 框[0]), 对齐, True)
        目标高 = _对齐倍数(max(1, 框[3] - 框[1]), 对齐, True)
    return max(1, 目标宽), max(1, 目标高)


# ---------------------------------------------------------------------------
# 参数拆包（DynamicCombo 与 legacy 扁平参数共用）
# ---------------------------------------------------------------------------


def _拆裁剪参数(扩展方式, 输出尺寸, 额外):
    def _并入(来源, 目标):
        # 兼容 DynamicCombo 的三种形状：嵌套、扁平、以及带点号前缀的扁平键
        # （"扩展方式.扩展系数"），后两种在旧前端和 API 直连时都会出现。
        for 键, 值 in (来源 or {}).items():
            目标[str(键).split(".", 1)[-1]] = 值

    合并 = {}
    _并入(额外, 合并)
    方式, 值 = _unpack_mode(扩展方式, "扩展方式", None)
    _并入(值, 合并)
    尺寸方式, 尺寸值 = _unpack_mode(输出尺寸, "输出尺寸", None)
    _并入(尺寸值, 合并)

    if 方式 == _扩展方式_分别:
        扩展量 = {边: float(合并.get(f"扩展系数{边}", 1.4)) for 边 in _四边}
    else:
        统一 = float(合并.get("扩展系数", 1.4))
        扩展量 = {边: 统一 for 边 in _四边}

    # 旧工作流里可能还存着已经下线的「自定义宽高」，这里统一退回「原像素」。
    尺寸方式 = 尺寸方式 if 尺寸方式 in _输出尺寸选项 else _输出尺寸_原像素
    return 扩展量, 尺寸方式, 合并


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def _执行遮罩裁剪(图像, 遮罩, 遮罩填充, 扩展量, 尺寸方式, 配置):
    图像列表, 图像张量 = _图像数组(图像)
    原图高, 原图宽 = 图像列表[0].shape[:2]

    遮罩数组 = _遮罩数组(遮罩)
    if 遮罩数组.shape != (原图高, 原图宽):
        raise ValueError(
            f"遮罩尺寸 {遮罩数组.shape[1]}x{遮罩数组.shape[0]} 与图像尺寸 {原图宽}x{原图高} 不一致，"
            "请确认遮罩和图像来自同一张图。"
        )

    二值 = 遮罩数组 > _遮罩阈值
    if float(二值.mean()) < _最小遮罩占比:
        # 遮罩几乎全黑时按整图裁剪，避免被零星噪点裁出一个针尖区域。
        二值 = np.ones((原图高, 原图宽), dtype=bool)
    if 遮罩填充:
        二值 = _填充孔洞(二值)

    框, 遮罩宽高, (目标宽, 目标高) = _计算裁剪框(二值, 扩展量, 尺寸方式, 配置)
    裁剪宽, 裁剪高 = 框[2] - 框[0], 框[3] - 框[1]
    需缩放 = _需要缩放补边(尺寸方式)

    缩放宽高 = None
    填充偏移 = None
    if 需缩放:
        比例 = min(目标宽 / 裁剪宽, 目标高 / 裁剪高)
        缩放宽 = max(1, int(裁剪宽 * 比例))
        缩放高 = max(1, int(裁剪高 * 比例))
        缩放宽高 = (缩放宽, 缩放高)

    裁剪遮罩 = _裁剪遮罩(二值.astype(np.float32), 框)
    if 需缩放:
        裁剪遮罩 = _缩放遮罩(裁剪遮罩, 缩放宽高[0], 缩放宽高[1])

    裁剪结果 = []
    for 单图 in 图像列表:
        裁剪图 = _裁剪图像(单图, 框)
        if 需缩放:
            裁剪图 = _缩放图像(裁剪图, 缩放宽高[0], 缩放宽高[1])
        裁剪结果.append(裁剪图)

    if 需缩放:
        画布 = np.zeros((目标高, 目标宽, 3), dtype=np.float32)
        偏移x, 偏移y = (目标宽 - 缩放宽高[0]) // 2, (目标高 - 缩放宽高[1]) // 2
        填充偏移 = (偏移x, 偏移y)
        for 下标, 裁剪图 in enumerate(裁剪结果):
            局部 = np.zeros((目标高, 目标宽, 3), dtype=np.float32)
            局部[偏移y : 偏移y + 缩放宽高[1], 偏移x : 偏移x + 缩放宽高[0]] = 裁剪图
            裁剪结果[下标] = 局部
        遮罩画布 = np.zeros((目标高, 目标宽), dtype=np.float32)
        遮罩画布[偏移y : 偏移y + 缩放宽高[1], 偏移x : 偏移x + 缩放宽高[0]] = 裁剪遮罩
        裁剪遮罩 = 遮罩画布

    图像批次 = torch.from_numpy(np.stack(裁剪结果).astype(np.float32))
    遮罩批次 = torch.from_numpy(np.repeat(裁剪遮罩[None, ...], len(裁剪结果), axis=0).astype(np.float32))

    接缝数据 = {
        "版本": 1,
        "原图宽高": (原图宽, 原图高),
        "裁剪框": 框,
        "裁剪宽高": (裁剪宽, 裁剪高),
        "目标宽高": (目标宽, 目标高),
        "缩放宽高": 缩放宽高,
        "填充偏移": 填充偏移,
        "输出尺寸方式": 尺寸方式,
        "遮罩白色区域宽高": 遮罩宽高,
        "原始图像": 图像张量,
        "原始遮罩": torch.from_numpy(二值.astype(np.float32))[None, ...],
    }
    return 接缝数据, 图像批次, 遮罩批次


def _匹配颜色(裁剪, 参考, 强度):
    """用同位置「没被改动」的像素估一个整体色差，修正贴回区域的偏色。"""
    差 = np.abs(参考 - 裁剪)
    候选 = 差.max(axis=2) <= 24.0 / 255.0
    if int(候选.sum()) < max(16, int(候选.size * 0.02)):
        return 裁剪
    偏移 = np.median(参考[候选] - 裁剪[候选], axis=0)
    偏移 = np.clip(偏移, -24.0 / 255.0, 24.0 / 255.0) * float(强度)
    return np.clip(裁剪 + 偏移.astype(np.float32), 0.0, 1.0)


def _外扩画布背景(背景, 画布框):
    """把原图摆进更大的画布，外扩出来的部分用最外圈像素延展。

    这里不用「边缘众数颜色」填：外扩是 outpainting 的底，平铺一块平均色会在
    画布边上看到一条直边色带；按行列延展则和裁剪端 `np.pad(mode="edge")` 的
    结果一致，贴回后接缝处看不出区别。
    """
    左, 上, 右, 下 = 画布框
    高, 宽 = 背景.shape[:2]
    上扩 = max(0, -上)
    下扩 = max(0, 下 - 高)
    左扩 = max(0, -左)
    右扩 = max(0, 右 - 宽)
    if not (上扩 or 下扩 or 左扩 or 右扩):
        return 背景
    return np.pad(背景, ((上扩, 下扩), (左扩, 右扩), (0, 0)), mode="edge")


def _执行裁剪恢复(接缝, 裁剪图像, 裁剪遮罩, 背景图像, 遮罩扩展, 遮罩羽化, 颜色还原):
    if not isinstance(接缝, dict) or "裁剪框" not in 接缝:
        raise ValueError(
            "「接缝」输入不是「GG 遮罩裁剪」或「GG 局部重绘裁剪」的输出。"
            "请把裁剪节点的「接缝」输出直接连到本节点。"
        )

    原图宽, 原图高 = 接缝["原图宽高"]
    # 「画布框」是接缝覆盖的画面范围（相对原图坐标）。只有「GG 局部重绘裁剪」做了
    # 画面外扩时它才会大于原图；老接缝没有这个键，退回原图范围，行为完全不变。
    画布框 = 接缝.get("画布框") or (0, 0, 原图宽, 原图高)
    画布框 = tuple(int(值) for 值 in 画布框)
    画布宽, 画布高 = 画布框[2] - 画布框[0], 画布框[3] - 画布框[1]
    左, 上, 右, 下 = 接缝["裁剪框"]
    裁剪宽, 裁剪高 = 接缝["裁剪宽高"]
    目标宽, 目标高 = 接缝["目标宽高"]
    缩放宽高 = 接缝.get("缩放宽高")
    填充偏移 = 接缝.get("填充偏移")
    遮罩宽高 = 接缝.get("遮罩白色区域宽高", (1, 1))

    图像列表, _ = _图像数组(裁剪图像)
    背景列表, _ = _图像数组(背景图像 if 背景图像 is not None else 接缝["原始图像"])
    背景 = 背景列表[0]
    if 背景.shape[1] != 原图宽 or 背景.shape[0] != 原图高:
        raise ValueError(
            f"背景图像尺寸 {背景.shape[1]}x{背景.shape[0]} 与接缝记录的原图尺寸 {原图宽}x{原图高} 不一致，"
            "请让背景图和裁剪时的图像同尺寸。"
        )
    # 外扩出来的画布区域没有真实像素，按行列延展原图边缘，贴回时才有像样的底。
    画布底 = 背景 if (画布宽, 画布高) == (原图宽, 原图高) else _外扩画布背景(背景, 画布框)

    遮罩画布 = None
    if 裁剪遮罩 is not None:
        候选 = _遮罩数组(裁剪遮罩, "裁剪遮罩")
        if float((候选 > _遮罩阈值).mean()) >= 0.001:
            遮罩画布 = _缩放遮罩(候选, 目标宽, 目标高) if 候选.shape != (目标高, 目标宽) else 候选
            if 填充偏移 is not None and 缩放宽高 is not None:
                偏移x, 偏移y = 填充偏移
                遮罩画布 = 遮罩画布[偏移y : 偏移y + 缩放宽高[1], 偏移x : 偏移x + 缩放宽高[0]]
            遮罩画布 = _缩放遮罩(遮罩画布, 裁剪宽, 裁剪高)
    if 遮罩画布 is None:
        原始遮罩 = _遮罩数组(接缝["原始遮罩"], "接缝遮罩")
        if 原始遮罩.shape != (画布高, 画布宽):
            raise ValueError(
                f"接缝里保存的遮罩是 {原始遮罩.shape[1]}x{原始遮罩.shape[0]}，"
                f"与接缝记录的画面 {画布宽}x{画布高} 不一致；请重新跑一次裁剪节点。"
            )
        # 原始遮罩存的是画布坐标（含外扩），裁剪框存的是原图坐标，这里补上偏移。
        遮罩画布 = _裁剪遮罩(
            原始遮罩,
            (左 - 画布框[0], 上 - 画布框[1], 右 - 画布框[0], 下 - 画布框[1]),
        )

    扩展像素 = _百分比像素(遮罩扩展, 遮罩宽高)
    羽化像素 = _百分比像素(遮罩羽化, 遮罩宽高)

    羽化遮罩 = np.zeros((裁剪高, 裁剪宽), dtype=np.float32)
    有效左, 有效上 = max(0, 画布框[0] - 左), max(0, 画布框[1] - 上)
    有效右, 有效下 = min(裁剪宽, 画布框[2] - 左), min(裁剪高, 画布框[3] - 上)
    if 有效右 > 有效左 and 有效下 > 有效上:
        子遮罩 = 遮罩画布[有效上:有效下, 有效左:有效右]
        子遮罩 = _膨胀遮罩(子遮罩, 扩展像素)
        子遮罩 = _高斯羽化(子遮罩, 羽化像素)
        # 裁剪边界落在画面内部时，那条边会在成图里留硬接缝，必须淡出；
        # 边界正好压在画布边上时不需要（那边本来就是图的边）。
        子遮罩 = _边缘淡出(
            子遮罩,
            上 > 画布框[1],
            下 < 画布框[3],
            左 > 画布框[0],
            右 < 画布框[2],
            羽化像素,
        )
        羽化遮罩[有效上:有效下, 有效左:有效右] = 子遮罩

    粘贴x, 粘贴y = 左 - 画布框[0], 上 - 画布框[1]
    源x, 源y = max(0, -粘贴x), max(0, -粘贴y)
    贴x, 贴y = max(0, 粘贴x), max(0, 粘贴y)
    源宽 = min(裁剪宽 - 源x, 画布宽 - 贴x)
    源高 = min(裁剪高 - 源y, 画布高 - 贴y)

    结果列表 = []
    for 单图 in 图像列表:
        恢复 = _缩放图像(单图, 目标宽, 目标高) if 单图.shape[:2] != (目标高, 目标宽) else 单图
        if 填充偏移 is not None and 缩放宽高 is not None:
            偏移x, 偏移y = 填充偏移
            恢复 = 恢复[偏移y : 偏移y + 缩放宽高[1], 偏移x : 偏移x + 缩放宽高[0]]
        恢复 = _缩放图像(恢复, 裁剪宽, 裁剪高)

        画布 = 画布底.copy()
        if 源宽 > 0 and 源高 > 0:
            底图 = 画布[贴y : 贴y + 源高, 贴x : 贴x + 源宽]
            新图 = 恢复[源y : 源y + 源高, 源x : 源x + 源宽]
            if 颜色还原 > 0:
                参考 = 画布底[贴y : 贴y + 源高, 贴x : 贴x + 源宽]
                新图 = _匹配颜色(新图, 参考, 颜色还原)
            权重 = 羽化遮罩[源y : 源y + 源高, 源x : 源x + 源宽][..., None]
            画布[贴y : 贴y + 源高, 贴x : 贴x + 源宽] = 底图 * (1.0 - 权重) + 新图 * 权重
        结果列表.append(画布)

    return torch.from_numpy(np.stack(结果列表).astype(np.float32))


# ---------------------------------------------------------------------------
# 局部重绘裁剪（遮罩预处理 + 上下文 + 外扩 + 强制尺寸）
# ---------------------------------------------------------------------------


def _执行局部重绘裁剪(
    图像,
    遮罩,
    上下文遮罩=None,
    遮罩填充=True,
    遮罩反相=False,
    遮罩扩展=0,
    低值过滤=0.1,
    上下文扩展=1.2,
    画面外扩=0,
    输出宽度=0,
    输出高度=0,
    尺寸对齐=8,
):
    图像列表, 图像张量 = _图像数组(图像)
    原图高, 原图宽 = 图像列表[0].shape[:2]

    遮罩数值 = _遮罩数组(遮罩)
    if 遮罩数值.shape != (原图高, 原图宽):
        raise ValueError(
            f"遮罩尺寸 {遮罩数值.shape[1]}x{遮罩数值.shape[0]} 与图像尺寸 {原图宽}x{原图高} 不一致，"
            "请确认遮罩和图像来自同一张图。"
        )

    上下文数值 = None
    if 上下文遮罩 is not None:
        上下文数值 = _遮罩数组(上下文遮罩, "上下文遮罩")
        if 上下文数值.shape != (原图高, 原图宽):
            raise ValueError(
                f"上下文遮罩尺寸 {上下文数值.shape[1]}x{上下文数值.shape[0]} 与图像尺寸 {原图宽}x{原图高} 不一致，"
                "两者必须同尺寸。"
            )

    # 处理顺序与 Inpaint Crop 一致：低值过滤 → 补洞 → 膨胀 → 反相。
    # 反相放在最后，是因为它常常被用来「先扩一圈再翻过来保留周围」。
    低值过滤 = float(低值过滤)
    if 低值过滤 > _低值过滤阈值:
        遮罩数值 = np.where(遮罩数值 < 低值过滤, 0.0, 遮罩数值)

    二值 = 遮罩数值 > _遮罩阈值
    上下文二值 = 上下文数值 > _遮罩阈值 if 上下文数值 is not None else None

    if 遮罩填充:
        二值 = _填充孔洞(二值)
    扩展像素 = max(0, int(遮罩扩展))
    if 扩展像素 > 0:
        二值 = _膨胀遮罩(二值.astype(np.float32), 扩展像素) > 0.5
    if 遮罩反相:
        二值 = ~二值

    # 画面外扩：图像用最外圈像素抻出去（np.pad 的 edge 模式），
    # 新增区域一律记成「要重绘」——否则这块没有内容的画布不会被采样到。
    外扩 = max(0, int(画面外扩))
    if 外扩 > 0:
        图像列表 = [
            np.pad(单图, ((外扩, 外扩), (外扩, 外扩), (0, 0)), mode="edge") for 单图 in 图像列表
        ]
        二值 = np.pad(二值, ((外扩, 外扩), (外扩, 外扩)), mode="constant", constant_values=True)
        if 上下文二值 is not None:
            上下文二值 = np.pad(
                上下文二值, ((外扩, 外扩), (外扩, 外扩)), mode="constant", constant_values=False
            )
    画布左, 画布上 = -外扩, -外扩
    画布宽, 画布高 = 原图宽 + 外扩 * 2, 原图高 + 外扩 * 2

    范围 = _遮罩范围(二值)
    if 上下文二值 is not None:
        上下文范围 = _遮罩范围(上下文二值)
        if 上下文范围 is not None:
            范围 = 上下文范围 if 范围 is None else _外接框合并(范围, 上下文范围)
    if 范围 is None:
        raise ValueError(
            "处理后的遮罩里没有白色区域，裁不出局部。"
            "请检查遮罩来源，或把「遮罩反相」关掉、把「低值过滤」调小后重试。"
        )

    范围 = _按系数外扩(范围, max(1.0, float(上下文扩展)), 画布宽, 画布高)
    遮罩宽, 遮罩高 = max(1, 范围[2] - 范围[0]), max(1, 范围[3] - 范围[1])

    目标宽, 目标高 = _局部重绘目标尺寸(范围, 输出宽度, 输出高度, 尺寸对齐)
    裁剪框 = _居中裁框(范围, 目标宽, 目标高, 画布宽, 画布高)

    裁剪结果 = []
    for 单图 in 图像列表:
        裁剪图 = _裁剪图像(单图, 裁剪框)
        if 裁剪图.shape[:2] != (目标高, 目标宽):
            裁剪图 = _缩放图像(裁剪图, 目标宽, 目标高)
        裁剪结果.append(裁剪图)

    裁剪遮罩 = _裁剪遮罩(二值.astype(np.float32), 裁剪框)
    if 裁剪遮罩.shape != (目标高, 目标宽):
        裁剪遮罩 = _缩放遮罩(裁剪遮罩, 目标宽, 目标高)

    图像批次 = torch.from_numpy(np.stack(裁剪结果).astype(np.float32))
    遮罩批次 = torch.from_numpy(
        np.repeat(裁剪遮罩[None, ...], len(裁剪结果), axis=0).astype(np.float32)
    )

    接缝数据 = {
        "版本": 1,
        "原图宽高": (原图宽, 原图高),
        # 相对原图坐标，可能为负：只有画面外扩时才大于原图
        "画布框": (画布左, 画布上, 画布左 + 画布宽, 画布上 + 画布高),
        "裁剪框": (
            int(裁剪框[0] + 画布左),
            int(裁剪框[1] + 画布上),
            int(裁剪框[2] + 画布左),
            int(裁剪框[3] + 画布上),
        ),
        "裁剪宽高": (目标宽, 目标高),
        "目标宽高": (目标宽, 目标高),
        "缩放宽高": None,
        "填充偏移": None,
        "输出尺寸方式": _输出尺寸_局部重绘,
        "遮罩白色区域宽高": (遮罩宽, 遮罩高),
        "原始图像": 图像张量,
        # 画布坐标，比原图多出外扩的部分；恢复端按「画布框」补偏移
        "原始遮罩": torch.from_numpy(二值.astype(np.float32))[None, ...],
    }
    return 接缝数据, 图像批次, 遮罩批次


# ---------------------------------------------------------------------------
# 按遮罩合并两张图
# ---------------------------------------------------------------------------


def _摆放覆盖图(单图, 背景宽, 背景高, 匹配尺寸):
    """返回 (覆盖图画布, 有效区域)。

    有效区域为 0 的地方不参与混合、保持背景图。原实现居中放置时把覆盖图周围的
    透明区当成黑色一起混了进去，这里用有效区域挡掉。
    """
    高, 宽 = 单图.shape[:2]
    if 匹配尺寸:
        return _缩放图像(单图, 背景宽, 背景高), np.ones((背景高, 背景宽), dtype=np.float32)
    if (宽, 高) == (背景宽, 背景高):
        return 单图, np.ones((背景高, 背景宽), dtype=np.float32)

    画布 = np.zeros((背景高, 背景宽, 3), dtype=np.float32)
    有效 = np.zeros((背景高, 背景宽), dtype=np.float32)
    # 居中放置；比背景大时居中裁掉多出来的部分（不是留左上角）。
    偏移x, 偏移y = (背景宽 - 宽) // 2, (背景高 - 高) // 2
    源x, 源y = max(0, -偏移x), max(0, -偏移y)
    贴x, 贴y = max(0, 偏移x), max(0, 偏移y)
    贴宽 = min(宽 - 源x, 背景宽 - 贴x)
    贴高 = min(高 - 源y, 背景高 - 贴y)
    if 贴宽 > 0 and 贴高 > 0:
        画布[贴y : 贴y + 贴高, 贴x : 贴x + 贴宽] = 单图[源y : 源y + 贴高, 源x : 源x + 贴宽]
        有效[贴y : 贴y + 贴高, 贴x : 贴x + 贴宽] = 1.0
    return 画布, 有效


def _执行图像合并(背景图, 覆盖图, 遮罩, 透明度, 遮罩扩展, 模糊半径, 匹配尺寸):
    背景列表, _ = _图像数组(背景图, "背景图")
    覆盖列表, _ = _图像数组(覆盖图, "覆盖图")
    背景高, 背景宽 = 背景列表[0].shape[:2]
    强度 = float(np.clip(float(透明度), 0.0, 1.0))

    if 遮罩 is None:
        # 没接遮罩：整张图按透明度叠加，扩展与羽化对全白遮罩本来就没有效果。
        权重底 = np.full((背景高, 背景宽), 强度, dtype=np.float32)
    else:
        权重底 = _遮罩数组(遮罩)
        if 权重底.shape != (背景高, 背景宽):
            raise ValueError(
                f"遮罩尺寸 {权重底.shape[1]}x{权重底.shape[0]} 与背景图尺寸 {背景宽}x{背景高} 不一致，"
                "请让遮罩与背景图同尺寸（可先把遮罩来源图缩放到同一尺寸）。"
            )
        半径 = int(遮罩扩展)
        if 半径 > 0:
            权重底 = _膨胀遮罩(权重底, 半径)
        elif 半径 < 0:
            # 腐蚀 = 反相后膨胀再反相，省掉再写一套最小池化。
            权重底 = 1.0 - _膨胀遮罩(1.0 - 权重底, -半径)
        权重底 = np.clip(_高斯羽化(权重底, int(模糊半径)), 0.0, 1.0) * 强度

    数量 = max(len(背景列表), len(覆盖列表))
    if len(背景列表) not in (1, 数量) or len(覆盖列表) not in (1, 数量):
        raise ValueError(
            f"背景图 {len(背景列表)} 张、覆盖图 {len(覆盖列表)} 张，张数对不上。"
            "请让两边张数相同，或其中一边只有 1 张。"
        )

    结果列表 = []
    for 下标 in range(数量):
        背景 = 背景列表[0 if len(背景列表) == 1 else 下标]
        覆盖, 有效 = _摆放覆盖图(
            覆盖列表[0 if len(覆盖列表) == 1 else 下标], 背景宽, 背景高, bool(匹配尺寸)
        )
        权重 = (权重底 * 有效)[..., None]
        结果列表.append(背景 * (1.0 - 权重) + 覆盖 * 权重)

    return torch.from_numpy(np.stack(结果列表).astype(np.float32))


# ---------------------------------------------------------------------------
# 节点
# ---------------------------------------------------------------------------


class GG遮罩裁剪:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "遮罩": ("MASK",),
                "遮罩填充": ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"}),
                "扩展方式": ([_扩展方式_统一, _扩展方式_分别], {"default": _扩展方式_统一}),
                "输出尺寸": (list(_输出尺寸选项), {"default": _输出尺寸_原像素}),
            },
            # 两个方式选择器的子参数在这里平铺：legacy 前端没有 DynamicCombo，
            # 只能全量声明，实际取哪些由选择器决定（与 GG Latent 的 legacy 写法一致）。
            "optional": {
                "扩展系数": ("FLOAT", {"default": 1.4, "min": 1.0, "max": 3.0, "step": 0.1}),
                "扩展系数上": ("FLOAT", {"default": 1.4, "min": 1.0, "max": 3.0, "step": 0.1}),
                "扩展系数下": ("FLOAT", {"default": 1.4, "min": 1.0, "max": 3.0, "step": 0.1}),
                "扩展系数左": ("FLOAT", {"default": 1.4, "min": 1.0, "max": 3.0, "step": 0.1}),
                "扩展系数右": ("FLOAT", {"default": 1.4, "min": 1.0, "max": 3.0, "step": 0.1}),
                "倍数取整": ("INT", {"default": 8, "min": 0, "max": 256, "step": 1}),
                "宽高比例": (IMAGE_ASPECT_RATIOS, {"default": "16:9"}),
                "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "边长类型": (SIDE_TYPES, {"default": "最长边"}),
                "画面方向": (ORIENTATION_TYPES, {"default": "横屏"}),
                "分辨率": (RESOLUTION_OPTIONS, {"default": "1K"}),
                "宽度": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "高度": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
            },
        }

    RETURN_TYPES = (SEAM_TYPE, "IMAGE", "MASK")
    RETURN_NAMES = ("接缝", "裁剪图像", "裁剪遮罩")
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像"

    def execute(self, 图像, 遮罩, 遮罩填充=False, 扩展方式=None, 输出尺寸=None, **kwargs):
        扩展量, 尺寸方式, 配置 = _拆裁剪参数(扩展方式, 输出尺寸, kwargs)
        return _执行遮罩裁剪(图像, 遮罩, bool(遮罩填充), 扩展量, 尺寸方式, 配置)


class GG裁剪恢复:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "接缝": (SEAM_TYPE,),
                "裁剪图像": ("IMAGE",),
                "遮罩扩展": ("INT", {"default": 5, "min": 0, "max": 30, "step": 1}),
                "遮罩羽化": ("INT", {"default": 5, "min": 0, "max": 30, "step": 1}),
                "颜色还原": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
            },
            "optional": {
                "裁剪遮罩": ("MASK",),
                "背景图像": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像"

    def execute(self, 接缝, 裁剪图像, 遮罩扩展=5, 遮罩羽化=5, 颜色还原=1.0, 裁剪遮罩=None, 背景图像=None):
        return (
            _执行裁剪恢复(接缝, 裁剪图像, 裁剪遮罩, 背景图像, 遮罩扩展, 遮罩羽化, 颜色还原),
        )


class GG图像合并遮罩:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "背景图": ("IMAGE",),
                "覆盖图": ("IMAGE",),
                "透明度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "遮罩扩展": ("INT", {"default": 0, "min": -100, "max": 100, "step": 1}),
                "模糊半径": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "匹配图像大小": ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"}),
            },
            "optional": {
                "遮罩": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像"

    def execute(self, 背景图, 覆盖图, 透明度=1.0, 遮罩扩展=0, 模糊半径=0,
                匹配图像大小=False, 遮罩=None):
        return (
            _执行图像合并(背景图, 覆盖图, 遮罩, 透明度, 遮罩扩展, 模糊半径, 匹配图像大小),
        )


class GG局部重绘裁剪:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "遮罩": ("MASK",),
                "遮罩填充": ("BOOLEAN", {"default": True, "label_on": "开启", "label_off": "关闭"}),
                "遮罩反相": ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"}),
                "遮罩扩展": ("INT", {"default": 0, "min": 0, "max": 512, "step": 1}),
                "低值过滤": ("FLOAT", {"default": 0.1, "min": 0.0, "max": 1.0, "step": 0.01}),
                "上下文扩展": ("FLOAT", {"default": 1.2, "min": 1.0, "max": 4.0, "step": 0.05}),
                "画面外扩": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 8}),
                "输出宽度": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 8}),
                "输出高度": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 8}),
                "尺寸对齐": ("INT", {"default": 8, "min": 1, "max": 64, "step": 1}),
            },
            "optional": {
                "上下文遮罩": ("MASK",),
            },
        }

    RETURN_TYPES = (SEAM_TYPE, "IMAGE", "MASK")
    RETURN_NAMES = ("接缝", "裁剪图像", "裁剪遮罩")
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像"

    def execute(self, 图像, 遮罩, 遮罩填充=True, 遮罩反相=False, 遮罩扩展=0, 低值过滤=0.1,
                上下文扩展=1.2, 画面外扩=0, 输出宽度=0, 输出高度=0, 尺寸对齐=8, 上下文遮罩=None):
        return _执行局部重绘裁剪(
            图像, 遮罩, 上下文遮罩, 遮罩填充, 遮罩反相, 遮罩扩展, 低值过滤,
            上下文扩展, 画面外扩, 输出宽度, 输出高度, 尺寸对齐,
        )


if io is not None:

    class GG遮罩裁剪_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGMaskCrop",
                display_name="GG 遮罩裁剪",
                category="GuliNodes/图像",
                description=(
                    "按遮罩的白色范围裁出局部区域，四边可按各自系数扩展；"
                    "输出尺寸支持原像素、原像素1:1、按边长、按K数分辨率、按宽高；"
                    "同时输出「接缝」，交给「GG 裁剪恢复」把处理后的结果贴回原图。"
                ),
                inputs=[
                    io.Image.Input("图像", tooltip="要裁剪的图像；多张时按同一块区域逐张裁剪。"),
                    io.Mask.Input("遮罩", tooltip="决定裁剪范围，尺寸需与图像一致。"),
                    io.Boolean.Input(
                        "遮罩填充",
                        default=False,
                        label_on="开启",
                        label_off="关闭",
                        tooltip="先把遮罩内部被围住的空洞补实，再按补实后的整体范围裁剪。",
                    ),
                    io.DynamicCombo.Input(
                        "扩展方式",
                        options=[
                            io.DynamicCombo.Option(
                                key=_扩展方式_统一,
                                inputs=[
                                    io.Float.Input(
                                        "扩展系数",
                                        default=1.4,
                                        min=1.0,
                                        max=3.0,
                                        step=0.1,
                                        tooltip="四边按同一个系数向外扩展；1.0 表示紧贴遮罩范围。",
                                    ),
                                ],
                            ),
                            io.DynamicCombo.Option(
                                key=_扩展方式_分别,
                                inputs=[
                                    io.Float.Input("扩展系数上", default=1.4, min=1.0, max=3.0, step=0.1),
                                    io.Float.Input("扩展系数下", default=1.4, min=1.0, max=3.0, step=0.1),
                                    io.Float.Input("扩展系数左", default=1.4, min=1.0, max=3.0, step=0.1),
                                    io.Float.Input("扩展系数右", default=1.4, min=1.0, max=3.0, step=0.1),
                                ],
                            ),
                        ],
                        tooltip="扩展量按遮罩最短边乘以（系数 - 1）计算，并限制在原图范围内。",
                    ),
                    io.DynamicCombo.Input(
                        "输出尺寸",
                        options=[
                            io.DynamicCombo.Option(
                                key=_输出尺寸_原像素,
                                inputs=[
                                    io.Int.Input(
                                        "倍数取整",
                                        default=8,
                                        min=0,
                                        max=256,
                                        step=1,
                                        tooltip="裁剪宽高向上取到该倍数（0 或 1 表示不取整）：宁可多带一圈边缘，也不裁掉遮罩像素。",
                                    ),
                                ],
                            ),
                            io.DynamicCombo.Option(
                                key=_输出尺寸_正方,
                                inputs=[
                                    io.Int.Input(
                                        "倍数取整",
                                        default=8,
                                        min=0,
                                        max=256,
                                        step=1,
                                        tooltip="正方形边长向上取到该倍数（0 或 1 表示不取整）。",
                                    ),
                                ],
                            ),
                            io.DynamicCombo.Option(
                                key=_输出尺寸_按边长,
                                inputs=[
                                    io.Combo.Input("宽高比例", options=IMAGE_ASPECT_RATIOS, default="16:9"),
                                    io.Int.Input(
                                        "边长",
                                        default=1024,
                                        min=64,
                                        max=8192,
                                        step=8,
                                        tooltip="按「边长类型」理解为最长边或最短边，另一边由宽高比例推出。",
                                    ),
                                    io.Combo.Input("边长类型", options=SIDE_TYPES, default="最长边"),
                                    io.Combo.Input("画面方向", options=ORIENTATION_TYPES, default="横屏"),
                                ],
                            ),
                            io.DynamicCombo.Option(
                                key=_输出尺寸_按K数,
                                inputs=[
                                    io.Combo.Input("宽高比例", options=LATENT_ASPECT_RATIOS, default="9:16"),
                                    io.Combo.Input("画面方向", options=ORIENTATION_TYPES, default="横屏"),
                                    io.Combo.Input("分辨率", options=RESOLUTION_OPTIONS, default="1K"),
                                ],
                            ),
                            io.DynamicCombo.Option(
                                key=_输出尺寸_按宽高,
                                inputs=[
                                    io.Int.Input(
                                        "宽度",
                                        default=1024,
                                        min=64,
                                        max=8192,
                                        step=8,
                                        tooltip="直接给像素宽度，可接入「GG 图像宽高」的宽度输出；不是 8 的倍数时向下对齐。",
                                    ),
                                    io.Int.Input(
                                        "高度",
                                        default=1024,
                                        min=64,
                                        max=8192,
                                        step=8,
                                        tooltip="直接给像素高度，可接入「GG 图像宽高」的高度输出；不是 8 的倍数时向下对齐。",
                                    ),
                                ],
                            ),
                        ],
                        tooltip=(
                            "决定「裁剪图像」和「裁剪遮罩」的最终宽高，两者始终同尺寸；"
                            "原像素保持遮罩范围，原像素1:1 取最小外接正方形，"
                            "按边长 / 按K数分辨率 / 按宽高 按比例配置算出目标尺寸后等比缩放并居中补边。"
                            "接缝不带画面，只记录裁剪框与目标宽高供恢复端还原。"
                        ),
                    ),
                ],
                outputs=[
                    _接缝类型.Output(display_name="接缝"),
                    io.Image.Output(display_name="裁剪图像"),
                    io.Mask.Output(display_name="裁剪遮罩"),
                ],
            )

        @classmethod
        def execute(cls, 图像, 遮罩, 遮罩填充=False, 扩展方式=None, 输出尺寸=None, **kwargs):
            扩展量, 尺寸方式, 配置 = _拆裁剪参数(扩展方式, 输出尺寸, kwargs)
            return io.NodeOutput(
                *_执行遮罩裁剪(图像, 遮罩, bool(遮罩填充), 扩展量, 尺寸方式, 配置)
            )

    GG遮罩裁剪 = GG遮罩裁剪_V3

    class GG裁剪恢复_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGCropRestore",
                display_name="GG 裁剪恢复",
                category="GuliNodes/图像",
                description=(
                    "把「GG 遮罩裁剪」裁出的局部结果按接缝记录的位置缩放贴回原图，"
                    "边缘按百分比扩展与羽化，贴回处不会留下硬边。"
                ),
                inputs=[
                    _接缝类型.Input("接缝", tooltip="来自「GG 遮罩裁剪」的「接缝」输出。"),
                    io.Image.Input("裁剪图像", tooltip="处理后的局部图像，会自动缩放回裁剪尺寸。"),
                    io.Int.Input(
                        "遮罩扩展",
                        default=5,
                        min=0,
                        max=30,
                        step=1,
                        tooltip="按遮罩范围的百分比向外扩展贴回范围，盖住重绘边缘的接缝。",
                    ),
                    io.Int.Input(
                        "遮罩羽化",
                        default=5,
                        min=0,
                        max=30,
                        step=1,
                        tooltip="按遮罩范围的百分比羽化贴回边缘，数值越大过渡越柔和。",
                    ),
                    io.Float.Input(
                        "颜色还原",
                        default=1.0,
                        min=0.0,
                        max=1.0,
                        step=0.05,
                        tooltip="用同位置未改动的像素估算整体偏色并修正贴回区域；0 为关闭。",
                    ),
                    io.Mask.Input(
                        "裁剪遮罩",
                        optional=True,
                        tooltip="处理后的遮罩；不接时使用裁剪时保存的遮罩。",
                    ),
                    io.Image.Input(
                        "背景图像",
                        optional=True,
                        tooltip="贴回的目标图，需与原图同尺寸；不接时使用裁剪时保存的原图。",
                    ),
                ],
                outputs=[io.Image.Output(display_name="图像")],
            )

        @classmethod
        def execute(cls, 接缝, 裁剪图像, 遮罩扩展=5, 遮罩羽化=5, 颜色还原=1.0, 裁剪遮罩=None, 背景图像=None):
            return io.NodeOutput(
                _执行裁剪恢复(接缝, 裁剪图像, 裁剪遮罩, 背景图像, 遮罩扩展, 遮罩羽化, 颜色还原)
            )

    GG裁剪恢复 = GG裁剪恢复_V3

    class GG图像合并遮罩_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGImageMergeMask",
                display_name="GG 图像合并（遮罩）",
                category="GuliNodes/图像",
                description=(
                    "按遮罩把覆盖图混到背景图上：遮罩可先扩展或羽化，覆盖图可缩放到背景尺寸或居中放置，"
                    "整体强度由透明度控制。不接遮罩时按透明度整图叠加。"
                ),
                inputs=[
                    io.Image.Input("背景图", tooltip="底图，输出尺寸与它一致。"),
                    io.Image.Input(
                        "覆盖图",
                        tooltip="叠在上面的图；张数与背景图不同时，只有 1 张的那边会自动复用。",
                    ),
                    io.Mask.Input(
                        "遮罩",
                        optional=True,
                        tooltip="决定哪些地方用覆盖图；不接时整张图按透明度叠加。多张遮罩只用第一张。",
                    ),
                    io.Float.Input(
                        "透明度",
                        default=1.0,
                        min=0.0,
                        max=1.0,
                        step=0.01,
                        tooltip="整体强度：0 等于完全保留背景图，1 等于完全按遮罩覆盖。",
                    ),
                    io.Int.Input(
                        "遮罩扩展",
                        default=0,
                        min=-100,
                        max=100,
                        step=1,
                        tooltip="正数向外扩展（膨胀）遮罩，负数向内收缩（腐蚀）；不接遮罩时无效。",
                    ),
                    io.Int.Input(
                        "模糊半径",
                        default=0,
                        min=0,
                        max=100,
                        step=1,
                        tooltip="遮罩边缘羽化半径，单位像素，数值越大过渡越柔和；不接遮罩时无效。",
                    ),
                    io.Boolean.Input(
                        "匹配图像大小",
                        default=False,
                        label_on="开启",
                        label_off="关闭",
                        tooltip="开启时把覆盖图缩放到背景尺寸；关闭时按原尺寸居中放置，比背景大的部分居中裁掉。",
                    ),
                ],
                outputs=[io.Image.Output(display_name="图像")],
            )

        @classmethod
        def execute(cls, 背景图, 覆盖图, 透明度=1.0, 遮罩扩展=0, 模糊半径=0,
                    匹配图像大小=False, 遮罩=None):
            return io.NodeOutput(
                _执行图像合并(背景图, 覆盖图, 遮罩, 透明度, 遮罩扩展, 模糊半径, 匹配图像大小)
            )

    GG图像合并遮罩 = GG图像合并遮罩_V3

    class GG局部重绘裁剪_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGInpaintCrop",
                display_name="GG 局部重绘裁剪",
                category="GuliNodes/图像",
                description=(
                    "按遮罩裁出重绘区域并带上足够的上下文：裁之前可对遮罩做低值过滤 / 补洞 / 膨胀 / 反相，"
                    "四边按宽高各自的比例取上下文，可外扩画布做 outpainting，可强制采样尺寸。"
                    "输出「接缝」交给「GG 裁剪恢复」把采样结果贴回原图。"
                ),
                inputs=[
                    io.Image.Input("图像", tooltip="原图；多张时按同一块区域逐张裁剪。"),
                    io.Mask.Input("遮罩", tooltip="要重绘的区域，尺寸需与图像一致。"),
                    io.Boolean.Input(
                        "遮罩填充",
                        default=True,
                        label_on="开启",
                        label_off="关闭",
                        tooltip="把遮罩内部被围住的空洞补实，避免重绘区中间留下没被采样到的洞。",
                    ),
                    io.Boolean.Input(
                        "遮罩反相",
                        default=False,
                        label_on="开启",
                        label_off="关闭",
                        tooltip="取反后再裁：适合「保留遮罩内的东西、重绘周围」的用法。",
                    ),
                    io.Int.Input(
                        "遮罩扩展",
                        default=0,
                        min=0,
                        max=512,
                        step=1,
                        tooltip="按像素向外膨胀遮罩，让重绘范围盖住原遮罩边缘的过渡带；0 为不扩。",
                    ),
                    io.Float.Input(
                        "低值过滤",
                        default=0.1,
                        min=0.0,
                        max=1.0,
                        step=0.01,
                        tooltip="低于该值的遮罩灰度直接清零，滤掉羽化残留的浅灰边；0 为不过滤。",
                    ),
                    io.Float.Input(
                        "上下文扩展",
                        default=1.2,
                        min=1.0,
                        max=4.0,
                        step=0.05,
                        tooltip="宽、高各自按（系数 - 1）/ 2 向两边带上下文；1.0 表示紧贴遮罩范围。",
                    ),
                    io.Int.Input(
                        "画面外扩",
                        default=0,
                        min=0,
                        max=2048,
                        step=8,
                        tooltip="四边各扩出这么多像素的新画布做 outpainting，新区域用最外圈像素延展并标记为重绘；0 为不扩。",
                    ),
                    io.Int.Input(
                        "输出宽度",
                        default=0,
                        min=0,
                        max=8192,
                        step=8,
                        tooltip="强制采样宽度；和「输出高度」一起为 0 时按上下文本身大小输出（只做对齐）。",
                    ),
                    io.Int.Input(
                        "输出高度",
                        default=0,
                        min=0,
                        max=8192,
                        step=8,
                        tooltip="强制采样高度；和「输出宽度」一起为 0 时按上下文本身大小输出（只做对齐）。",
                    ),
                    io.Int.Input(
                        "尺寸对齐",
                        default=8,
                        min=1,
                        max=64,
                        step=1,
                        tooltip="目标宽高向上取到该倍数，保证能被 VAE 的 8 倍下采样整除。",
                    ),
                    io.Mask.Input(
                        "上下文遮罩",
                        optional=True,
                        tooltip="额外要求保留进画面的区域；它的范围会和遮罩范围取并集。",
                    ),
                ],
                outputs=[
                    _接缝类型.Output(display_name="接缝"),
                    io.Image.Output(display_name="裁剪图像"),
                    io.Mask.Output(display_name="裁剪遮罩"),
                ],
            )

        @classmethod
        def execute(cls, 图像, 遮罩, 遮罩填充=True, 遮罩反相=False, 遮罩扩展=0, 低值过滤=0.1,
                    上下文扩展=1.2, 画面外扩=0, 输出宽度=0, 输出高度=0, 尺寸对齐=8, 上下文遮罩=None):
            return io.NodeOutput(
                *_执行局部重绘裁剪(
                    图像, 遮罩, 上下文遮罩, 遮罩填充, 遮罩反相, 遮罩扩展, 低值过滤,
                    上下文扩展, 画面外扩, 输出宽度, 输出高度, 尺寸对齐,
                )
            )

    GG局部重绘裁剪 = GG局部重绘裁剪_V3


NODE_CLASS_MAPPINGS = {
    "GGMaskCrop": GG遮罩裁剪,
    "GGCropRestore": GG裁剪恢复,
    "GGImageMergeMask": GG图像合并遮罩,
    "GGInpaintCrop": GG局部重绘裁剪,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGMaskCrop": "GG 遮罩裁剪",
    "GGCropRestore": "GG 裁剪恢复",
    "GGImageMergeMask": "GG 图像合并（遮罩）",
    "GGInpaintCrop": "GG 局部重绘裁剪",
}
