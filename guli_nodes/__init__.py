# GuliNodes 模块初始化

# 尝试导入各个模块的节点映射
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# 导入 aspect_ratio 模块
try:
    from .aspect_ratio import NODE_CLASS_MAPPINGS as AR_NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as AR_NODE_DISPLAY_NAME_MAPPINGS
    NODE_CLASS_MAPPINGS.update(AR_NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(AR_NODE_DISPLAY_NAME_MAPPINGS)
except Exception as e:
    print(f"导入 aspect_ratio 模块失败: {e}")

# 导入 image_tools 模块
try:
    from .image_tools import NODE_CLASS_MAPPINGS as IM_NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as IM_NODE_DISPLAY_NAME_MAPPINGS
    NODE_CLASS_MAPPINGS.update(IM_NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(IM_NODE_DISPLAY_NAME_MAPPINGS)
except Exception as e:
    print(f"导入 image_tools 模块失败: {e}")

# 导入 lora_tools 模块
try:
    from .lora_tools import NODE_CLASS_MAPPINGS as LORA_NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as LORA_NODE_DISPLAY_NAME_MAPPINGS
    NODE_CLASS_MAPPINGS.update(LORA_NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(LORA_NODE_DISPLAY_NAME_MAPPINGS)
except Exception as e:
    print(f"导入 lora_tools 模块失败: {e}")

# 导入 text_tools 模块
try:
    from .text_tools import NODE_CLASS_MAPPINGS as TEXT_NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as TEXT_NODE_DISPLAY_NAME_MAPPINGS
    NODE_CLASS_MAPPINGS.update(TEXT_NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(TEXT_NODE_DISPLAY_NAME_MAPPINGS)
except Exception as e:
    print(f"导入 text_tools 模块失败: {e}")

# 导入 seed_tools 模块
try:
    from .seed_tools import NODE_CLASS_MAPPINGS as SEED_NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as SEED_NODE_DISPLAY_NAME_MAPPINGS
    NODE_CLASS_MAPPINGS.update(SEED_NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(SEED_NODE_DISPLAY_NAME_MAPPINGS)
except Exception as e:
    print(f"导入 seed_tools 模块失败: {e}")

# 导入 group_controller 模块
try:
    from .group_controller import NODE_CLASS_MAPPINGS as GROUP_NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as GROUP_NODE_DISPLAY_NAME_MAPPINGS
    NODE_CLASS_MAPPINGS.update(GROUP_NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(GROUP_NODE_DISPLAY_NAME_MAPPINGS)
except Exception as e:
    print(f"导入 group_controller 模块失败: {e}")

# 导入 clipboard 模块
try:
    from .clipboard import NODE_CLASS_MAPPINGS as CLIPBOARD_NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as CLIPBOARD_NODE_DISPLAY_NAME_MAPPINGS
    NODE_CLASS_MAPPINGS.update(CLIPBOARD_NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(CLIPBOARD_NODE_DISPLAY_NAME_MAPPINGS)
except Exception as e:
    print(f"导入 clipboard 模块失败: {e}")

# 导入 image_prompt 模块
try:
    from .image_prompt import NODE_CLASS_MAPPINGS as IMAGE_PROMPT_NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as IMAGE_PROMPT_NODE_DISPLAY_NAME_MAPPINGS
    NODE_CLASS_MAPPINGS.update(IMAGE_PROMPT_NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(IMAGE_PROMPT_NODE_DISPLAY_NAME_MAPPINGS)
except Exception as e:
    print(f"导入 image_prompt 模块失败: {e}")

# 打印导入结果
print(f"成功导入 {len(NODE_CLASS_MAPPINGS)} 个节点")
print(f"节点列表: {list(NODE_DISPLAY_NAME_MAPPINGS.values())}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]