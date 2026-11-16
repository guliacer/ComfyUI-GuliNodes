import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { registerTitleDisplayNode, refreshTitleDisplay } from "./gg-title-node.js";
import { WorkflowTimingRun, TIMER_NODE_NAME, TIMER_NODE_TITLE, DISPLAY_OPTIONS, TIMER_RESULT_KEY, timerText } from "./gg-workflow-timer-state.js";
import { createTimerDashboard } from "./gg-workflow-timer-ui.js";

const SETTING_ID = "GuliNodes.WorkflowTimer.Enabled";
const UPDATE_INTERVAL = 250;
const MAX_RETAINED_RUNS = 64;
const contexts = new Map();
const runs = new Map();
const pendingRequests = new Set();
const pendingTerminals = new Set();
let nodeSummaries = new WeakMap();
let ownerSlots = new WeakMap();
let promptOrigins = new WeakMap();
const textCache = new WeakMap();
let activeLegacyId = null;
let animationFrame = 0;
let lastPaint = 0;
let emptyQueueCandidates = null;
let queueCheckNeeded = false;
let queueCheckInFlight = false;
const queueHookTargets = new WeakMap();
let graphToPromptHook = null;

function enabled() {
  try { return app.ui?.settings?.getSettingValue?.(SETTING_ID, true) !== false; }
  catch { return true; }
}

function rootGraph() { return app.rootGraph ?? app.graph; }
function workflowOwner() { return app.extensionManager?.workflow?.activeWorkflow ?? rootGraph(); }
function isTimer(node) { return node?.comfyClass === TIMER_NODE_NAME || node?.type === TIMER_NODE_NAME; }

function graphTimers(root) {
  const result = [];
  const seen = new Set();
  const visit = graph => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const node of graph._nodes ?? graph.nodes ?? []) {
      if (isTimer(node)) result.push(node);
      if (node.subgraph) visit(node.subgraph);
    }
    const store = graph._subgraphs;
    if (typeof store?.values === "function") for (const subgraph of store.values()) visit(subgraph);
  };
  visit(root);
  return result;
}

function timerKey(node, root) {
  const graph = node.graph;
  const scope = !graph || graph === root || graph.id === root?.id ? "root" : String(graph.id);
  return `${scope}:${node.id}`;
}

function slotMap(owner) {
  let slots = ownerSlots.get(owner);
  if (!slots) { slots = new Map(); ownerSlots.set(owner, slots); }
  return slots;
}

function slotKey(graphId, key) { return `${graphId}|${key}`; }

function summaryFor(node) {
  const graph = rootGraph();
  const owner = workflowOwner();
  const slot = owner && ownerSlots.get(owner)?.get(slotKey(graph?.id ?? "", timerKey(node, graph)));
  return slot?.summary ?? nodeSummaries.get(node) ?? node.properties?.[TIMER_RESULT_KEY] ?? null;
}

function displayText(node) {
  if (!enabled()) return "耗时统计已关闭";
  const summary = summaryFor(node);
  const display = node.widgets?.find(widget => widget.name === "展示内容")?.value ?? node.properties?.["展示内容"] ?? DISPLAY_OPTIONS[0];
  const cached = textCache.get(node);
  if (cached?.summary === summary && cached.display === display) return cached.text;
  const text = timerText(summary, display);
  textCache.set(node, { summary, display, text });
  return text;
}

registerTitleDisplayNode(TIMER_NODE_NAME, {
  ...createTimerDashboard({
    getSummary: summaryFor,
    getDisplay: node => node.widgets?.find(widget => widget.name === "展示内容")?.value ?? node.properties?.["展示内容"] ?? DISPLAY_OPTIONS[0],
    isEnabled: enabled,
  }),
  title: TIMER_NODE_TITLE,
  category: "GuliNodes/工作流",
  getText: displayText,
  allowVertical: false,
  defaultSize: [760, 280],
  defaults: { "字体颜色": "" },
  fields: [{ name: "展示内容", defaultValue: DISPLAY_OPTIONS[0], type: "combo", values: DISPLAY_OPTIONS }],
});

