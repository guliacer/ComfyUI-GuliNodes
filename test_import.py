#!/usr/bin/env python3
"""
测试插件导入
"""

import sys
import os

# 添加ComfyUI的custom_nodes目录到Python路径
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

try:
    # 测试导入插件
    from guli_nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
    print("[OK] 成功导入插件")
    print(f"[OK] 注册的节点数量: {len(NODE_CLASS_MAPPINGS)}")
    print("[OK] 注册的节点:")
    for node_name, node_class in NODE_CLASS_MAPPINGS.items():
        print(f"  - {node_name}: {node_class.__name__}")
        
except Exception as e:
    print(f"[ERROR] 导入插件失败: {e}")
    import traceback
    traceback.print_exc()
