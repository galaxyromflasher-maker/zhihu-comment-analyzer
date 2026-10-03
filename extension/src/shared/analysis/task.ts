import type { ExtractedContent, PageInfo } from '@/types/zhihu';

export const PENDING_TASK_KEY = 'za_pending_report_task';
export const TASK_HISTORY_KEY = 'za_report_task_history';
export const TASK_HISTORY_LIMIT = 30;

export interface ReportTask {
  id: string;
  content: ExtractedContent;
  pageInfo: PageInfo;
  createdAt: number;
  mode?: 'collect' | 'analyze';
  bundleFile?: string;
}

export type TaskHistoryStatus = 'queued' | 'running' | 'partial' | 'failed' | 'completed';

/** 历史只保存任务摘要，不复制回答正文，避免 chrome.storage 被大 HTML 占满。 */
export interface TaskHistoryEntry {
  id: string;
  title: string;
  author: string;
  url: string;
  pageType: PageInfo['type'];
  pageId: string;
  createdAt: number;
  updatedAt: number;
  status: TaskHistoryStatus;
  mode: 'collect' | 'analyze';
  bundleFile?: string;
  reportFile?: string;
  commentCount?: number;
  completenessStatus?: 'complete' | 'partial' | 'unknown';
  analysisWarnings?: string[];
  lastError?: string;
}

export type TaskHistoryPatch = Partial<Omit<TaskHistoryEntry, 'id' | 'createdAt'>>;

export function historyEntryFromTask(
  task: ReportTask,
  patch: TaskHistoryPatch = {},
): TaskHistoryEntry {
  const now = Date.now();
  return {
    id: task.id,
    title: task.content.title || '未命名知乎内容',
    author: task.content.author || '知乎用户',
    url: task.content.url,
    pageType: task.pageInfo.type,
    pageId: task.pageInfo.id,
    createdAt: task.createdAt || now,
    updatedAt: now,
    status: task.mode === 'analyze' ? 'partial' : 'queued',
    mode: task.mode || 'collect',
    bundleFile: task.bundleFile,
    ...patch,
  };
}

export function historyEntryFromBundle(
  id: string,
  bundle: {
    source: { url: string; content_type: PageInfo['type']; content_id: string };
    answer: { question_title: string; author: { name: string } };
  },
  patch: TaskHistoryPatch = {},
): TaskHistoryEntry {
  const now = Date.now();
  return {
    id,
    title: bundle.answer.question_title || '未命名知乎内容',
    author: bundle.answer.author.name || '知乎用户',
    url: bundle.source.url,
    pageType: bundle.source.content_type,
    pageId: bundle.source.content_id,
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    mode: 'analyze',
    ...patch,
  };
}

export async function listTaskHistory(): Promise<TaskHistoryEntry[]> {
  const data = await chrome.storage.local.get(TASK_HISTORY_KEY);
  const raw = (Array.isArray(data[TASK_HISTORY_KEY]) ? data[TASK_HISTORY_KEY] : []) as unknown[];
  return raw
    .filter((item: unknown): item is TaskHistoryEntry => Boolean(item && typeof item === 'object'))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, TASK_HISTORY_LIMIT);
}

export async function upsertTaskHistory(entry: TaskHistoryEntry): Promise<void> {
  const history = await listTaskHistory();
  const next = [entry, ...history.filter((item) => item.id !== entry.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, TASK_HISTORY_LIMIT);
  await chrome.storage.local.set({ [TASK_HISTORY_KEY]: next });
}

export async function updateTaskHistory(id: string, patch: TaskHistoryPatch): Promise<TaskHistoryEntry | null> {
  const history = await listTaskHistory();
  const existing = history.find((item) => item.id === id);
  if (!existing) return null;
  const next = { ...existing, ...patch, id, updatedAt: Date.now() };
  await upsertTaskHistory(next);
  return next;
}

export async function setPendingTask(task: ReportTask): Promise<void> {
  await chrome.storage.local.set({ [PENDING_TASK_KEY]: task });
  await upsertTaskHistory(historyEntryFromTask(task));
}

export async function takePendingTask(): Promise<ReportTask | null> {
  const data = await chrome.storage.local.get(PENDING_TASK_KEY);
  // 读取不等于消费：任务必须在成功完成后才清除，工作台中途关闭时才能恢复。
  return (data[PENDING_TASK_KEY] as ReportTask) || null;
}

export async function clearPendingTask(): Promise<void> {
  await chrome.storage.local.remove(PENDING_TASK_KEY);
}

export function createTaskId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