function captureOrigin() {
  const graph = rootGraph();
  const owner = workflowOwner();
  return graph && owner ? { graph, owner, graphId: String(graph.id ?? ""), nodes: graphTimers(graph) } : null;
}

function installGraphToPromptHook() {
  const original = app.graphToPrompt;
  if (typeof original !== "function" || original === graphToPromptHook) return;
  const wrapped = function (...args) {
    // 其他扩展的转发链可能保留旧包装；只有最外层活动包装认领来源。
    if (graphToPromptHook !== wrapped) return original.apply(this, args);
    const origin = enabled() ? captureOrigin() : null;
    const origins = promptOrigins;
    const result = original.apply(this, args);
    const remember = prompt => {
      if (origin && prompt?.output && typeof prompt.output === "object") origins.set(prompt.output, origin);
    };
    // Observe before the caller awaits, but return the original Promise/error path.
    if (origin && typeof result?.then === "function") result.then(remember, () => {});
    else remember(result);
    return result;
  };
  wrapped._ggWorkflowTimerWrapped = true;
  graphToPromptHook = wrapped;
  app.graphToPrompt = wrapped;
}

function captureContext(prompt) {
  const workflow = prompt?.workflow;
  if (!workflow) return null;
  const keys = new Set();
  const visit = (data, scope) => {
    for (const node of data?.nodes ?? []) if (node.type === TIMER_NODE_NAME) keys.add(`${scope}:${node.id}`);
    for (const graph of data?.definitions?.subgraphs ?? []) visit(graph, String(graph.id));
  };
  visit(workflow, "root");
  if (!keys.size) return null;
  let origin = promptOrigins.get(prompt.output);
  if (!origin) {
    const graph = rootGraph();
    if (workflow.id == null || graph?.id == null || String(workflow.id) !== String(graph.id)) return null;
    origin = captureOrigin();
  }
  if (!origin) return null;
  // Copy only immutable names/identities, not the potentially large workflow.
  const names = new Map(Object.entries(prompt.output ?? {}).map(([id, node]) =>
    [String(id), String(node?._meta?.title || node?.class_type || "节点")]));
  return { ...origin, keys, names };
}

function currentContext(context) {
  return context.owner === workflowOwner() && context.graphId === String(rootGraph()?.id ?? "");
}

function liveNodes(context) {
  const nodes = new Set(context.nodes);
  if (currentContext(context)) for (const node of graphTimers(rootGraph())) nodes.add(node);
  return [...nodes].filter(node => node.graph && context.keys.has(timerKey(node, context.graph)));
}

function publish(record) {
  const context = record.context;
  if (!context) return;
  const summary = record.run.snapshot();
  const slots = slotMap(context.owner);
  for (const key of context.keys) {
    const id = slotKey(context.graphId, key);
    const previous = slots.get(id);
    if (!previous || previous.startedAt <= record.run.startedAt) slots.set(id, { summary, startedAt: record.run.startedAt });
  }
  for (const node of liveNodes(context)) {
    const slot = slots.get(slotKey(context.graphId, timerKey(node, context.graph)));
    if (slot?.summary !== summary) continue;
    nodeSummaries.set(node, summary);
    if (summary.status !== "running") {
      node.properties ??= {};
      node.properties[TIMER_RESULT_KEY] = summary;
    }
    if (currentContext(context)) refreshTitleDisplay(node);
  }
}

function runningVisibleRecords() {
  return [...runs.values()].filter(record => record.run.status === "running" && record.context
    && currentContext(record.context) && liveNodes(record.context).length);
}

function schedulePaint() {
  if (animationFrame || !enabled() || !runningVisibleRecords().length) return;
  const tick = now => {
    animationFrame = 0;
    const records = runningVisibleRecords();
    if (!enabled() || !records.length) return;
    if (now - lastPaint >= UPDATE_INTERVAL) {
      lastPaint = now;
      for (const record of records) publish(record);
    }
    animationFrame = requestAnimationFrame(tick);
  };
  animationFrame = requestAnimationFrame(tick);
}

function releaseContexts(candidates, liveIds = new Set()) {
  for (const [id, context] of candidates) {
    if (!liveIds.has(id) && contexts.get(id) === context) contexts.delete(id);
  }
}

