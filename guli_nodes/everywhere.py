class GGAnythingEverywhere:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "任意输入": ("*", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "GuliNodes/工作流"
    DESCRIPTION = "Broadcast connected values to matching unconnected inputs when the workflow is queued."
    OUTPUT_NODE = False

    def run(self, **kwargs):
        return ()


NODE_CLASS_MAPPINGS = {
    "GGAnythingEverywhere": GGAnythingEverywhere,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGAnythingEverywhere": "GG 全局转接",
}
