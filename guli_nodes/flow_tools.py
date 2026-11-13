"""分支选择：多路输入里只执行选中的那一路，其余分支靠惰性求值直接跳过。"""

try:
    from comfy_api.latest import io
except Exception:
    io = None

_NODE_ID = "GGSwitchBranch"
_DISPLAY_NAME = "GG 选择"
_CATEGORY = "GuliNodes/工作流"
# 输入按连线自动新增（Autogrow），这里只是上限与下拉可选项。
_输入数量 = 20
_输入选项 = tuple(f"输入{i}" for i in range(1, _输入数量 + 1))
_默认输入 = _输入选项[0]
# 老前端没有 Autogrow，退化成一屏固定槽位。
_V1输入数量 = 8
_V1输入选项 = _输入选项[:_V1输入数量]


def _校验选择(生效输入, 可选项=_输入选项):
    if 生效输入 not in 可选项:
        raise ValueError(
            f"生效输入「{生效输入}」无效，请选择 {'、'.join(可选项)} 中的一个。"
        )


def _已连接列表(已传输入, 可选项):
    return [名称 for 名称 in 可选项 if 已传输入.get(名称) is not None]


def _懒加载请求(生效输入, 已传输入, 懒键前缀="", 可选项=_输入选项):
    """只向执行器请求选中的那一路；其它输入保持未求值，对应分支不会执行。

    Autogrow 的惰性求值会把每组值包成 (值, 键)，无法据此判断是否已求值，
    因此固定请求选中项；执行器会自动过滤掉已经求值完的输入。
    """
    _校验选择(生效输入, 可选项)
    if 生效输入 not in 已传输入:
        已连接 = _已连接列表(已传输入, 可选项)
        提示 = f"当前已连接：{'、'.join(已连接)}。" if 已连接 else "当前没有任何输入连线。"
        raise ValueError(f"生效输入「{生效输入}」没有连接输入源，{提示}请先连线或改选已连接的输入。")
    return [f"{懒键前缀}{生效输入}"]


def _取选中值(生效输入, 已传输入, 可选项=_输入选项):
    _校验选择(生效输入, 可选项)
    if 生效输入 not in 已传输入:
        raise ValueError(
            f"生效输入「{生效输入}」没有拿到输入值，请确认该路已经连线且上游能正常执行。"
        )
    return 已传输入[生效输入]


def _分支键(生效输入, 分组):
    """把下拉里选中的分支名换算成 Autogrow 子输入名（下拉只列已连线的分支）。"""
    分组 = 分组 or {}
    顺序 = [名称 for 名称 in _输入选项 if 名称 in 分组]
    if not 顺序:
        raise ValueError("还没有任何输入连线：请先把要选择的分支接到节点上。")
    选择 = 生效输入 or 顺序[0]
    if 选择 not in 分组:
        raise ValueError(
            f"生效输入「{生效输入}」不在已连接的分支里，当前可选：{'、'.join(顺序)}。"
        )
    return 选择


class GG选择_V1:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "生效输入": (list(_V1输入选项), {"default": _默认输入}),
            },
            "optional": {名称: ("*", {"lazy": True}) for 名称 in _V1输入选项},
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("输出",)
    FUNCTION = "execute"
    CATEGORY = _CATEGORY

    def check_lazy_status(self, 生效输入, **kwargs):
        return _懒加载请求(生效输入, kwargs, 可选项=_V1输入选项)

    def execute(self, 生效输入, **kwargs):
        return (_取选中值(生效输入, kwargs, _V1输入选项),)


if io is not None:

    class GG选择_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            # 与官方 If/Else Switch 同一套 MatchType：先接上的那路决定类型，
            # 其它输入和输出自动跟着适配；输入用 Autogrow 按连线自动新增。
            类型模板 = io.MatchType.Template(f"{_NODE_ID}_branch")
            输入模板 = io.Autogrow.TemplateNames(
                input=io.MatchType.Input("输入", template=类型模板, optional=True, lazy=True),
                names=list(_输入选项),
                min=1,
            )
            return io.Schema(
                node_id=_NODE_ID,
                display_name=_DISPLAY_NAME,
                category=_CATEGORY,
                description=(
                    "把多路输入接到同一个节点，只执行「生效输入」选中的那一路并原样输出；"
                    "其余输入不会被求值，对应分支直接跳过，适合替代真假两条流程都会跑完的 if 节点。"
                    "输入按连线自动新增（默认 1 路，最多 20 路），类型跟随最先连接的那一路自动适配。"
                ),
                inputs=[
                    # 组名必须是 autogrow：官方前端的分支选择控件按这个前缀筛已连线输入。
                    io.Autogrow.Input("autogrow", template=输入模板),
                    io.String.Input(
                        "生效输入",
                        extra_dict={"widgetType": "COMFY_BRANCH_SELECTOR"},
                        tooltip="下拉里只列出已经连线的分支；选中哪一路就只执行哪一路。",
                    ),
                ],
                outputs=[io.MatchType.Output(template=类型模板, display_name="输出")],
            )

        @classmethod
        def check_lazy_status(cls, 生效输入, autogrow=None):
            键 = _分支键(生效输入, autogrow)
            return [f"autogrow.{键}"]

        @classmethod
        def execute(cls, 生效输入, autogrow=None):
            键 = _分支键(生效输入, autogrow)
            return io.NodeOutput((autogrow or {})[键])

    GG选择 = GG选择_V3
else:
    GG选择 = GG选择_V1


NODE_CLASS_MAPPINGS = {
    _NODE_ID: GG选择,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    _NODE_ID: _DISPLAY_NAME,
}