function prune() {
  if (!pendingRequests.size) {
    if (emptyQueueCandidates) { releaseContexts(emptyQueueCandidates); emptyQueueCandidates = null; }
    pendingTerminals.clear();
    for (const [id, record] of runs) if (!record.context && !contexts.has(id)) runs.delete(id);
  }
  for (const [id, record] of runs) {
    if (runs.size <= MAX_RETAINED_RUNS) break;
    if (record.run.status !== "running" && (record.context || !pendingRequests.size)) runs.delete(id);
  }
  if (!runningVisibleRecords().length && animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }
}

async function reconcileQueue(eventApi) {
  if (!queueCheckNeeded || queueCheckInFlight || pendingRequests.size || !enabled()) return;
  queueCheckNeeded = false;
  if (!contexts.size) return;
  queueCheckInFlight = true;
  const candidates = new Map(contexts);
  try {
    let queue;
    // The newer getQueue uses a capped /jobs page; /queue is the complete snapshot.
    if (typeof eventApi.fetchApi === "function") {
      const response = await eventApi.fetchApi("/queue");
      if (!response.ok) return;
      queue = await response.json();
    } else if (typeof eventApi.getQueue === "function") {
      queue = await eventApi.getQueue({ throwOnError: true });
    } else return;
    const running = queue?.queue_running ?? queue?.Running;
    const waiting = queue?.queue_pending ?? queue?.Pending;
    if (!Array.isArray(running) || !Array.isArray(waiting)) return;
    const liveIds = new Set();
    for (const item of [...running, ...waiting]) {
      const id = Array.isArray(item) ? item[1] : item?.prompt?.[1] ?? item?.id ?? item?.prompt_id;
      if (id == null) return;
      liveIds.add(String(id));
    }
    if (enabled()) releaseContexts(candidates, liveIds);
  } catch { /* Preserve ownership until a later native status/reconnect confirms it. */ }
  finally {
    queueCheckInFlight = false;
    prune();
    if (queueCheckNeeded) void reconcileQueue(eventApi);
  }
}

function bind(record, context) {
  contexts.delete(record.run.promptId);
  record.context = context;
  record.run.resolveNode = (displayId, runtimeId, realId) => context.names.get(displayId)
    ?? context.names.get(realId) ?? context.names.get(runtimeId) ?? "节点";
  publish(record);
  schedulePaint();
}

function promptId(detail) {
  return detail && typeof detail === "object" && detail.prompt_id != null ? String(detail.prompt_id) : null;
}

function start(detail) {
  if (!enabled()) return;
  const id = promptId(detail);
  if (!id || runs.has(id)) return;
  const context = contexts.get(id);
  if (!context && !pendingRequests.size) return;
  // Start immediately, even before HTTP returns, so early events keep real times.
  const record = { context: null, run: new WorkflowTimingRun(id, { timestamp: detail.timestamp, clock: () => performance.now() }) };
  runs.set(id, record);
  activeLegacyId = id;
  if (context) bind(record, context);
}

function update(method, detail) {
  if (!enabled()) return;
  const id = promptId(detail) ?? activeLegacyId;
  const record = id && runs.get(id);
  if (!record) return;
  record.run[method](detail);
  publish(record);
  schedulePaint();
}

function finish(status, detail) {
  if (!enabled() || detail?.exception_type === "ExecutionBlocked") return;
  const id = promptId(detail) ?? activeLegacyId;
  const record = id && runs.get(id);
  if (id) contexts.delete(id);
  if (!record) {
    if (id && pendingRequests.size) pendingTerminals.add(id);
    prune();
    return;
  }
  record.run.finish(status, detail);
  publish(record);
  if (activeLegacyId === id) activeLegacyId = null;
  prune();
}

