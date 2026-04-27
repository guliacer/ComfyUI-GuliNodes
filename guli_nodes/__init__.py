from importlib import import_module


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

_NODE_MODULES = (
    "aspect_ratio",
    "image_tools",
    "video_tools",
    "lora_tools",
    "text_tools",
    "seed_tools",
    "group_controller",
    "clipboard",
    "image_prompt",
    "model_loaders",
)


def _load_node_module(module_name: str) -> None:
    try:
        module = import_module(f"{__name__}.{module_name}")
    except Exception as exc:
        print(f"导入 {module_name} 模块失败: {exc}")
        return

    NODE_CLASS_MAPPINGS.update(getattr(module, "NODE_CLASS_MAPPINGS", {}))
    NODE_DISPLAY_NAME_MAPPINGS.update(getattr(module, "NODE_DISPLAY_NAME_MAPPINGS", {}))


for _module_name in _NODE_MODULES:
    _load_node_module(_module_name)


print(f"成功导入 {len(NODE_CLASS_MAPPINGS)} 个节点")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
