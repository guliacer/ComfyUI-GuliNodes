"""单次512²两阶段扩散实测；不启动/替换服务，不改原图。"""
import asyncio
import copy
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMFY = ROOT.parent.parent
sys.path.insert(0, str(COMFY))
sys.path.insert(0, str(ROOT))
from PIL import Image, ImageDraw, ImageOps

with urllib.request.urlopen('http://127.0.0.1:8188/queue', timeout=10) as response:
    queue = json.load(response)
if queue['queue_running'] or queue['queue_pending']:
    raise RuntimeError('现有ComfyUI队列忙，暂不并行占用GPU进行实测。')

source = COMFY / 'input/77d2c42db7b0e56286aec070a54d1437.png'
test_image = COMFY / 'input/GG_region_validation_masked.png'
if test_image.exists():
    raise RuntimeError('实测输入已存在，需先读取确认，不覆盖用户文件。')
with Image.open(source) as im:
    rgb = ImageOps.exif_transpose(im).convert('RGB')
    mask = Image.new('L', rgb.size, 0)
    # 用于实测的粗略手绘轮廓，不是自动分割或精细抠图结果。
    points = [(320,500),(450,510),(515,560),(555,700),(555,850),(660,860),(715,1050),(760,1170),(930,1260),(920,1430),(940,1560),(1080,1610),(1080,1920),(520,1920),(370,1640),(285,1460),(200,1350),(85,1400),(60,1220),(100,1000),(155,910),(180,750),(210,620),(170,600),(190,550)]
    draw = ImageDraw.Draw(mask)
    draw.polygon(points, fill=255)
    rgba = rgb.convert('RGBA')
    rgba.putalpha(ImageOps.invert(mask))
    rgba.save(test_image)

import nodes
import execution
import guli_nodes
from comfy_extras import nodes_logic, nodes_primitive, nodes_mask
from server import PromptServer
assert not guli_nodes.FAILED_MODULES, guli_nodes.FAILED_MODULES
nodes.NODE_CLASS_MAPPINGS.update(guli_nodes.NODE_CLASS_MAPPINGS)
async def register(module):
    ext = await module.comfy_entrypoint()
    for cls in await ext.get_node_list():
        nodes.NODE_CLASS_MAPPINGS[cls.define_schema().node_id] = cls
for module in (nodes_logic, nodes_primitive, nodes_mask):
    asyncio.run(register(module))

class LocalServer:
    client_id = None
    last_node_id = None
    sockets_metadata = {}
    def __init__(self): self.events=[]
    def send_sync(self,event,data,sid=None):
        self.events.append((event,data))
        if event in ('execution_error','execution_success'): print(event,str(data)[:2000],flush=True)
    def queue_updated(self): pass

server=LocalServer()
PromptServer.instance=server
api=copy.deepcopy(json.loads((ROOT/'tools/region_edit_browser_validation.json').read_text(encoding='utf8'))['output'])
api['1']['inputs']['image']=test_image.name
api['3']['inputs']['value']=False
for nid in ('11','31'):
    api[nid]['inputs']['输出尺寸.宽度']=512
    api[nid]['inputs']['输出尺寸.高度']=512
api['51']['inputs']['文件名前缀']='GG_验证/分区_实际生成'
api['51']['inputs']['清除内存']=False
valid=asyncio.run(execution.validate_prompt('gg-region-diffusion-check',api,None))
assert valid[0],json.dumps(valid,ensure_ascii=False,default=str)
executor=execution.PromptExecutor(server,cache_args={'ram':0,'ram_inactive':0})
start=time.monotonic()
executor.execute(api,'gg-region-diffusion-check',{'client_id':'local-diffusion-test'},['51'])
errors=[data for event,data in executor.status_messages if event=='execution_error']
report={'success':executor.success and not errors,'seconds':round(time.monotonic()-start,2),'crop_size':[512,512],'ai_enhancement':False,'history':executor.history_result,'errors':errors}
out=ROOT/'tools/region_edit_diffusion_probe.json'
out.write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str),encoding='utf8')
print(json.dumps(report,ensure_ascii=False,default=str),flush=True)
assert report['success'],errors