function installQueuePromptHook(eventApi) {
  const original = eventApi.queuePrompt;
  if (typeof original !== "function" || original === queueHookTargets.get(eventApi)) return;
  const wrapped = async function (...args) {
    // 后置插件可能保存旧提交包装并异步转发。退休层只转发，避免重复统计；
    // 不按请求对象去重，同一个对象的两次并发提交仍各自拥有统计上下文。
    if (queueHookTargets.get(eventApi) !== wrapped) return original.apply(this, args);
    const context = enabled() ? captureContext(args.find(value => value?.output && value?.workflow)) : null;
    if (!context) return original.apply(this, args);
    pendingRequests.add(context);
    try {
      const response = await original.apply(this, args);
      const id = promptId(response);
      if (id && enabled() && pendingRequests.has(context)) {
        const record = runs.get(id);
        if (record) bind(record, context);
        else if (!pendingTerminals.has(id)) contexts.set(id, context);
      }
      return response;
    } finally {
      pendingRequests.delete(context);
      prune();
      if (queueCheckNeeded) void reconcileQueue(eventApi);
    }
  };
  queueHookTargets.set(eventApi, wrapped);
  eventApi.queuePrompt = wrapped;
}

function installHooks() {
  installGraphToPromptHook();
  const eventApi = app.api ?? api;
  if (!eventApi) return;
  // 监听器只装一次；函数身份单独核对，修复 setup 后被其他扩展覆盖的入口。
  installQueuePromptHook(eventApi);
  if (eventApi._ggWorkflowTimerHooksInstalled) return;
  eventApi.addEventListener("execution_start", ({ detail }) => start(detail));
  eventApi.addEventListener("execution_cached", ({ detail }) => update("cached", detail));
  eventApi.addEventListener("progress_state", ({ detail }) => update("progressState", detail));
  eventApi.addEventListener("executing", ({ detail }) => update("executing", detail));
  eventApi.addEventListener("execution_success", ({ detail }) => finish("success", detail));
  eventApi.addEventListener("execution_error", ({ detail }) => finish("error", detail));
  eventApi.addEventListener("execution_interrupted", ({ detail }) => finish("interrupted", detail));
  eventApi.addEventListener("status", ({ detail }) => {
    const remaining = detail?.exec_info?.queue_remaining;
    if (typeof remaining !== "number" || remaining < 0 || !Number.isFinite(remaining)) return;
    // Zero includes running work. Keep only candidates known at this event, not
    // a later HTTP response that may belong to a newly accepted queue entry.
    emptyQueueCandidates = remaining === 0 ? new Map(contexts) : null;
    prune();
  });
  eventApi.addEventListener("reconnecting", () => {
    for (const [id, record] of runs) if (record.run.status === "running") finish("disconnected", { prompt_id: id });
  });
  eventApi.addEventListener("reconnected", () => {
    queueCheckNeeded = contexts.size > 0 || pendingRequests.size > 0;
    return reconcileQueue(eventApi);
  });
  eventApi._ggWorkflowTimerHooksInstalled = true;
}

app.registerExtension({
  name: "ComfyUI.GGNodes.WorkflowTimer",
  setup() { installHooks(); },
  nodeCreated(node) { if (isTimer(node)) installHooks(); },
  afterConfigureGraph() { if (graphTimers(rootGraph()).length) installHooks(); },
  loadedGraphNode(node) {
    if (!isTimer(node)) return;
    installHooks();
    const summary = summaryFor(node);
    if (summary) {
      nodeSummaries.set(node, summary);
      if (summary.status !== "running") { node.properties ??= {}; node.properties[TIMER_RESULT_KEY] = summary; }
    }
    for (const record of runs.values()) if (record.context && currentContext(record.context) && record.run.status === "running") publish(record);
    schedulePaint();
  },
  settings: [{
    id: SETTING_ID, category: ["GuliNodes", "工作流"], name: "启用耗时统计", type: "boolean", defaultValue: true,
    tooltip: "GG 耗时自动显示工作流总用时与最慢的三个节点，无需接线。",
    onChange(value) {
      if (value === false) {
        contexts.clear(); runs.clear(); pendingRequests.clear(); pendingTerminals.clear();
        emptyQueueCandidates = null; queueCheckNeeded = false;
        activeLegacyId = null;
        nodeSummaries = new WeakMap(); ownerSlots = new WeakMap(); promptOrigins = new WeakMap();
        if (animationFrame) cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      for (const node of graphTimers(rootGraph())) refreshTitleDisplay(node);
    },
  }],
});
