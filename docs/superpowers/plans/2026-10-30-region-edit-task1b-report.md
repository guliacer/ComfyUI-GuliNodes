# Task1b 实施与验证记录

## 必要性与范围

本机已配置 PE-I2I GGUF 的实际架构为 qwen35，mmproj 架构 clip，现有提示词增强节点固定选择 Qwen2.5视觉模板，无法据此宣称正确兼容。这里只修复既有本地LLM路径和handler桥接，不新增节点/参数，不改变API或官方PE通路，不增加强制依赖，不复制模板。

修改：guli_nodes/prompt_enhancer.py；新增测试 tests/test_prompt_enhancer_local_compat.py。所有修改前已读取文件。models/LLM兜底仅扫描该本地目录，优先保留已有folder_paths查找，不注册/覆盖全局目录，禁止相对路径越界。Llama加载后读取metadata，qwen35选择Qwen35ChatHandler(enable_thinking=False)，qwen3vl选择Qwen3VL，qwen2vl仍Qwen25VL/Qwen2VL回退；不支持架构或缺少对应handler中文报错。失败、切换与卸载清空缓存并释放视觉投影、主模型。

## TDD

- RED：portable Python -B -m unittest discover -s tests -p test_prompt_enhancer_local_compat.py -v；14 tests，7 failures+1 error。错误均为旧路径无法发现LLM、错误Qwen25模板、缺少失败清理/视觉释放；已有Qwen2、文本/缓存等测试通过。
- 初次GREEN：同命令14/14 PASS。
- 按实际Llama.close源码增加投影只关闭一次的资源关系断言；RED -k unload_closes 得1 failure（2!=1）。解除llm.chat_handler引用后显式关闭投影和模型，正在用完整回归命令复核。
- 真实视觉改写脚本 tools/probe_region_local_llm.py 已启动，不向外部API发送图像，不启动服务；结果写 tools/region_edit_local_llm_probe.json。不得把模型文件存在或单元替身通过当成真实推理成功，等脚本结果再下结论。

## 约束

保持所有既有节点ID/端口/参数和版本号；llama-cpp-python仍按需在函数中导入。未安装库、下载模型、重启/停止ComfyUI或改动用户原图。环境原有pynvml和requests版本警告保留，不在本任务重装依赖。
