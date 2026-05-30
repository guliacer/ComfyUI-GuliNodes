from importlib import import_module
import traceback


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
LOADED_MODULES = []
FAILED_MODULES = {}

_NODE_MODULES = (
    "aspect_ratio",
    "image_tools",
    "mask_tools",
    "sharpen_tools",
    "video_tools",
    "lora_tools",
    "text_tools",
    "key_tools",
    "numeric_tools",
    "set_get",
    "title_node",
    "reroute_tools",
    "dype_tools",
    "seed_tools",
    "group_controller",
    "clipboard",
    "everywhere",
    "web_ai_tools",
    "model_loaders",
    "zimage_sampler",
    "seedvr2_aggregate",
)


def _load_node_module(module_name: str) -> None:
    try:
        module = import_module(f"{__name__}.{module_name}")
    except Exception as exc:
        FAILED_MODULES[module_name] = str(exc)
        print(f"导入 {module_name} 模块失败: {exc}")
        traceback.print_exc()
        return

    module_nodes = getattr(module, "NODE_CLASS_MAPPINGS", {})
    module_display_names = getattr(module, "NODE_DISPLAY_NAME_MAPPINGS", {})
    NODE_CLASS_MAPPINGS.update(module_nodes)
    for node_id in module_nodes:
        NODE_DISPLAY_NAME_MAPPINGS[node_id] = module_display_names.get(node_id, node_id)
    LOADED_MODULES.append(module_name)


for _module_name in _NODE_MODULES:
    _load_node_module(_module_name)


print(f"成功导入 {len(NODE_CLASS_MAPPINGS)} 个节点")
if FAILED_MODULES:
    print(f"部分 GuliNodes 模块导入失败: {', '.join(FAILED_MODULES)}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "LOADED_MODULES", "FAILED_MODULES"]
