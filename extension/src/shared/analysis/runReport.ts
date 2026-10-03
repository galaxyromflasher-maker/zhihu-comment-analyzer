import type { ExtractedContent, PageInfo, ZhihuComment } from '@/types/zhihu';
import { fetchAllComments } from '@/shared/api/zhihu-api';
import { buildExportBundle, stringifyBundle } from '@/shared/converters/json-export';
import { sanitizeFilename, TYPE_LABELS } from '@/shared/utils/export-utils';
import { buildCorpusFromBundle, countCommentNodes } from './corpus';
import { writeTextToDir } from './folder';
import { buildHtmlReport } from './htmlReport';
import { chatJson } from './llm';
import { renderUserPrompt } from './prompts';
import type { AnalysisSettings } from './settings';

export type StepId = 'setup' | 'collect' | 'save' | 'analyze' | 'render' | 'done' | 'error';

export interface ProgressEvent {
  step: StepId;
  message: string;
  percent?: number;
}

export interface RunReportResult {
  bundlePath: string;
  reportPath: string;
  reportHtml: string;
  commentCount: number;
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
  const { comments, rootTotals } = await fetchAllComments(
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
  );
  const commentCount = countCommentNodes(comments);
  onProgress({
    step: 'collect',
    message: `评论采集完成：共 ${commentCount} 条（一级 ${comments.length}，API totals=${rootTotals}）`,
    percent: 45,
  });

  onProgress({ step: 'save', message: '正在写入 bundle.json…', percent: 50 });
  const warnings: string[] = [];
  const bundle = buildExportBundle({
    content,
    comments,
    expectedCommentCount: content.commentCount ?? (rootTotals > 0 ? rootTotals : null),
    warnings,
  });
  const bundleText = stringifyBundle(bundle);
  const bundleFile = `${baseName}.bundle.json`;
  await writeTextToDir(dir, bundleFile, bundleText);
  onProgress({ step: 'save', message: `已保存 ${bundleFile}`, percent: 58 });

  onProgress({ step: 'analyze', message: '正在调用模型生成议题树…', percent: 62 });
  const { corpus, validation } = buildCorpusFromBundle(bundle);
  const user = renderUserPrompt(settings.userTemplate, corpus, validation);
  const result = await chatJson(settings, settings.system, user);
  onProgress({ step: 'analyze', message: '模型返回成功，正在渲染报告…', percent: 88 });

  const reportHtml = buildHtmlReport({
    title: content.title,
    author: content.author,
    url: content.url,
    commentCount,
    result,
  });
  const reportFile = `${baseName}.report.html`;
  await writeTextToDir(dir, reportFile, reportHtml);
  await writeTextToDir(dir, `${baseName}.llm_raw.json`, `${JSON.stringify(result, null, 2)}\n`);

  onProgress({ step: 'done', message: '报告已生成', percent: 100 });
  return {
    bundlePath: bundleFile,
    reportPath: reportFile,
    reportHtml,
    commentCount,
  };
}

// silence unused if tree-shaken differently
export type { ZhihuComment };
