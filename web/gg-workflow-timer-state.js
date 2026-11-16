// One prompt's timings, independent of ComfyUI/DOM so event ordering is testable.
export const TIMER_NODE_NAME = "GGWorkflowTimer";
export const TIMER_NODE_TITLE = "GG 耗时";
export const DISPLAY_OPTIONS = ["全部", "总用时", "耗时最长的三个节点"];
export const TIMER_RESULT_KEY = "_gg_workflow_timer_result";

const STATUS_LABELS = {
  running: "运行中",
  error: "执行失败",
  interrupted: "已中断",
  disconnected: "连接中断",
};

function finiteTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsed(start, end) {
  return Math.max(0, end - start);
}

function intervalDuration(intervals) {
  const ordered = intervals.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  let left = null;
  let right = null;
  for (const [start, end] of ordered) {
    if (left === null) {
      left = start;
      right = end;
    } else if (start <= right) {
      right = Math.max(right, end);
    } else {
      total += elapsed(left, right);
      left = start;
      right = end;
    }
  }
  return left === null ? 0 : total + elapsed(left, right);
}

export function formatDuration(ms) {
  // Round once before splitting units so 59.999s carries into the next minute.
  const ticks = Math.round(Math.max(0, finiteTime(ms) ?? 0) / 10);
  const hours = Math.floor(ticks / 360000);
  const minutes = Math.floor((ticks % 360000) / 6000);
  const seconds = ((ticks % 6000) / 100).toFixed(2);
  if (hours) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

export class WorkflowTimingRun {
  constructor(promptId, { clock = () => performance.now(), timestamp, resolveNode = () => "" } = {}) {
    this.promptId = String(promptId);
    this.clock = clock;
    this.startedAt = clock();
    this.serverStartedAt = finiteTime(timestamp);
    this.resolveNode = resolveNode;
    this.status = "running";
    this.totalMs = 0;
    this.hasNativeProgress = false;
    this.active = new Map();
    this.groups = new Map();
    this.cachedIds = new Set();
    this.legacyId = null;
  }

  accepts(detail) {
    const id = detail && typeof detail === "object" ? detail.prompt_id : null;
    return this.status === "running" && (id == null || String(id) === this.promptId);
  }

  startNode(runtimeId, displayId, now, realId = displayId) {
    if (this.active.has(runtimeId)) return;
    let group = this.groups.get(displayId);
    if (!group) {
      let name = "";
      try { name = this.resolveNode(displayId, runtimeId, realId); } catch { /* Deleted nodes retain their ID. */ }
      group = { id: displayId, runtimeId, realId, name: String(name || "节点").replace(/[\r\n]+/g, " ").trim(), intervals: [] };
      this.groups.set(displayId, group);
    }
    this.active.set(runtimeId, { displayId, start: now });
  }

  endNode(runtimeId, now) {
    const active = this.active.get(runtimeId);
    if (!active) return;
    this.groups.get(active.displayId)?.intervals.push([active.start, Math.max(active.start, now)]);
    this.active.delete(runtimeId);
  }

  cached(detail) {
    if (!this.accepts(detail)) return;
    for (const id of Array.isArray(detail?.nodes) ? detail.nodes : []) this.cachedIds.add(String(id));
  }

  executing(detail) {
    if (!this.accepts(detail) || this.hasNativeProgress) return;
    const object = detail && typeof detail === "object" ? detail : null;
    const raw = object ? object.display_node ?? object.node : detail;
    const id = raw == null ? null : String(raw);
    if (id === this.legacyId) return;
    const now = this.clock();
    if (this.legacyId !== null) this.endNode(this.legacyId, now);
    this.legacyId = id;
    if (id !== null && !this.cachedIds.has(id)) this.startNode(id, id, now);
  }

  progressState(detail) {
    if (!this.accepts(detail)) return;
    const states = Object.entries(detail?.nodes ?? {}).filter(([, value]) =>
      value && ["running", "finished", "error"].includes(value.state)
      && (value.prompt_id == null || String(value.prompt_id) === this.promptId));
    if (!states.length) return;
    if (!this.hasNativeProgress) {
      // Native states are authoritative; never retain a parallel legacy timer.
      this.hasNativeProgress = true;
      this.active.clear();
      this.groups.clear();
      this.legacyId = null;
    }
    const now = this.clock();
    for (const [key, state] of states) {
      // Expanded children can share real_node_id; node_id/key is the runtime identity.
      const runtimeId = String(state.node_id ?? key);
      const displayId = String(state.display_node_id ?? state.real_node_id ?? state.parent_node_id ?? runtimeId);
      if (state.state === "running") this.startNode(runtimeId, displayId, now, String(state.real_node_id ?? displayId));
      else this.endNode(runtimeId, now);
    }
  }

  finish(status, detail = {}) {
    if (!this.accepts(detail)) return;
    const now = this.clock();
    for (const runtimeId of this.active.keys()) this.endNode(runtimeId, now);
    const serverEnd = finiteTime(detail?.timestamp);
    this.totalMs = serverEnd !== null && this.serverStartedAt !== null && serverEnd >= this.serverStartedAt
      ? serverEnd - this.serverStartedAt
      : elapsed(this.startedAt, now);
    this.status = status;
    this.legacyId = null;
  }

  snapshot() {
    const now = this.clock();
    const intervals = new Map([...this.groups].map(([id, group]) => [id, group.intervals.slice()]));
    for (const active of this.active.values()) intervals.get(active.displayId)?.push([active.start, Math.max(active.start, now)]);
    const topNodes = [...this.groups.values()].map((group) => {
      let name = group.name;
      try { name = this.resolveNode(group.id, group.runtimeId, group.realId) || name; } catch { /* Keep the captured fallback. */ }
      return { id: group.id, name: String(name).replace(/[\r\n]+/g, " ").trim(), ms: intervalDuration(intervals.get(group.id) ?? []) };
    }).sort((a, b) => b.ms - a.ms).slice(0, 3);
    return {
      promptId: this.promptId,
      status: this.status,
      totalMs: this.status === "running" ? elapsed(this.startedAt, now) : this.totalMs,
      topNodes,
      cachedCount: this.cachedIds.size,
      estimated: !this.hasNativeProgress && this.groups.size > 0,
    };
  }
}

export function timerText(summary, display = DISPLAY_OPTIONS[0]) {
  const mode = DISPLAY_OPTIONS.includes(display) ? display : DISPLAY_OPTIONS[0];
  const lines = [];
  if (mode !== DISPLAY_OPTIONS[2]) {
    const status = STATUS_LABELS[summary?.status];
    lines.push(summary
      ? `总用时：${formatDuration(summary.totalMs)}${status ? `（${status}）` : ""}`
      : "总用时：等待执行");
  }
  if (mode !== DISPLAY_OPTIONS[1]) {
    lines.push(`耗时最长的三个节点${summary?.estimated ? "（估算）" : ""}：`);
    const nodes = Array.isArray(summary?.topNodes) ? summary.topNodes.slice(0, 3) : [];
    for (const [index, node] of nodes.entries()) {
      const name = String(node.name || "节点").replace(/[\r\n]+/g, " ");
      lines.push(`${index + 1}. ${name} [#${node.id}]：${formatDuration(node.ms)}`);
    }
    if (!nodes.length) {
      lines.push(!summary ? "等待执行" : summary.status === "running" ? "等待节点执行"
        : summary.cachedCount > 0 ? "本次全部命中缓存，无实际执行节点" : "本次没有可统计的执行节点");
    }
  }
  return lines.join("\n");
}
