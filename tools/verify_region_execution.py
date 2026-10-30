"""新注册节点的实际API验证与无模型懒求值执行；不启动HTTP服务。"""
import asyncio
import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMFY = ROOT.parent.parent
sys.path.insert(0, str(COMFY))
sys.path.insert(0, str(ROOT))

import nodes
import execution
import guli_nodes
from comfy_extras import nodes_logic, nodes_primitive, nodes_mask
from server import PromptServer

nodes.NODE_CLASS_MAPPINGS.update(guli_nodes.NODE_CLASS_MAPPINGS)

async def register_extra(module):
    ext = await module.comfy_entrypoint()
    for cls in await ext.get_node_list():
        nodes.NODE_CLASS_MAPPINGS[cls.define_schema().node_id] = cls

for module in (nodes_logic, nodes_primitive, nodes_mask):
    asyncio.run(register_extra(module))

class SafeExecutionServer:
    client_id = None
    last_node_id = None
    sockets_metadata = {}
    def __init__(self):
        self.events = []
    def send_sync(self, event, data, sid=None):
        self.events.append((event, data))
    def queue_updated(self):
        pass

server = SafeExecutionServer()
PromptServer.instance = server
workflow = json.loads((ROOT / 'examples/workflows/GG-人像背景分区编辑_Qwen2.1_Turbo.json').read_text(encoding='utf8'))
api = json.loads((ROOT / 'tools/region_edit_browser_validation.json').read_text(encoding='utf8'))['output']
validation = asyncio.run(execution.validate_prompt('gg-region-validate', api, None))
assert validation[0], json.dumps(validation, ensure_ascii=False, default=str)
print('API_VALIDATION_PASS:', validation[2])

# 在真实执行器里清空两区需求，证明不会索取模型加载/采样/本地LLM分支。
no_op = copy.deepcopy(api)
no_op['10']['inputs']['编辑需求'] = ''
no_op['30']['inputs']['编辑需求'] = '  '
no_op['51']['inputs']['文件名前缀'] = 'GG_验证/分区_无修改'
no_op['51']['inputs']['清除内存'] = False
executor = execution.PromptExecutor(server, cache_args={'ram':0,'ram_inactive':0})
executor.execute(no_op, 'gg-region-noop', {'client_id':'local-verification','extra_pnginfo':{'workflow':workflow}}, ['51'])
assert executor.success, executor.status_messages
errors = [data for event,data in server.events if event == 'execution_error']
assert not errors, errors
executed = [data.get('node') for event,data in server.events if event == 'executed']
# 实际缓存中不应出现任何神经网络分支节点。
for nid in ['4','5','6','12','15','16','18','32','35','36','38']:
    # all_node_ids包含预登记的空键；是否执行必须检查真实缓存输出。
    assert asyncio.run(executor.caches.outputs.get(nid)) is None, '无需求仍执行模型节点 '+nid
report = {'api_validation':True, 'no_op_execution':True, 'executed_output_nodes':executed, 'history':executor.history_result, 'diffusion_executed':False}

# 当前原图无Alpha选区，启用编辑应在准备节点拒绝，且不加载模型。
invalid_executor = execution.PromptExecutor(server, cache_args={'ram':0,'ram_inactive':0})
invalid_executor.execute(api, 'gg-region-empty-mask', {'client_id':'local-verification'}, ['51'])
assert not invalid_executor.success, '空蒙版错误地进入了生成'
invalid_errors = [data for event,data in invalid_executor.status_messages if event == 'execution_error']
assert invalid_errors and '遮罩' in invalid_errors[-1]['exception_message'], invalid_executor.status_messages
for nid in ['4','5','6','12','18','32','38']:
    assert asyncio.run(invalid_executor.caches.outputs.get(nid)) is None, '空蒙版仍执行模型节点 '+nid
report['empty_mask_rejected_before_models'] = True
report['empty_mask_message'] = invalid_errors[-1]['exception_message']
out=ROOT/'tools/region_edit_execution_report.json'
out.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str),encoding='utf8')
print(json.dumps(report,ensure_ascii=False,default=str))
