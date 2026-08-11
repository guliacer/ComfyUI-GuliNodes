import ast
import math
import numbers
import operator
from typing import Any


class GGNumber(float):
    def __new__(cls, value: float):
        return float.__new__(cls, value)

    def __index__(self):
        return int(self)

    def __add__(self, other):
        return GGNumber(float(self) + float(other))

    def __radd__(self, other):
        return GGNumber(float(other) + float(self))

    def __sub__(self, other):
        return GGNumber(float(self) - float(other))

    def __rsub__(self, other):
        return GGNumber(float(other) - float(self))


class GGAnyType(str):
    def __ne__(self, other):
        return False


GG_ANY_TYPE = GGAnyType("*")


_BINARY_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}

_UNARY_OPERATORS = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
    ast.Not: operator.not_,
}

_COMPARE_OPERATORS = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
}

_MATH_FUNCTIONS = {
    "abs": abs,
    "min": min,
    "max": max,
    "round": round,
    "sum": sum,
    "len": len,
    "floor": math.floor,
    "ceil": math.ceil,
    "sqrt": math.sqrt,
    "pow": pow,
}

_MATH_CONSTANTS = {
    "pi": math.pi,
    "e": math.e,
    "tau": math.tau,
}


def _clamp(数值, 最小值, 最大值):
    return max(最小值, min(最大值, 数值))


_MATH_FUNCTIONS["clamp"] = _clamp


def _shape_to_list(值: Any):
    形状 = getattr(值, "shape", None)
    if 形状 is None:
        return None
    if len(形状) == 0 and hasattr(值, "item"):
        return float(值.item())
    return [int(尺寸) for 尺寸 in 形状]


def _normalize_math_input(名称: str, 值: Any):
    if 值 is None:
        return 0.0
    if isinstance(值, bool):
        return int(值)
    if isinstance(值, numbers.Real):
        return float(值)
    if isinstance(值, str):
        文本 = 值.strip()
        if not 文本:
            return 0.0
        try:
            return float(文本)
        except ValueError as exc:
            raise ValueError(f"变量 {名称} 的文本值无法转为数字：{值}") from exc
    if isinstance(值, dict) and hasattr(值.get("samples"), "shape"):
        return _shape_to_list(值["samples"])

    形状值 = _shape_to_list(值)
    if 形状值 is not None:
        return 形状值
    if isinstance(值, (list, tuple)):
        return [_normalize_math_input(f"{名称}[{索引}]", 子值) for 索引, 子值 in enumerate(值)]

    try:
        return float(值)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"变量 {名称} 不是可计算的数值或形状列表。") from exc


class _SafeMathEvaluator:
    def __init__(self, 变量: dict[str, Any]):
        self.变量 = 变量

    def evaluate(self, 表达式: str) -> float:
        文本 = str(表达式 or "").strip()
        if not 文本:
            return 0.0
        if len(文本) > 512:
            raise ValueError("表达式过长，请控制在 512 个字符以内。")
        try:
            节点 = ast.parse(文本, mode="eval").body
        except SyntaxError as exc:
            raise ValueError(f"表达式语法错误：{文本}") from exc

        结果 = self._eval(节点)
        return self._to_float(结果, 文本)

    def _eval(self, 节点):
        if isinstance(节点, ast.Constant):
            if isinstance(节点.value, bool):
                return int(节点.value)
            if isinstance(节点.value, numbers.Real):
                return float(节点.value)
            raise ValueError("表达式只能包含数字、变量和受支持的函数。")

        if isinstance(节点, ast.Name):
            if 节点.id in self.变量:
                return self.变量[节点.id]
            if 节点.id in _MATH_CONSTANTS:
                return _MATH_CONSTANTS[节点.id]
            raise ValueError(f"未知变量：{节点.id}。可用变量为 a、b、c、d。")

        if isinstance(节点, ast.BinOp):
            操作 = _BINARY_OPERATORS.get(type(节点.op))
            if 操作 is None:
                raise ValueError("不支持的运算符。")
            左值 = self._eval(节点.left)
            右值 = self._eval(节点.right)
            if isinstance(节点.op, ast.Pow) and abs(float(右值)) > 1000:
                raise ValueError("指数过大，请使用较小的幂运算。")
            return 操作(左值, 右值)

        if isinstance(节点, ast.UnaryOp):
            操作 = _UNARY_OPERATORS.get(type(节点.op))
            if 操作 is None:
                raise ValueError("不支持的一元运算符。")
            return 操作(self._eval(节点.operand))

        if isinstance(节点, ast.BoolOp):
            值列表 = [bool(self._eval(子节点)) for 子节点 in 节点.values]
            if isinstance(节点.op, ast.And):
                return int(all(值列表))
            if isinstance(节点.op, ast.Or):
                return int(any(值列表))
            raise ValueError("不支持的布尔运算。")

        if isinstance(节点, ast.Compare):
            左值 = self._eval(节点.left)
            for 操作节点, 右节点 in zip(节点.ops, 节点.comparators):
                操作 = _COMPARE_OPERATORS.get(type(操作节点))
                if 操作 is None:
                    raise ValueError("不支持的比较运算符。")
                右值 = self._eval(右节点)
                if not 操作(左值, 右值):
                    return 0
                左值 = 右值
            return 1

        if isinstance(节点, ast.Call):
            if not isinstance(节点.func, ast.Name):
                raise ValueError("只支持直接调用白名单函数。")
            函数 = _MATH_FUNCTIONS.get(节点.func.id)
            if 函数 is None:
                raise ValueError(f"不支持的函数：{节点.func.id}。")
            if 节点.keywords:
                raise ValueError("函数暂不支持关键字参数。")
            参数 = [self._eval(参数节点) for 参数节点 in 节点.args]
            return 函数(*参数)

        if isinstance(节点, ast.Subscript):
            值 = self._eval(节点.value)
            索引 = self._eval_slice(节点.slice)
            return 值[索引]

        if isinstance(节点, ast.List):
            return [self._eval(子节点) for 子节点 in 节点.elts]

        if isinstance(节点, ast.Tuple):
            return tuple(self._eval(子节点) for 子节点 in 节点.elts)

        raise ValueError("表达式包含不支持的语法。")

    def _eval_slice(self, 节点):
        if isinstance(节点, ast.Slice):
            起点 = self._eval(节点.lower) if 节点.lower is not None else None
            终点 = self._eval(节点.upper) if 节点.upper is not None else None
            步长 = self._eval(节点.step) if 节点.step is not None else None
            return slice(_to_index(起点), _to_index(终点), _to_index(步长))
        return _to_index(self._eval(节点))

    @staticmethod
    def _to_float(结果, 表达式: str) -> float:
        if isinstance(结果, bool):
            数值 = float(int(结果))
        elif isinstance(结果, numbers.Real):
            数值 = float(结果)
        else:
            try:
                数值 = float(结果)
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    f"表达式 `{表达式}` 的结果不是单个数值；"
                    "如果输入是图像或 Latent 形状，请使用 a[0]、a[1] 这类索引。"
                ) from exc

        if math.isnan(数值):
            return 0.0
        if not math.isfinite(数值):
            raise ValueError("计算结果不是有限数值，请检查除零或溢出。")
        return 数值


