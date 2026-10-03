import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ensureDirPermission,
  inspectDirPermission,
  loadWorkbenchDirHandle,
  pickBundleFile,
  pickWorkbenchFolder,
  readTextFromDir,
  writeTextToDir,
  type DirectoryPermissionState,
} from '@/shared/analysis/folder';
import {
  analyzeBundleReport,
  PartialCollectionError,
  renderExistingReport,
  runReportPipeline,
  type CollectionMetrics,
  type ProgressEvent,
} from '@/shared/analysis/runReport';
import { testLlmConnection, LlmError, type LlmConnectionResult } from '@/shared/analysis/llm';
import { loadSettings, saveSettings, type AnalysisSettings } from '@/shared/analysis/settings';
import {
  clearPendingTask,
  historyEntryFromBundle,
  historyEntryFromTask,
  listTaskHistory,
  setPendingTask,
  takePendingTask,
  updateTaskHistory,
  upsertTaskHistory,
  type ReportTask,
  type TaskHistoryPatch,
  type TaskHistoryEntry,
  type TaskHistoryStatus,
} from '@/shared/analysis/task';
import { DEFAULT_SYSTEM, DEFAULT_USER_TEMPLATE } from '@/shared/analysis/prompts';
import { parseExportBundle } from '@/shared/analysis/bundle';
import { AnalysisResultValidationError } from '@/shared/analysis/validateResult';
import { sanitizeFilename } from '@/shared/utils/export-utils';
import { ApiError } from '@/types/messages';
import type { ExportBundle } from '@/types/zhihu';

type LogLine = { t: string; msg: string; level: 'info' | 'ok' | 'warn' | 'err' };
type WorkbenchView = 'workbench' | 'history';
type DrawerTab = 'connection' | 'prompt' | 'storage';
type ErrorKind = 'zhihu-403' | 'folder' | 'api-auth' | 'api-network' | 'analysis-schema' | 'missing-source' | 'unknown';

const STEPS = [
  { id: 'setup', label: '准备环境', desc: '连接与本地目录' },
  { id: 'collect', label: '采集评论', desc: '回答正文与评论树' },
  { id: 'save', label: '保存数据', desc: '写入 bundle.json' },
  { id: 'analyze', label: '模型分析', desc: '议题树、态度与摘要' },
  { id: 'render', label: '生成报告', desc: 'HTML 分析报告' },
  { id: 'done', label: '完成', desc: '报告已可阅读' },
] as const;

const ERROR_LABELS: Record<ErrorKind, string> = {
  'zhihu-403': '知乎访问受限',
  folder: '目录权限失效',
  'api-auth': 'API 认证失败',
  'api-network': 'API 连接失败',
  'analysis-schema': '模型结果需要修复',
  'missing-source': '来源页面不可用',
  unknown: '任务没有完成',
};

function nowTs() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNumber(value: number | null | undefined) {
  return value == null ? '—' : value.toLocaleString('zh-CN');
}

function statusLabel(status: TaskHistoryStatus) {
  return {
    queued: '待处理',
    running: '进行中',
    partial: '部分完成',
    failed: '失败',
    completed: '已完成',
  }[status];
}

function completenessLabel(status: ExportBundle['completeness']['status'] | undefined) {
  return status === 'complete' ? '完整' : status === 'partial' ? '部分' : '待确认';
}

function permissionLabel(state: DirectoryPermissionState) {
  return {
    granted: '已授权',
    prompt: '需要授权',
    denied: '已拒绝',
    missing: '未选择',
    unknown: '待检查',
  }[state];
}

function metricsFromBundle(bundle: ExportBundle): CollectionMetrics {
  return {
    rootCount: bundle.stats.root_count,
    totalNodes: bundle.stats.total_nodes,
    childRequests: bundle.completeness.child_requests,
    childCompleted: bundle.completeness.child_completed,
    childFailed: bundle.completeness.child_failed_ids.length,
    childSkipped: bundle.completeness.child_skipped_ids.length,
    childPaginationIncomplete: bundle.completeness.child_pagination_incomplete_ids.length,
    rootPages: bundle.completeness.root_pages,
    rootPaginationComplete: bundle.completeness.root_pagination_complete,
    rateLimited: bundle.completeness.rate_limited,
    completenessStatus: bundle.completeness.status,
    expectedCommentCount: bundle.completeness.expected_comment_count,
  };
}

