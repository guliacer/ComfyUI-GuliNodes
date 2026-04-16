class GGGroupControllerM:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "GuliNodes/编组控制"
    DESCRIPTION = "批量控制工作流中所有编组。全部跳过/全部启用，点击编组名可跳转。"

    def run(self) -> dict:
        """运行批量编组控制"""
        return {}


class GGGroupControllerS:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "GuliNodes/编组控制"
    DESCRIPTION = "精确控制单个编组。点击下拉框选择目标编组，开关控制跳过/启用。"

    def run(self) -> dict:
        """运行单个编组控制"""
        return {}


NODE_CLASS_MAPPINGS = {
    "GGGroupControllerM": GGGroupControllerM,
    "GGGroupControllerS": GGGroupControllerS,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGGroupControllerM": "GG 多组控制",
    "GGGroupControllerS": "GG 单组控制",
}