def _to_index(值):
    if 值 is None:
        return None
    return int(值)


def _evaluate_math_pair(表达式: str, 变量: dict[str, Any]):
    浮点 = _SafeMathEvaluator(变量).evaluate(表达式)
    return int(round(浮点)), GGNumber(round(浮点, 10))


class GGSimpleMath:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "a": (GG_ANY_TYPE, {"forceInput": True}),
                "b": (GG_ANY_TYPE, {"forceInput": True}),
                "c": (GG_ANY_TYPE, {"forceInput": True}),
                "d": (GG_ANY_TYPE, {"forceInput": True}),
            },
            "required": {
                "表达式_1": (
                    "STRING",
                    {
                        "default": "a*c/d",
                        "multiline": False,
                        "tooltip": "第一组计算表达式，可使用 a、b、c、d 和 + - * / // % ** 等简单运算。",
                    },
                ),
                "表达式_2": (
                    "STRING",
                    {
                        "default": "b*c/d",
                        "multiline": False,
                        "tooltip": "第二组计算表达式。示例：round(a/8)*8、max(a,b)、a[1]。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("INT", "FLOAT", "INT", "FLOAT")
    RETURN_NAMES = ("整数_1", "浮点_1", "整数_2", "浮点_2")
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/输入"
    DESCRIPTION = (
        "使用 a、b、c、d 四个输入进行简单数学计算，分别输出两条表达式的整数和浮点结果。"
    )

    def execute(
        self,
        表达式_1: str = "a*c/d",
        表达式_2: str = "b*c/d",
        a: Any = 0.0,
        b: Any = 0.0,
        c: Any = 0.0,
        d: Any = 1.0,
    ):
        变量 = {
            "a": _normalize_math_input("a", a),
            "b": _normalize_math_input("b", b),
            "c": _normalize_math_input("c", c),
            "d": _normalize_math_input("d", d),
        }
        整数_1, 浮点_1 = _evaluate_math_pair(表达式_1, 变量)
        整数_2, 浮点_2 = _evaluate_math_pair(表达式_2, 变量)
        return (整数_1, 浮点_1, 整数_2, 浮点_2)

    @classmethod
    def IS_CHANGED(cls, 表达式_1: str = "a*c/d", 表达式_2: str = "b*c/d", **kwargs):
        变量 = tuple(
            (名称, repr(_normalize_math_input(名称, 值)))
            for 名称, 值 in sorted(kwargs.items())
            if 名称 in {"a", "b", "c", "d"}
        )
        return (表达式_1, 表达式_2, 变量)


NODE_CLASS_MAPPINGS = {
    "GGSimpleMath": GGSimpleMath,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGSimpleMath": "GG 简单数学",
}
