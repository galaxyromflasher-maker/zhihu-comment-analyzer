import type {
  CommentFetchResult,
  ExportBundle,
  ExtractedContent,
  PageInfo,
} from '@/types/zhihu';
import { fetchAllComments } from '@/shared/api/zhihu-api';
import { buildExportBundle, stringifyBundle } from '@/shared/converters/json-export';
import { sanitizeFilename, TYPE_LABELS } from '@/shared/utils/export-utils';
import { buildCorpusFromBundle, countCommentNodes } from './corpus';
import { writeTextToDir } from './folder';
import { buildHtmlReport } from './htmlReport';
import { chatJson } from './llm';
import { renderUserPrompt } from './prompts';
import { assertValidAnalysisResult } from './validateResult';
import type { AnalysisSettings } from './settings';

export type StepId = 'setup' | 'collect' | 'save' | 'analyze' | 'render' | 'done' | 'error';

export interface ProgressEvent {
  step: StepId;
  message: string;
  percent?: number;
  metrics?: CollectionMetrics;
}

export interface CollectionMetrics {
  rootCount: number;
  totalNodes: number;
  childRequests: number;
  childCompleted: number;
  childFailed: number;
  childSkipped: number;
  childPaginationIncomplete: number;
  rootPages: number;
  rootPaginationComplete: boolean;
  rateLimited: boolean;
  completenessStatus?: ExportBundle['completeness']['status'];
  expectedCommentCount?: number | null;
  modelInputChars?: number;
}

export interface RunReportResult {
  bundlePath: string;
  reportPath: string;
  reportHtml: string;
  commentCount: number;
  completenessStatus: ExportBundle['completeness']['status'];
  analysisWarnings: string[];
  bundle: ExportBundle;
  metrics: CollectionMetrics;
}

export class PartialCollectionError extends Error {
  readonly bundleFile: string;
  readonly bundle: ExportBundle;

  constructor(bundleFile: string, bundle: ExportBundle) {
    super(`评论采集未完整结束，已保存部分 bundle：${bundleFile}`);
    this.name = 'PartialCollectionError';
    this.bundleFile = bundleFile;
    this.bundle = bundle;
  }
}

