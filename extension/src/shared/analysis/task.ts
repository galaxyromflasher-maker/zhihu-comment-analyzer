import type { ExtractedContent, PageInfo } from '@/types/zhihu';

export const PENDING_TASK_KEY = 'za_pending_report_task';

export interface ReportTask {
  id: string;
  content: ExtractedContent;
  pageInfo: PageInfo;
  createdAt: number;
}

export async function setPendingTask(task: ReportTask): Promise<void> {
  await chrome.storage.local.set({ [PENDING_TASK_KEY]: task });
}

export async function takePendingTask(): Promise<ReportTask | null> {
  const data = await chrome.storage.local.get(PENDING_TASK_KEY);
  const task = (data[PENDING_TASK_KEY] as ReportTask) || null;
  if (task) {
    await chrome.storage.local.remove(PENDING_TASK_KEY);
  }
  return task;
}

export function createTaskId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
