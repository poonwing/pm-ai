export type RunnerLogKind = 'system' | 'assistant' | 'tool' | 'thinking' | 'error';

export interface RunnerLogEntry {
  seq: number;
  at: string;
  kind: RunnerLogKind;
  text: string;
}

const MAX_ENTRIES = 500;
const buffers = new Map<string, RunnerLogEntry[]>();
const listeners = new Map<string, Set<(entry: RunnerLogEntry) => void>>();
let globalSeq = 0;

function logKey(projectId: string, taskId: string) {
  return `${projectId}:${taskId}`;
}

export function appendRunnerLog(
  projectId: string,
  taskId: string,
  kind: RunnerLogKind,
  text: string,
): RunnerLogEntry | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const key = logKey(projectId, taskId);
  const entry: RunnerLogEntry = {
    seq: ++globalSeq,
    at: new Date().toISOString(),
    kind,
    text: trimmed.slice(0, 8000),
  };

  let buf = buffers.get(key);
  if (!buf) {
    buf = [];
    buffers.set(key, buf);
  }
  buf.push(entry);
  if (buf.length > MAX_ENTRIES) {
    buf.splice(0, buf.length - MAX_ENTRIES);
  }

  for (const fn of listeners.get(key) ?? []) {
    try {
      fn(entry);
    } catch {
      /* ignore listener errors */
    }
  }
  return entry;
}

/** 同 kind 的 assistant/thinking 串流更新最後一條，避免 token 碎片化 */
export function updateOrAppendRunnerLog(
  projectId: string,
  taskId: string,
  kind: RunnerLogKind,
  text: string,
): RunnerLogEntry | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const key = logKey(projectId, taskId);
  let buf = buffers.get(key);
  if (!buf) {
    buf = [];
    buffers.set(key, buf);
  }

  const last = buf[buf.length - 1];
  const mergeable = kind === 'assistant' || kind === 'thinking';
  if (mergeable && last && last.kind === kind) {
    last.text = trimmed.slice(0, 8000);
    last.at = new Date().toISOString();
    for (const fn of listeners.get(key) ?? []) {
      try {
        fn({ ...last });
      } catch {
        /* ignore listener errors */
      }
    }
    return last;
  }

  return appendRunnerLog(projectId, taskId, kind, trimmed);
}

export function getRunnerLogs(
  projectId: string,
  taskId: string,
  sinceSeq = 0,
): { entries: RunnerLogEntry[]; latestSeq: number } {
  const buf = buffers.get(logKey(projectId, taskId)) ?? [];
  const entries = sinceSeq > 0 ? buf.filter((e) => e.seq > sinceSeq) : [...buf];
  const latestSeq = buf.length > 0 ? buf[buf.length - 1]!.seq : sinceSeq;
  return { entries, latestSeq };
}

export function subscribeRunnerLogs(
  projectId: string,
  taskId: string,
  fn: (entry: RunnerLogEntry) => void,
): () => void {
  const key = logKey(projectId, taskId);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(key);
  };
}