function getCommentIds(bundle: ExportBundle): Set<string> {
  const ids = new Set<string>();
  const walk = (nodes: ExportBundle['comments']) => {
    for (const node of nodes) {
      ids.add(node.id);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(bundle.comments || []);
  return ids;
}

function reportBaseName(bundleFileName: string): string {
  const base = bundleFileName.replace(/\.bundle\.json$/i, '');
  return sanitizeFilename(base || '知乎分析报告');
}

function metricsForBundle(bundle: ExportBundle, modelInputChars = 0): CollectionMetrics {
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
    modelInputChars,
  };
}

async function renderBundleAndWriteReport(opts: {
  bundle: ExportBundle;
  bundleFileName: string;
  dir: FileSystemDirectoryHandle;
  result: Record<string, unknown>;
  analysisWarnings?: string[];
  settings?: AnalysisSettings;
  corpusChars?: number;
  renderMessage?: string;
  onProgress: (e: ProgressEvent) => void;
}): Promise<RunReportResult> {
  const {
    bundle,
    bundleFileName,
    dir,
    result,
    analysisWarnings = [],
    settings,
    corpusChars = 0,
    renderMessage = '模型返回成功，正在渲染报告…',
    onProgress,
  } = opts;
  const baseName = reportBaseName(bundleFileName);
  const commentCount = bundle.stats.total_nodes;
  const metrics = metricsForBundle(bundle, corpusChars);
  onProgress({ step: 'render', message: renderMessage, percent: 88, metrics });

  const reportHtml = buildHtmlReport({
    title: bundle.answer.question_title,
    author: bundle.answer.author.name,
    url: bundle.source.url,
    commentCount,
    result,
    completeness: bundle.completeness,
    analysisWarnings,
  });
  const reportFile = `${baseName}.report.html`;
  await writeTextToDir(dir, reportFile, reportHtml);
  await writeTextToDir(dir, `${baseName}.llm_raw.json`, `${JSON.stringify(result, null, 2)}\n`);
  await writeTextToDir(
    dir,
    `${baseName}.analysis_meta.json`,
    `${JSON.stringify({
      model: settings?.model || 'unknown',
      base_url: settings?.baseUrl || '',
      generated_at: new Date().toISOString(),
      input_comment_count: commentCount,
      input_chars: corpusChars,
      completeness_status: bundle.completeness.status,
      validation_warnings: analysisWarnings,
    }, null, 2)}\n`,
  );

  onProgress({ step: 'done', message: '报告已生成', percent: 100 });
  return {
    bundlePath: bundleFileName,
    reportPath: reportFile,
    reportHtml,
    commentCount,
    completenessStatus: bundle.completeness.status,
    analysisWarnings,
    bundle,
    metrics,
  };
}

async function analyzeBundleAndWriteReport(opts: {
  bundle: ExportBundle;
  bundleFileName: string;
  dir: FileSystemDirectoryHandle;
  settings: AnalysisSettings;
  onProgress: (e: ProgressEvent) => void;
}): Promise<RunReportResult> {
  const { bundle, bundleFileName, dir, settings, onProgress } = opts;
  const commentCount = bundle.stats.total_nodes;
  const bundleMetrics = metricsForBundle(bundle);
  onProgress({
    step: 'analyze',
    message: `正在分析 bundle：${commentCount} 条评论节点…`,
    percent: 62,
    metrics: bundleMetrics,
  });
  const { corpus, validation } = buildCorpusFromBundle(bundle);
  const user = renderUserPrompt(settings.userTemplate, corpus, validation);
  onProgress({
    step: 'analyze',
    message: `已准备模型输入：${corpus.length.toLocaleString()} 字符，正在请求 ${settings.model || '默认模型'}…`,
    percent: 68,
    metrics: { ...bundleMetrics, modelInputChars: corpus.length },
  });
  const result = await chatJson(settings, settings.system, user);
  const resultValidation = assertValidAnalysisResult(result, getCommentIds(bundle));

  for (const warning of resultValidation.warnings) {
    onProgress({ step: 'analyze', message: `模型结果提醒：${warning}`, percent: 84 });
  }

  return renderBundleAndWriteReport({
    bundle,
    bundleFileName,
    dir,
    result,
    analysisWarnings: resultValidation.warnings,
    settings,
    corpusChars: corpus.length,
    onProgress,
  });
}

/** 对已经存在的 bundle 进行分析，不重新访问知乎。 */
export async function analyzeBundleReport(opts: {
  bundle: ExportBundle;
  bundleFileName: string;
  dir: FileSystemDirectoryHandle;
  settings: AnalysisSettings;
  onProgress: (e: ProgressEvent) => void;
}): Promise<RunReportResult> {
  return analyzeBundleAndWriteReport(opts);
}

/** 使用已有 llm_raw.json 重新渲染报告，不重新访问知乎或调用模型。 */
export async function renderExistingReport(opts: {
  bundle: ExportBundle;
  bundleFileName: string;
  result: Record<string, unknown>;
  dir: FileSystemDirectoryHandle;
  onProgress: (e: ProgressEvent) => void;
}): Promise<RunReportResult> {
  const validation = assertValidAnalysisResult(opts.result, getCommentIds(opts.bundle));
  return renderBundleAndWriteReport({
    ...opts,
    analysisWarnings: validation.warnings,
    renderMessage: '正在使用已有分析结果重新渲染报告…',
  });
}

export async function runReportPipeline(opts: {
  content: ExtractedContent;
  pageInfo: PageInfo;
  dir: FileSystemDirectoryHandle;
  settings: AnalysisSettings;
  onProgress: (e: ProgressEvent) => void;
}): Promise<RunReportResult> {
  const { content, pageInfo, dir, settings, onProgress } = opts;
  const baseName = sanitizeFilename(
    `${content.title}-${content.author}的${TYPE_LABELS[content.type] || content.type}`,
  );

  onProgress({ step: 'collect', message: '正在拉取评论（含楼中楼）…', percent: 10 });
  const collection: CommentFetchResult = await fetchAllComments(
    pageInfo.type,
    pageInfo.id,
    (done, total) => {
      const p = 10 + Math.round((done / Math.max(total, 1)) * 35);
      onProgress({
        step: 'collect',
        message: `正在加载子评论 ${done}/${total}…`,
        percent: p,
      });
    },
    { allowPartial: true },
  );
  const commentCount = countCommentNodes(collection.comments);
  const meta = collection.collectionMeta;
  onProgress({
    step: 'collect',
    message: `评论采集完成：总节点 ${commentCount}，一级 ${collection.comments.length}，楼中楼成功 ${meta.childCompleted}/${meta.childRequests}`,
    percent: 45,
    metrics: {
      rootCount: collection.comments.length,
      totalNodes: commentCount,
      childRequests: meta.childRequests,
      childCompleted: meta.childCompleted,
      childFailed: meta.childFailedIds.length,
      childSkipped: meta.childSkippedIds.length,
      childPaginationIncomplete: meta.childPaginationIncompleteIds.length,
      rootPages: meta.rootPages,
      rootPaginationComplete: meta.rootPaginationComplete,
      rateLimited: meta.rateLimited,
      expectedCommentCount: content.commentCount ?? null,
    },
  });

  onProgress({ step: 'save', message: '正在写入 bundle.json…', percent: 50 });
  const bundle = buildExportBundle({
    content,
    comments: collection.comments,
    expectedCommentCount: content.commentCount ?? null,
    collectionMeta: meta,
    warnings: [],
  });
  const bundleFile = `${baseName}.bundle.json`;
  await writeTextToDir(dir, bundleFile, stringifyBundle(bundle));
  onProgress({
    step: 'save',
    message: `已保存 ${bundleFile}（数据状态：${bundle.completeness.status}）`,
    percent: 58,
    metrics: metricsForBundle(bundle),
  });

  if (bundle.completeness.status === 'partial') {
    onProgress({
      step: 'error',
      message: '采集未完整结束，已保存部分 bundle；可修复知乎访问后仅重新分析或重新采集。',
      percent: 58,
      metrics: metricsForBundle(bundle),
    });
    throw new PartialCollectionError(bundleFile, bundle);
  }

  return analyzeBundleAndWriteReport({
    bundle,
    bundleFileName: bundleFile,
    dir,
    settings,
    onProgress,
  });
}