function classifyError(error: unknown): ErrorKind {
  if ((error instanceof ApiError && error.httpStatus === 403)
    || (error instanceof PartialCollectionError && error.bundle.completeness.rate_limited)
    || (error instanceof Error && /知乎限流|验证码|HTTP 403|403/.test(error.message))) {
    return 'zhihu-403';
  }
  if (error instanceof LlmError) {
    if (error.category === 'auth') return 'api-auth';
    if (error.category === 'network' || error.category === 'server' || error.category === 'rate_limit') return 'api-network';
    if (error.category === 'invalid_json') return 'analysis-schema';
    if (error.category === 'config') return 'api-auth';
  }
  if (error instanceof AnalysisResultValidationError || (error instanceof Error && /模型结果校验|无法解析模型 JSON|响应缺少 content/.test(error.message))) {
    return 'analysis-schema';
  }
  if (error instanceof Error && /目录|权限|FileSystem|NotAllowedError/.test(error.message)) return 'folder';
  if (error instanceof Error && /JSON|Unexpected token/.test(error.message)) return 'analysis-schema';
  if (error instanceof Error && /页面|来源|没有可执行/.test(error.message)) return 'missing-source';
  return 'unknown';
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function statusClass(status: TaskHistoryStatus) {
  return `status-dot status-${status}`;
}

function getReportFilename(reportFile: string, bundleFile: string | undefined, title: string) {
  if (reportFile) return reportFile;
  if (bundleFile) return `${bundleFile.replace(/\.bundle\.json$/i, '')}.report.html`;
  return `${sanitizeFilename(title || '知乎分析报告')}.report.html`;
}

export function WorkbenchApp() {
  const [settings, setSettings] = useState<AnalysisSettings | null>(null);
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null);
  const [folderPermission, setFolderPermission] = useState<DirectoryPermissionState>('missing');
  const [task, setTask] = useState<ReportTask | null>(null);
  const [bundleSelection, setBundleSelection] = useState<{ name: string; bundle: ExportBundle } | null>(null);
  const [history, setHistory] = useState<TaskHistoryEntry[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState('');
  const [view, setView] = useState<WorkbenchView>('workbench');
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<string>('setup');
  const [percent, setPercent] = useState(0);
  const [metrics, setMetrics] = useState<CollectionMetrics | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [reportHtml, setReportHtml] = useState('');
  const [reportFile, setReportFile] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('connection');
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState<ErrorKind>('unknown');
  const [failedStep, setFailedStep] = useState<string>('collect');
  const [connectionTest, setConnectionTest] = useState<LlmConnectionResult | null>(null);
  const [manualModel, setManualModel] = useState(false);
  const [promptNotice, setPromptNotice] = useState('');
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const logEnd = useRef<HTMLDivElement>(null);

  const pushLog = useCallback((msg: string, level: LogLine['level'] = 'info') => {
    setLogs((prev) => [...prev.slice(-119), { t: nowTs(), msg, level }]);
  }, []);

  const refreshHistory = useCallback(async () => {
    setHistory(await listTaskHistory());
  }, []);

  const setFailure = useCallback((cause: unknown, prefix = '') => {
    const message = getErrorMessage(cause);
    setError(prefix ? `${prefix}${message}` : message);
    setErrorKind(classifyError(cause));
    return message;
  }, []);

  useEffect(() => {
    (async () => {
      const [loadedSettings, savedDir, loadedHistory] = await Promise.all([
        loadSettings(),
        loadWorkbenchDirHandle(),
        listTaskHistory(),
      ]);
      setSettings(loadedSettings);
      setHistory(loadedHistory);
      setDir(savedDir);
      setFolderPermission(await inspectDirPermission(savedDir));

      const pending = await takePendingTask();
      setTask(pending);
      if (pending) {
        setActiveHistoryId(pending.id);
        pushLog(`已预填任务：${pending.content.title}。确认连接与目录后点击「启动」。`, 'ok');
        if (pending.mode === 'analyze' && pending.bundleFile && savedDir) {
          try {
            setBundleSelection({
              name: pending.bundleFile,
              bundle: parseExportBundle(await readTextFromDir(savedDir, pending.bundleFile)),
            });
            pushLog(`已恢复部分 bundle：${pending.bundleFile}`, 'warn');
          } catch (cause) {
            pushLog(`无法恢复已保存 bundle：${getErrorMessage(cause)}`, 'warn');
          }
        }
      } else {
        pushLog('工作台可随时打开。可从工具栏图标进入，或从知乎页「打开工作台」预填任务后点「启动」。', 'warn');
      }
      setReady(true);
    })().catch((cause) => {
      setFailure(cause);
      pushLog(getErrorMessage(cause), 'err');
      setReady(true);
    });
  }, [pushLog, setFailure]);

  const setupOk = Boolean(settings?.apiKey.trim() && dir && folderPermission === 'granted');
  const hasRunnable = Boolean(task || bundleSelection);
  const currentTitle = bundleSelection?.bundle.answer.question_title || task?.content.title || '还没有活动任务';
  const currentAuthor = bundleSelection?.bundle.answer.author.name || task?.content.author || '等待知乎任务';
  const currentUrl = bundleSelection?.bundle.source.url || task?.content.url || '';
  const currentMetrics = metrics || (bundleSelection ? metricsFromBundle(bundleSelection.bundle) : null);
  const visibleLogs = logs.slice(-6);
  const currentReportFilename = getReportFilename(reportFile, bundleSelection?.name, currentTitle);
  const currentStatus: TaskHistoryStatus = running
    ? 'running'
    : step === 'done'
      ? 'completed'
      : error
        ? (
          bundleSelection?.bundle.completeness.status === 'partial'
            || metrics?.completenessStatus === 'partial'
            || task?.mode === 'analyze'
        )
          ? 'partial'
          : 'failed'
        : task?.mode === 'analyze'
          ? 'partial'
          : 'queued';

  const stepState = useMemo(() => {
    const order = STEPS.map((item) => item.id);
    const idx = order.indexOf(step as (typeof order)[number]);
    return STEPS.map((item, index) => {
      if (step === 'error') {
        const failedIndex = Math.max(0, order.indexOf(failedStep as (typeof order)[number]));
        return { ...item, state: index < failedIndex ? 'done' : index === failedIndex ? 'error' : '' };
      }
      if (step === 'done') return { ...item, state: 'done' };
      if (index < idx) return { ...item, state: 'done' };
      if (index === idx) return { ...item, state: 'active' };
      return { ...item, state: '' };
    });
  }, [step, failedStep]);

  const updateHistoryForCurrent = useCallback(async (patch: TaskHistoryPatch) => {
    const id = activeHistoryId || task?.id || (bundleSelection ? `bundle:${bundleSelection.name}` : '');
    if (!id) return;
    let updated: TaskHistoryEntry | null = await updateTaskHistory(id, patch);
    if (!updated && task) {
      updated = historyEntryFromTask(task, patch);
      await upsertTaskHistory(updated);
    } else if (!updated && bundleSelection) {
      updated = historyEntryFromBundle(id, bundleSelection.bundle, patch);
      await upsertTaskHistory(updated);
    }
    await refreshHistory();
  }, [activeHistoryId, task, bundleSelection, refreshHistory]);

  const updateSetting = <K extends keyof AnalysisSettings>(key: K, value: AnalysisSettings[K]) => {
    setSettings((previous) => {
      if (!previous) return previous;
      const next = { ...previous, [key]: value };
      // 模型下拉切换时立即落盘，避免只改选项未点保存就丢失。
      if (key === 'model') void saveSettings(next);
      return next;
    });
    if (key !== 'model') setConnectionTest(null);
  };

  const persistSettings = async (next: AnalysisSettings) => {
    setSettings(next);
    await saveSettings(next);
    pushLog('设置已保存', 'ok');
  };

  const applyProgress = useCallback((event: ProgressEvent) => {
    if (event.step !== 'done' && event.step !== 'error') setFailedStep(event.step);
    setStep(event.step === 'done' ? 'done' : event.step === 'error' ? 'error' : event.step);
    if (typeof event.percent === 'number') setPercent(event.percent);
    if (event.metrics) setMetrics((previous) => ({ ...previous, ...event.metrics } as CollectionMetrics));
    pushLog(event.message, event.step === 'done' ? 'ok' : event.step === 'error' ? 'err' : 'info');
  }, [pushLog]);

  const onPickBundle = async () => {
    const picked = await pickBundleFile();
    if (!picked) {
      pushLog('未选择 bundle 文件', 'warn');
      return;
    }
    try {
      const bundle = parseExportBundle(picked.text);
      setTask(null);
      setBundleSelection({ name: picked.name, bundle });
      setActiveHistoryId(`bundle:${picked.name}`);
      setMetrics(metricsFromBundle(bundle));
      setReportHtml('');
      setReportFile('');
      setReportOpen(false);
      setError('');
      setStep('setup');
      setPercent(0);
      await upsertTaskHistory(historyEntryFromBundle(`bundle:${picked.name}`, bundle, {
        bundleFile: picked.name,
        completenessStatus: bundle.completeness.status,
        commentCount: bundle.stats.total_nodes,
      }));
      await refreshHistory();
      pushLog(`已载入 bundle：${picked.name}（${bundle.stats.total_nodes} 个评论节点）`, 'ok');
    } catch (cause) {
      setFailure(cause);
      pushLog(getErrorMessage(cause), 'err');
    }
  };

  const hydratePendingBundle = async (handle: FileSystemDirectoryHandle | null, pending: ReportTask | null = task) => {
    if (!handle || !pending || pending.mode !== 'analyze' || !pending.bundleFile) return;
    try {
      const bundle = parseExportBundle(await readTextFromDir(handle, pending.bundleFile));
      setBundleSelection({ name: pending.bundleFile, bundle });
      setMetrics(metricsFromBundle(bundle));
      pushLog(`已恢复部分 bundle：${pending.bundleFile}`, 'warn');
    } catch (cause) {
      pushLog(`无法恢复已保存 bundle：${getErrorMessage(cause)}`, 'warn');
    }
  };

  const onPickFolder = async () => {
    const handle = await pickWorkbenchFolder();
    if (!handle) {
      pushLog('未选择目录', 'warn');
      return;
    }
    setDir(handle);
    setFolderPermission(await inspectDirPermission(handle));
    if (settings) {
      await saveSettings({ folderName: handle.name });
      setSettings({ ...settings, folderName: handle.name });
    }
    await hydratePendingBundle(handle);
    pushLog(`数据目录已设置：${handle.name}`, 'ok');
  };

  const authorizeFolder = async () => {
    if (!dir) {
      await onPickFolder();
      return;
    }
    const permitted = await ensureDirPermission(dir);
    if (!permitted) {
      setFolderPermission(await inspectDirPermission(dir));
      setFailure(new Error('目录权限未获批准，请重新选择一个可写目录。'));
      pushLog('目录权限未获批准', 'err');
      return;
    }
    setDir(permitted);
    setFolderPermission('granted');
    await hydratePendingBundle(permitted);
    setError('');
    pushLog('目录权限已恢复', 'ok');
  };

  const testConnection = async () => {
    if (!settings) return;
    await saveSettings(settings);
    setConnectionTest({ ok: false, latencyMs: 0, message: '正在连接…' });
    const result = await testLlmConnection(settings);
    setConnectionTest(result);
    setManualModel(false);
    pushLog(result.message, result.ok ? 'ok' : 'err');
  };

  const jumpToLatestLog = () => {
    setLogViewerOpen(true);
    window.setTimeout(() => logEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
  };

  const openReportInNewWindow = () => {
    if (!reportHtml) return;
    const url = URL.createObjectURL(new Blob([reportHtml], { type: 'text/html;charset=utf-8' }));
    // 不要用 features 里的 noopener：部分浏览器会返回 null，导致误判并立刻 revoke blob。
    const popup = window.open(url, '_blank');
    if (!popup) {
      URL.revokeObjectURL(url);
      setFailure(new Error('浏览器阻止了新窗口，请允许工作台打开报告页面。'));
      return;
    }
    try {
      popup.opener = null;
    } catch {
      // 个别环境禁止写 opener，忽略即可。
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const dismissPendingTask = async () => {
    await clearPendingTask();
    setTask(null);
    setError('');
    pushLog('已忽略当前待处理任务；可从任务历史重新打开。', 'warn');
    await refreshHistory();
  };

  const downloadReport = () => {
    if (!reportHtml) return;
    const url = URL.createObjectURL(new Blob([reportHtml], { type: 'text/html;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = currentReportFilename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    pushLog(`已下载报告：${currentReportFilename}`, 'ok');
  };

  const saveReportToFolder = async () => {
    if (!reportHtml || !dir) return;
    const permitted = await ensureDirPermission(dir);
    if (!permitted) {
      setFolderPermission(await inspectDirPermission(dir));
      setFailure(new Error('保存报告前需要恢复数据目录权限。'));
      setSettingsOpen(true);
      setDrawerTab('storage');
      return;
    }
    try {
      await writeTextToDir(permitted, currentReportFilename, reportHtml);
      setFolderPermission('granted');
      setReportFile(currentReportFilename);
      pushLog(`报告已保存到数据目录：${currentReportFilename}`, 'ok');
    } catch (cause) {
      setFailure(cause, '保存报告失败：');
      pushLog(`保存报告失败：${getErrorMessage(cause)}`, 'err');
    }
  };

  const savePrompts = async () => {
    if (!settings) return;
    const missing: string[] = [];
    if (!settings.userTemplate.includes('{validation}')) missing.push('{validation}');
    if (!settings.userTemplate.includes('{corpus}')) missing.push('{corpus}');
    if (missing.length) {
      setPromptNotice(`用户模板缺少占位符：${missing.join('、')}`);
      return;
    }
    setPromptNotice('');
    await persistSettings(settings);
  };

  const rerender = async () => {
    if (!dir || !bundleSelection || running) return;
    setRunning(true);
    setError('');
    setFailedStep('render');
    setStep('render');
    try {
      const baseName = bundleSelection.name.replace(/\.bundle\.json$/i, '');
      const raw = JSON.parse(await readTextFromDir(dir, `${baseName}.llm_raw.json`)) as Record<string, unknown>;
      const result = await renderExistingReport({
        bundle: bundleSelection.bundle,
        bundleFileName: bundleSelection.name,
        result: raw,
        dir,
        onProgress: applyProgress,
      });
      setReportHtml(result.reportHtml);
      setReportFile(result.reportPath);
      setMetrics(result.metrics);
      setStep('done');
      await updateHistoryForCurrent({
        status: 'completed',
        reportFile: result.reportPath,
        bundleFile: result.bundlePath,
        commentCount: result.commentCount,
        completenessStatus: result.completenessStatus,
        lastError: undefined,
      });
      pushLog(`已重新生成 HTML：${result.reportPath}`, 'ok');
    } catch (cause) {
      const message = setFailure(cause, '重新渲染失败：');
      setStep('error');
      await updateHistoryForCurrent({ status: 'failed', lastError: message });
      pushLog(`重新渲染失败：${message}`, 'err');
    } finally {
      setRunning(false);
    }
  };

  const start = useCallback(async () => {
    if (!settings || !dir || (!task && !bundleSelection) || running) return;
    if (!settings.apiKey.trim()) {
      setFailure(new Error('请先填写 API Key'));
      setSettingsOpen(true);
      setDrawerTab('connection');
      return;
    }
    const permitted = await ensureDirPermission(dir);
    if (!permitted) {
      setFolderPermission(await inspectDirPermission(dir));
      setFailure(new Error('目录权限失效，请点击“恢复权限”或重新选择数据目录。'));
      setSettingsOpen(true);
      setDrawerTab('storage');
      return;
    }
    setFolderPermission('granted');
    setRunning(true);
    setError('');
    setReportHtml('');
    setReportFile('');
    setReportOpen(false);
    setMetrics(bundleSelection ? metricsFromBundle(bundleSelection.bundle) : null);
    const isAnalyzeOnly = Boolean(bundleSelection || task?.mode === 'analyze');
    setStep(isAnalyzeOnly ? 'analyze' : 'collect');
    setPercent(5);
    if (task) {
      await updateHistoryForCurrent({ status: 'running', mode: isAnalyzeOnly ? 'analyze' : 'collect', bundleFile: task.bundleFile });
    } else if (bundleSelection) {
      await updateHistoryForCurrent({ status: 'running', mode: 'analyze', bundleFile: bundleSelection.name });
    }
    pushLog(isAnalyzeOnly ? '开始分析已有 bundle…' : '开始采集和分析流水线…', 'ok');

    try {
      let result: Awaited<ReturnType<typeof analyzeBundleReport>>;
      if (bundleSelection) {
        result = await analyzeBundleReport({
          bundle: bundleSelection.bundle,
          bundleFileName: bundleSelection.name,
          dir: permitted,
          settings,
          onProgress: applyProgress,
        });
      } else if (task?.mode === 'analyze' && task.bundleFile) {
        const bundle = parseExportBundle(await readTextFromDir(permitted, task.bundleFile));
        result = await analyzeBundleReport({
          bundle,
          bundleFileName: task.bundleFile,
          dir: permitted,
          settings,
          onProgress: applyProgress,
        });
      } else if (task) {
        result = await runReportPipeline({
          content: task.content,
          pageInfo: task.pageInfo,
          dir: permitted,
          settings,
          onProgress: applyProgress,
        });
      } else {
        throw new Error('没有可执行的任务或 bundle');
      }
      setStep('done');
      setPercent(100);
      setReportHtml(result.reportHtml);
      setReportFile(result.reportPath);
      setMetrics(result.metrics);
      setBundleSelection({ name: result.bundlePath, bundle: result.bundle });
      await clearPendingTask();
      await updateHistoryForCurrent({
        status: 'completed',
        mode: isAnalyzeOnly ? 'analyze' : 'collect',
        bundleFile: result.bundlePath,
        reportFile: result.reportPath,
        commentCount: result.commentCount,
        completenessStatus: result.completenessStatus,
        analysisWarnings: result.analysisWarnings,
        lastError: undefined,
      });
      pushLog(`完成：${result.reportPath}（${result.commentCount} 个评论节点，数据${completenessLabel(result.completenessStatus)}）`, 'ok');
    } catch (cause) {
      const message = setFailure(cause);
      setStep('error');
      await updateHistoryForCurrent({ status: cause instanceof PartialCollectionError ? 'partial' : 'failed', lastError: message });
      pushLog(message, 'err');
      if (cause instanceof PartialCollectionError && task) {
        const resumableTask = { ...task, mode: 'analyze' as const, bundleFile: cause.bundleFile };
        await setPendingTask(resumableTask);
        setTask(resumableTask);
        setBundleSelection({ name: cause.bundleFile, bundle: cause.bundle });
        setMetrics(metricsFromBundle(cause.bundle));
        await updateHistoryForCurrent({
          status: 'partial',
          mode: 'analyze',
          bundleFile: cause.bundleFile,
          commentCount: cause.bundle.stats.total_nodes,
          completenessStatus: cause.bundle.completeness.status,
          lastError: message,
        });
        pushLog('部分 bundle 已保留，可直接重新分析；若要重试知乎采集，请先完成验证后切换为重新采集。', 'warn');
      } else {
        // 终态失败不再保留 pending，避免每次打开工作台自动重跑同一失败任务。
        await clearPendingTask();
      }
    } finally {
      setRunning(false);
      await refreshHistory();
    }
  }, [settings, dir, task, bundleSelection, running, applyProgress, setFailure, updateHistoryForCurrent, pushLog, refreshHistory]);

  const retryCollection = async () => {
    if (!task) return;
    const freshTask: ReportTask = { ...task, mode: 'collect', bundleFile: undefined };
    await setPendingTask(freshTask);
    setTask(freshTask);
    setBundleSelection(null);
    setMetrics(null);
    setError('');
    setStep('collect');
    setActiveHistoryId(freshTask.id);
    await refreshHistory();
    pushLog('已切换为重新采集模式，现有部分 bundle 未删除。', 'warn');
  };

  const openSource = () => {
    if (currentUrl) window.open(currentUrl, '_blank', 'noopener,noreferrer');
  };

  const openErrorTarget = () => {
    if (errorKind === 'zhihu-403' || errorKind === 'missing-source') openSource();
    if (errorKind === 'folder') {
      setSettingsOpen(true);
      setDrawerTab('storage');
    }
    if (errorKind === 'api-auth' || errorKind === 'api-network') {
      setSettingsOpen(true);
      setDrawerTab('connection');
    }
    if (errorKind === 'analysis-schema') {
      setSettingsOpen(true);
      setDrawerTab('prompt');
    }
  };

  const loadHistoryEntry = async (entry: TaskHistoryEntry, analyze = false) => {
    setActiveHistoryId(entry.id);
    if (!dir || folderPermission !== 'granted') {
      setSettingsOpen(true);
      setDrawerTab('storage');
      setFailure(new Error('请先授权数据目录，才能读取这条历史任务。'));
      return;
    }
    try {
      let selectedBundle: { name: string; bundle: ExportBundle } | null = null;
      if (entry.bundleFile) {
        selectedBundle = {
          name: entry.bundleFile,
          bundle: parseExportBundle(await readTextFromDir(dir, entry.bundleFile)),
        };
        setBundleSelection(selectedBundle);
        setMetrics(metricsFromBundle(selectedBundle.bundle));
      }
      if (entry.reportFile && !analyze) {
        setReportHtml(await readTextFromDir(dir, entry.reportFile));
        setReportFile(entry.reportFile);
        setStep('done');
        setPercent(100);
      } else {
        setReportHtml('');
        setReportFile('');
        setStep(selectedBundle ? 'setup' : 'error');
        setPercent(selectedBundle ? 0 : 0);
      }
      setTask(null);
      setBundleSelection(selectedBundle);
      setError('');
      setView('workbench');
      pushLog(analyze ? `已载入历史任务，准备重新分析：${entry.title}` : `已打开历史任务：${entry.title}`, 'ok');
    } catch (cause) {
      setFailure(cause, '读取历史任务失败：');
      pushLog(`读取历史任务失败：${getErrorMessage(cause)}`, 'err');
    }
  };

  if (!ready || !settings) {
    return (
      <div className="app loading-screen">
        <div className="loading-mark">ZA</div>
        <div><strong>知乎分析工作台</strong><span>正在恢复本地任务状态…</span></div>
      </div>
    );
  }

  const runnableLabel = running
    ? '处理中…'
    : bundleSelection || task?.mode === 'analyze'
      ? '启动分析'
      : '启动';
  const sourceHost = currentUrl ? (() => { try { return new URL(currentUrl).hostname; } catch { return currentUrl; } })() : '等待来源';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">ZA</div>
          <div className="brand-copy">
            <span className="eyebrow">LOCAL ANALYSIS WORKBENCH</span>
            <strong>知乎分析工作台</strong>
          </div>
        </div>
        <div className="topbar-actions">
          <button type="button" className="connection-chip" onClick={() => { setSettingsOpen(true); setDrawerTab('connection'); }}>
            <i className={`signal-dot ${connectionTest?.ok ? 'is-good' : settings.apiKey ? 'is-ready' : ''}`} />
            {connectionTest?.ok ? 'API 已连接' : settings.apiKey ? 'API 未测试' : '未配置 API'}
          </button>
          <button type="button" className="icon-button" title="打开设置" aria-label="打开设置" onClick={() => setSettingsOpen(true)}>☷</button>
          <button type="button" className="btn btn-primary top-action" disabled={!setupOk || !hasRunnable || running} onClick={() => void start()}>
            {runnableLabel}
          </button>
        </div>
      </header>

      <div className="shell">
        <nav className="rail" aria-label="工作台导航">
          <div className="rail-section-label">SPACE</div>
          <button type="button" className={`rail-button ${view === 'workbench' ? 'active' : ''}`} onClick={() => setView('workbench')}>
            <span className="rail-icon">◈</span><span>当前任务</span>
          </button>
          <button type="button" className={`rail-button ${view === 'history' ? 'active' : ''}`} onClick={() => { setView('history'); void refreshHistory(); }}>
            <span className="rail-icon">◷</span><span>任务历史</span><b>{history.length}</b>
          </button>
          <div className="rail-divider" />
          <div className="rail-section-label">LOCAL</div>
          <button type="button" className="rail-button" onClick={() => { setSettingsOpen(true); setDrawerTab('storage'); }}>
            <span className={`rail-status ${folderPermission === 'granted' ? 'good' : 'warn'}`} /><span>数据目录</span>
          </button>
          <button type="button" className="rail-button" onClick={() => { setSettingsOpen(true); setDrawerTab('connection'); }}>
            <span className={`rail-status ${settings.apiKey ? 'good' : 'warn'}`} /><span>模型连接</span>
          </button>
          <div className="rail-bottom">
            <span className="mini-label">DATA STAYS LOCAL</span>
            <span className="rail-folder-name" title={dir?.name || settings.folderName}>{dir?.name || settings.folderName || '未选择目录'}</span>
          </div>
        </nav>

        <main className="workspace">
          {view === 'history' ? (
            <section className="history-view">
              <div className="page-heading">
                <div><span className="eyebrow">RECENT RUNS</span><h1>任务历史</h1><p>这里保存的是任务摘要，报告与 bundle 仍在你选择的本地目录中。</p></div>
                <div className="heading-actions"><button type="button" className="btn btn-secondary" onClick={() => void onPickBundle()}>载入 bundle</button><button type="button" className="btn btn-secondary" onClick={() => void refreshHistory()}>刷新</button></div>
              </div>
              {history.length === 0 ? (
                <div className="empty-state large-empty"><span className="empty-icon">◷</span><h2>还没有历史任务</h2><p>从知乎页「打开工作台」并点「启动」完成后，记录会出现在这里；也可随时用工具栏图标打开本控制台。</p></div>
              ) : (
                <div className="history-list">
                  {history.map((entry) => (
                    <article className="history-row" key={entry.id}>
                      <div className={statusClass(entry.status)} />
                      <div className="history-main">
                        <div className="history-title-line"><h2>{entry.title}</h2><span className={`tag tag-${entry.status}`}>{statusLabel(entry.status)}</span></div>
                        <div className="history-meta"><span>{entry.author}</span><span>{entry.pageType}</span><span>{formatDate(entry.updatedAt)}</span>{entry.commentCount != null && <span>{formatNumber(entry.commentCount)} 节点</span>}</div>
                        <div className="history-url">{entry.url || '无来源链接'}</div>
                        {entry.lastError && <div className="history-error">{entry.lastError}</div>}
                      </div>
                      <div className="history-actions">
                        <button type="button" className="btn btn-secondary" onClick={() => void loadHistoryEntry(entry)}>打开</button>
                        {entry.bundleFile && <button type="button" className="btn btn-primary" onClick={() => void loadHistoryEntry(entry, true)}>重新分析</button>}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <div className="dashboard">
              <section className="task-hero">
                <div className="hero-copy">
                  <div className="hero-kicker"><span className={`tag tag-${currentStatus}`}>{statusLabel(currentStatus)}</span><span className="hero-source">{sourceHost}</span></div>
                  <h1>{currentTitle}</h1>
                  <p className="hero-author">{currentAuthor}<span>·</span>{bundleSelection ? 'bundle 已载入' : task ? '知乎任务' : '等待任务'}</p>
                  {currentUrl && <a className="source-link" href={currentUrl} target="_blank" rel="noreferrer">打开来源 <span>↗</span></a>}
                </div>
                <div className="hero-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => void onPickBundle()}>载入 bundle</button>
                  <button type="button" className="btn btn-secondary" disabled={!bundleSelection || !dir || running} onClick={() => void rerender()}>重新渲染</button>
                  <button type="button" className="btn btn-primary" disabled={!setupOk || !hasRunnable || running} onClick={() => void start()}>{runnableLabel}</button>
                </div>
              </section>

              <section className="panel pipeline-panel">
                <div className="panel-heading"><div><span className="eyebrow">PIPELINE</span><h2>处理流程</h2></div><strong className="percent-label">{percent}%</strong></div>
                <div className="progress-line"><i style={{ width: `${percent}%` }} /></div>
                <div className="timeline">
                  {stepState.map((item) => <div className={`timeline-item ${item.state}`} key={item.id}><span className="timeline-dot">{item.state === 'done' ? '✓' : item.state === 'error' ? '!' : ''}</span><div><strong>{item.label}</strong><span>{item.desc}</span></div></div>)}
                </div>
              </section>

              <section className="dashboard-body">
                <div className="dashboard-main">
                  <div className="dashboard-notices">
                    {!setupOk && <section className="setup-strip"><div className="setup-icon">!</div><div><strong>{!settings.apiKey.trim() ? '先配置模型连接' : folderPermission !== 'granted' ? '先授权数据目录' : '准备工作台'}</strong><span>{!settings.apiKey.trim() ? '填写 API Key 后测试连接，再点「启动」。' : '浏览器需要一次明确的用户操作来恢复本地目录权限。'}</span></div><button type="button" className="btn btn-secondary" onClick={() => { setSettingsOpen(true); setDrawerTab(!settings.apiKey.trim() ? 'connection' : 'storage'); }}>{!settings.apiKey.trim() ? '打开连接设置' : '恢复目录权限'}</button></section>}
                    {setupOk && hasRunnable && !running && !error && step !== 'done' && <section className="setup-strip ready-strip"><div className="setup-icon">▶</div><div><strong>任务已就绪，等待启动</strong><span>不会自动执行。确认模型、目录与任务来源后，点击「{runnableLabel}」开始生成报告。</span></div><button type="button" className="btn btn-primary" onClick={() => void start()}>{runnableLabel}</button></section>}
                    {error && <section className={`error-panel error-${errorKind}`}><div className="error-icon">!</div><div className="error-copy"><span className="eyebrow">{ERROR_LABELS[errorKind]}</span><strong>{error}</strong><p>{errorKind === 'zhihu-403' ? '请在知乎页面完成验证或刷新来源页面，再回到这里重试。' : errorKind === 'analysis-schema' ? '可以先调整提示词或恢复默认模板，然后重新分析；已有 bundle 不会被删除。' : errorKind === 'folder' ? '目录权限只能由用户点击按钮恢复，工作台不会在页面加载时擅自弹窗。' : errorKind === 'api-auth' || errorKind === 'api-network' ? '检查 Base URL、模型和 API Key，先测试连接再重试。' : '可以查看诊断日志，或从任务历史重新打开 bundle。'}</p></div><div className="error-actions"><button type="button" className="btn btn-secondary" onClick={openErrorTarget}>{errorKind === 'zhihu-403' || errorKind === 'missing-source' ? '打开来源' : errorKind === 'folder' ? '恢复权限' : errorKind === 'analysis-schema' ? '打开提示词' : '打开设置'}</button>{errorKind === 'zhihu-403' && task?.mode === 'analyze' && <button type="button" className="btn btn-secondary" onClick={() => void retryCollection()}>改为重新采集</button>}{task && !running && <button type="button" className="btn btn-secondary" onClick={() => void dismissPendingTask()}>忽略任务</button>}<button type="button" className="btn btn-primary" disabled={!setupOk || !hasRunnable || running} onClick={() => void start()}>重试</button></div></section>}
                  </div>

                  <section className="metric-grid" aria-label="采集指标">
                    <MetricCard label="评论节点" value={formatNumber(currentMetrics?.totalNodes)} detail={currentMetrics?.expectedCommentCount != null ? `声明值 ${formatNumber(currentMetrics.expectedCommentCount)}` : '实际抓取总数'} accent="blue" />
                    <MetricCard label="一级评论" value={formatNumber(currentMetrics?.rootCount)} detail={currentMetrics ? `${currentMetrics.rootPages} 页根评论` : '等待采集'} accent="cyan" />
                    <MetricCard label="楼中楼" value={currentMetrics ? `${currentMetrics.childCompleted}/${currentMetrics.childRequests}` : '—'} detail={currentMetrics?.childFailed || currentMetrics?.childSkipped ? `失败 ${currentMetrics.childFailed} · 跳过 ${currentMetrics.childSkipped}` : '请求完成数 / 请求总数'} accent="violet" />
                    <MetricCard label="数据完整性" value={currentMetrics ? completenessLabel(currentMetrics.completenessStatus) : '待确认'} detail={currentMetrics?.rateLimited ? '检测到 403 限流' : currentMetrics?.rootPaginationComplete ? '根评论分页已结束' : '分页状态待确认'} accent={currentMetrics?.completenessStatus === 'partial' ? 'amber' : 'green'} />
                    <MetricCard label="模型输入" value={currentMetrics?.modelInputChars ? `${formatNumber(currentMetrics.modelInputChars)} 字` : '—'} detail={currentMetrics?.modelInputChars ? '发送给模型的语料长度' : '分析开始后显示'} accent="pink" />
                  </section>

                  <section className="panel report-panel">
                    <div className="panel-heading"><div><span className="eyebrow">OUTPUT</span><h2>分析报告</h2></div>{reportHtml && <span className="live-label"><i />已生成</span>}</div>
                    {reportHtml ? <div className="report-ready"><div className="report-ready-icon">◫</div><div className="report-ready-copy"><strong>{currentReportFilename}</strong><span>报告已生成，选择一种阅读方式</span></div><div className="report-actions"><button type="button" className="btn btn-primary" onClick={() => setReportOpen(true)}>展开阅读</button><button type="button" className="btn btn-secondary" onClick={openReportInNewWindow}>新窗口打开</button><button type="button" className="btn btn-secondary" onClick={downloadReport}>下载报告</button><button type="button" className="btn btn-secondary" disabled={!dir} onClick={() => void saveReportToFolder()}>保存到目录</button></div></div> : <div className="empty-state"><span className="empty-icon">◫</span><h3>{hasRunnable ? '报告将在这里出现' : '等待一个分析任务'}</h3><p>{hasRunnable ? '点击「启动」后才会开始采集与分析；完成后可在此阅读、下载或保存。' : '从知乎页「打开工作台」预填任务，或载入已有 bundle。'}</p></div>}
                  </section>
                </div>

                <aside className="dashboard-side">
                  <section className="panel log-panel">
                    <div className="panel-heading"><div><span className="eyebrow">LIVE DIAGNOSTICS</span><h2>实时诊断</h2></div><div className="log-actions"><span className="log-count">{logs.length} 条</span><button type="button" className="text-button" onClick={() => setLogViewerOpen(true)}>查看全部</button>{logs.length > 6 && <button type="button" className="text-button" onClick={jumpToLatestLog}>最新</button>}</div></div>
                    <div className="log-stage"><span className={`stage-dot ${running ? 'running' : error ? 'error' : step === 'done' ? 'done' : 'idle'}`} /><span>{running ? `正在${STEPS.find((item) => item.id === step)?.label || '处理'}` : error ? ERROR_LABELS[errorKind] : step === 'done' ? '任务已完成' : '等待启动'}</span><strong>{percent}%</strong></div>
                    <div className="log-list">{visibleLogs.length ? visibleLogs.map((line, index) => <div className={`log-line ${line.level}`} key={`${line.t}-${index}`}><span>{line.t}</span><p>{line.msg}</p></div>) : <div className="log-empty">暂无日志</div>}</div>
                  </section>
                  <section className="panel quality-panel"><div className="panel-heading"><div><span className="eyebrow">COLLECTION HEALTH</span><h2>采集健康度</h2></div></div><QualityRow label="根评论分页" value={currentMetrics ? currentMetrics.rootPaginationComplete ? '已完成' : '未完成' : '—'} good={Boolean(currentMetrics?.rootPaginationComplete)} /><QualityRow label="楼中楼分页" value={currentMetrics ? currentMetrics.childPaginationIncomplete ? `${currentMetrics.childPaginationIncomplete} 条未完成` : '已完成' : '—'} good={Boolean(currentMetrics && currentMetrics.childPaginationIncomplete === 0)} /><QualityRow label="失败 / 跳过" value={currentMetrics ? `${currentMetrics.childFailed} / ${currentMetrics.childSkipped}` : '—'} good={Boolean(currentMetrics && currentMetrics.childFailed === 0 && currentMetrics.childSkipped === 0)} /><QualityRow label="限流状态" value={currentMetrics ? currentMetrics.rateLimited ? '需要处理' : '正常' : '—'} good={Boolean(currentMetrics && !currentMetrics.rateLimited)} /></section>
                  <section className="panel task-panel"><div className="panel-heading"><div><span className="eyebrow">TASK CONTEXT</span><h2>任务信息</h2></div></div><InfoRow label="数据目录" value={dir?.name || settings.folderName || '未选择'} /><InfoRow label="目录权限" value={permissionLabel(folderPermission)} tone={folderPermission === 'granted' ? 'good' : 'warn'} /><InfoRow label="当前来源" value={sourceHost} /><InfoRow label="任务模式" value={bundleSelection || task?.mode === 'analyze' ? '仅分析 bundle' : task ? '重新采集' : '无任务'} /></section>
                </aside>
              </section>
            </div>
          )}
        </main>
      </div>

      {reportOpen && reportHtml && (
        <div className="report-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReportOpen(false); }}>
          <section className="report-viewer" aria-label="报告阅读器">
            <header className="report-viewer-header">
              <div><span className="eyebrow">REPORT READER</span><strong>{currentReportFilename}</strong></div>
              <div className="report-viewer-actions"><button type="button" className="btn btn-secondary" onClick={downloadReport}>下载</button><button type="button" className="btn btn-secondary" onClick={() => void saveReportToFolder()}>保存到目录</button><button type="button" className="icon-button" title="关闭报告阅读器" aria-label="关闭报告阅读器" onClick={() => setReportOpen(false)}>×</button></div>
            </header>
            <iframe className="report-viewer-frame" title="知乎分析报告阅读器" srcDoc={reportHtml} />
          </section>
        </div>
      )}

      {logViewerOpen && (
        <div className="log-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setLogViewerOpen(false); }}>
          <section className="log-viewer" aria-label="完整诊断日志">
            <header className="log-viewer-header"><div><span className="eyebrow">DIAGNOSTICS</span><strong>完整诊断日志</strong><span>{logs.length} 条记录 · 主工作台不会跟随滚动</span></div><div className="report-viewer-actions"><button type="button" className="btn btn-secondary" onClick={jumpToLatestLog}>跳到最新</button><button type="button" className="icon-button" title="关闭诊断日志" aria-label="关闭诊断日志" onClick={() => setLogViewerOpen(false)}>×</button></div></header>
            <div className="log-viewer-list">{logs.length ? logs.map((line, index) => <div className={`log-line ${line.level}`} key={`${line.t}-${index}`}><span>{line.t}</span><p>{line.msg}</p></div>) : <div className="log-empty">暂无日志</div>}<div ref={logEnd} /></div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <aside className="settings-drawer" aria-label="工作台设置">
            <div className="drawer-heading"><div><span className="eyebrow">WORKSPACE SETTINGS</span><h2>设置</h2></div><button type="button" className="icon-button" title="关闭设置" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>×</button></div>
            <div className="drawer-tabs"><button type="button" className={drawerTab === 'connection' ? 'active' : ''} onClick={() => setDrawerTab('connection')}>连接</button><button type="button" className={drawerTab === 'prompt' ? 'active' : ''} onClick={() => setDrawerTab('prompt')}>提示词</button><button type="button" className={drawerTab === 'storage' ? 'active' : ''} onClick={() => setDrawerTab('storage')}>数据目录</button></div>
            <div className="drawer-body">
              {drawerTab === 'connection' && <div className="settings-section"><SettingIntro title="模型连接" copy="报告分析使用 OpenAI 兼容的 chat/completions 接口。" /><label className="field">API Key</label><input type="password" value={settings.apiKey} placeholder="sk-…" onChange={(event) => updateSetting('apiKey', event.target.value)} /><label className="field">API Base URL</label><input value={settings.baseUrl} onChange={(event) => updateSetting('baseUrl', event.target.value)} /><label className="field">模型</label>{connectionTest?.models?.length && !manualModel ? <select value={settings.model} onChange={(event) => updateSetting('model', event.target.value)}><option value={settings.model}>{connectionTest.models.includes(settings.model) ? settings.model : `${settings.model}（当前）`}</option>{connectionTest.models.filter((model) => model !== settings.model).map((model) => <option value={model} key={model}>{model}</option>)}</select> : <input value={settings.model} placeholder="输入模型名" onChange={(event) => updateSetting('model', event.target.value)} />}{connectionTest?.models?.length ? <button type="button" className="text-button model-toggle" onClick={() => setManualModel((value) => !value)}>{manualModel ? '使用测试返回的模型列表' : '手动输入模型名'}</button> : null}<div className="drawer-actions"><button type="button" className="btn btn-primary" onClick={() => void testConnection()} disabled={!settings.apiKey.trim()}>测试连接</button><button type="button" className="btn btn-secondary" onClick={() => void persistSettings(settings)}>保存</button></div>{connectionTest && <div className={`connection-result ${connectionTest.ok ? 'success' : 'failure'}`}><strong>{connectionTest.ok ? '连接成功' : '连接失败'}</strong><span>{connectionTest.message}</span>{connectionTest.models?.length ? <span className="model-list-hint">可选模型：{connectionTest.models.join('、')}</span> : null}</div>}</div>}
              {drawerTab === 'prompt' && <div className="settings-section"><SettingIntro title="分析提示词" copy="提示词只在工作台设置中编辑，运行中的任务不会被动态修改。" /><label className="field">System</label><textarea className="prompt-editor" value={settings.system} disabled={running} onChange={(event) => updateSetting('system', event.target.value)} /><label className="field">User 模板</label><textarea className="prompt-editor prompt-user" value={settings.userTemplate} disabled={running} onChange={(event) => updateSetting('userTemplate', event.target.value)} /><div className="placeholder-row"><span>必须保留</span><code>{'{validation}'}</code><code>{'{corpus}'}</code></div>{promptNotice && <div className="inline-notice">{promptNotice}</div>}<div className="drawer-actions"><button type="button" className="btn btn-primary" disabled={running} onClick={() => void savePrompts()}>保存提示词</button><button type="button" className="btn btn-secondary" disabled={running} onClick={() => void persistSettings({ ...settings, system: DEFAULT_SYSTEM, userTemplate: DEFAULT_USER_TEMPLATE })}>恢复默认</button></div></div>}
              {drawerTab === 'storage' && <div className="settings-section"><SettingIntro title="本地数据目录" copy="bundle、报告和模型原始结果保存在这个目录，不上传到工作台。" /><div className="directory-box"><span className={`permission-dot ${folderPermission === 'granted' ? 'good' : 'warn'}`} /><div><strong>{dir?.name || settings.folderName || '尚未选择目录'}</strong><span>{permissionLabel(folderPermission)}</span></div></div><div className="drawer-actions"><button type="button" className="btn btn-primary" onClick={() => void authorizeFolder()}>{dir ? '恢复权限' : '选择目录'}</button><button type="button" className="btn btn-secondary" onClick={() => void onPickFolder()}>更换目录</button></div><div className="storage-note">工作台启动时只查询权限状态，不会自动唤起授权弹窗。</div></div>}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, detail, accent }: { label: string; value: string; detail: string; accent: string }) {
  return <div className={`metric-card accent-${accent}`}><span className="metric-label">{label}</span><strong>{value}</strong><span className="metric-detail">{detail}</span></div>;
}

function QualityRow({ label, value, good }: { label: string; value: string; good: boolean }) {
  return <div className="quality-row"><span>{label}</span><strong className={good ? 'good-text' : 'warn-text'}><i className={`quality-dot ${good ? 'good' : 'warn'}`} />{value}</strong></div>;
}

function InfoRow({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div className="info-row"><span>{label}</span><strong className={tone}>{value}</strong></div>;
}

function SettingIntro({ title, copy }: { title: string; copy: string }) {
  return <div className="setting-intro"><h3>{title}</h3><p>{copy}</p></div>;
}
