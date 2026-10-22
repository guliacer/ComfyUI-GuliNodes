class GGGroupControllerM:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "GuliNodes/工作流"
    DESCRIPTION = "选择要控制的工作流编组后批量跳过或启用。点击「选择组」勾选编组，点击编组名可跳转。"

    def run(self) -> dict:
        return {}


class GGGroupControllerS:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "启用": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "编组启用状态，可由 GG 选项确认连接控制。",
                }),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "GuliNodes/工作流"
    DESCRIPTION = "精确控制单个编组。点击下拉框选择目标编组，开关控制跳过/启用，启用状态可由 GG 选项确认连接控制。"

    def run(self, 启用: bool = True) -> dict:
        return {}


NODE_CLASS_MAPPINGS = {
    "GGGroupControllerM": GGGroupControllerM,
    "GGGroupControllerS": GGGroupControllerS,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGGroupControllerM": "GG 多组控制",
    "GGGroupControllerS": "GG 单组控制",
}
