import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Space, Tag, Radio, Checkbox, Button, Progress, Typography } from 'antd';
import JSZip from 'jszip';

import type { CommentFetchResult, ExtractedContent, PageInfo } from '@/types/zhihu';
import { listQuestionAnswers } from '@/content/detector';
import { useFolderHandle } from '@/content/hooks/useFolderHandle';
import {
  extractImageUrls,
  htmlToMarkdown,
  buildCommentsMarkdown,
} from '@/shared/converters/html-to-markdown';
import { htmlToDocx, commentsToDocx } from '@/shared/converters/html-to-docx';
import { buildExportBundle, stringifyBundle } from '@/shared/converters/json-export';
import {
  sanitizeFilename,
  buildFrontmatter,
  triggerDownload,
  batchDownloadImages,
  batchDownloadImagesToFolder,
  writeTextFile,
  writeBlobFile,
  buildImageDataMap,
  TYPE_LABELS,
  collectCommentImageEntries,
  downloadCommentImages,
  downloadImage,
} from '@/shared/utils/export-utils';
import { fetchAllComments } from '@/shared/api/zhihu-api';
import { setOnRetry } from '@/shared/api/throttle';
import type { ZhihuComment } from '@/types/zhihu';
import { createTaskId, setPendingTask } from '@/shared/analysis/task';
import { openWorkbenchPage } from '@/shared/analysis/openWorkbench';

interface ArticlePanelProps {
  content: ExtractedContent;
  pageInfo: PageInfo;
}

interface LogItem {
  msg: string;
  type: string;
  time: string;
}

export function ArticlePanel({ content, pageInfo }: ArticlePanelProps) {
  const [format, setFormat] = useState<'md' | 'docx'>('md');
  const [wantFm, setWantFm] = useState(true);
  const [wantComment, setWantComment] = useState(true);
  const [wantBundle, setWantBundle] = useState(true);
  const [wantImages, setWantImages] = useState(true);
  const [docxImgMode, setDocxImgMode] = useState<'embed' | 'link'>('embed');
  const [isExporting, setIsExporting] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [progress, setProgress] = useState<{ percent: number; text: string } | null>(null);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [answerList, setAnswerList] = useState<ExtractedContent[]>([]);
  const [selectedAnswerId, setSelectedAnswerId] = useState('');
  const questionId = content.questionId
    || (pageInfo.type === 'question' ? pageInfo.id : null)
    || window.location.href.match(/question\/(\d+)/)?.[1]
    || null;
  const canPickAnswers = Boolean(questionId) && (pageInfo.type === 'question' || pageInfo.type === 'answer');

  const logEndRef = useRef<HTMLDivElement>(null);
  const { dirHandle, pickFolder, verifyDirHandle } = useFolderHandle();

  const refreshAnswerList = useCallback(() => {
    if (!canPickAnswers || !questionId) return [];
    const list = listQuestionAnswers(questionId, content.title);
    setAnswerList(list);
    setSelectedAnswerId((prev) => {
      if (prev && list.some((item) => item.id === prev)) return prev;
      if (pageInfo.type === 'answer' && list.some((item) => item.id === pageInfo.id)) return pageInfo.id;
      return list[0]?.id || (pageInfo.type === 'answer' ? pageInfo.id : '');
    });
    return list;
  }, [canPickAnswers, questionId, content.title, pageInfo.type, pageInfo.id]);

  useEffect(() => {
    refreshAnswerList();
  }, [refreshAnswerList]);

  const selectedAnswer = answerList.find((item) => item.id === selectedAnswerId) || null;
  const activeContent = canPickAnswers
    ? (selectedAnswer || (pageInfo.type === 'answer' ? content : null))
    : content;
  const activePageInfo: PageInfo | null = canPickAnswers
    ? (activeContent ? { type: 'answer', id: activeContent.id } : null)
    : pageInfo;
  const canRun = Boolean(activeContent && activePageInfo);

  const imgUrls = useMemo(
    () => extractImageUrls(activeContent?.html || ''),
    [activeContent?.html],
  );

  const addLog = useCallback((msg: string, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { msg, type, time }]);
  }, []);

  const showProgress = useCallback((done: number, total: number, text: string) => {
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    setProgress({ percent, text });
  }, []);

  const hideProgress = useCallback(() => {
    setProgress(null);
  }, []);

  const downloadBtnText = useMemo(() => {
    if (format === 'docx') {
      return wantComment || wantBundle ? '下载 ZIP（含评论/JSON）' : '下载 Word';
    }
    const wantImg = wantImages && imgUrls.length > 0;
    if (wantImg || wantComment || wantBundle) {
      const parts = [
        wantImg ? '图片' : '',
        wantComment ? '评论' : '',
        wantBundle ? 'JSON' : '',
      ].filter(Boolean);
      return `下载 ZIP（含${parts.join('+')}）`;
    }
    return '下载 Markdown';
  }, [format, wantComment, wantBundle, wantImages, imgUrls.length]);

  const buildBundleText = useCallback(
    (comments: ZhihuComment[], collection: CommentFetchResult) => {
      if (!activeContent) return '';
      const warnings: string[] = [];
      return stringifyBundle(
        buildExportBundle({
          content: activeContent,
          comments,
          expectedCommentCount: activeContent.commentCount ?? null,
          collectionMeta: collection.collectionMeta,
          warnings,
        }),
      );
    },
    [activeContent],
  );

  const handleDownload = useCallback(async () => {
    if (!activeContent || !activePageInfo) {
      addLog('请先选择一条回答。可在问题页向下滚动后再点「刷新回答列表」。', 'warn');
      return;
    }
    const target = activeContent;
    const targetPage = activePageInfo;
    setIsExporting(true);

    const effectiveWantImages = wantImages && imgUrls.length > 0;
    const baseName = sanitizeFilename(
      `${target.title}-${target.author}的${TYPE_LABELS[target.type] || target.type}`,
    );
    const commentFileName = `${baseName}-评论.md`;
    const bundleFileName = `${baseName}.bundle.json`;
    const needComments = wantComment || wantBundle;
    const needZip = effectiveWantImages || wantComment || wantBundle;

    addLog(`开始导出: type=${target.type}, title="${target.title}", author="${target.author}"`);
    addLog(`内容来源: ${target._source || '未知'}`);

    // 设置 403 重试回调
    setOnRetry((retryCount: number, maxRetries: number, waitMs: number) => {
      const waitSec = Math.round(waitMs / 1000);
      setStatusText(`被限流，等待 ${waitSec}s 后重试（${retryCount}/${maxRetries}）...`);
      addLog(`请求被限制，等待 ${waitSec} 秒后重试（${retryCount}/${maxRetries}）...`, 'warn');
    });

    // 计算 HTML 纯文本长度用于对比
    const tmpDiv = document.createElement('div');
    tmpDiv.innerHTML = target.html || '';
    const plainTextLen = (tmpDiv.textContent || '').length;
    addLog(`HTML 长度: ${(target.html || '').length}, 纯文本: ${plainTextLen}, 图片: ${imgUrls.length} 张`);
    addLog(`选项: FM=${wantFm}, 图片=${effectiveWantImages}, 评论=${wantComment}, JSON=${wantBundle}`);
    addLog(`文件名: ${baseName}`);

    if (!target.html) {
      addLog('警告：HTML 内容为空，导出的 Markdown 将没有正文', 'warn');
    }

    try {
      if (format === 'md') {
        // === Markdown 导出 ===
        let imageMapping: Record<string, string> = {};
        let imageFiles: Array<{ path: string; buffer: ArrayBuffer }> = [];

        if (effectiveWantImages) {
          setStatusText('正在下载图片...');
          addLog(`开始下载 ${imgUrls.length} 张图片...`);
          const result = await batchDownloadImages(imgUrls, '', (done, total) => {
            showProgress(done, total, `正在下载图片 ${done}/${total}`);
          });
          imageMapping = result.imageMapping;
          imageFiles = result.imageFiles;
          const successCount = Object.keys(imageMapping).length;
          const failCount = imgUrls.length - successCount;
          addLog(
            `图片下载完成: 成功 ${successCount}, 失败 ${failCount}`,
            failCount > 0 ? 'warn' : 'info',
          );
        }

        addLog('正在转换 Markdown...');
        showProgress(1, 1, '正在生成 Markdown...');
        let md = htmlToMarkdown(target.html, imageMapping);
        const mdTextLen = md.length;
        if (wantFm) md = buildFrontmatter(target) + md;
        addLog(`Markdown 生成完成: ${mdTextLen} 字符（含FM: ${md.length}）`);
        if (plainTextLen > 0 && mdTextLen < plainTextLen * 0.5) {
          addLog(`警告：Markdown(${mdTextLen}) 远小于纯文本(${plainTextLen})，可能有内容丢失`, 'warn');
        }

        let commentMd = '';
        let bundleText = '';
        let commentImageFiles: Array<{ path: string; buffer: ArrayBuffer }> = [];

        if (needComments) {
          setStatusText('正在加载评论...');
          addLog(`加载评论: type=${targetPage.type}, id=${targetPage.id}`);
          const collection = await fetchAllComments(
            targetPage.type,
            targetPage.id,
            (done, total) => {
              showProgress(done, total, `正在加载子评论 ${done}/${total}...`);
            },
          );
          const { comments, rootTotals } = collection;
          addLog(`评论加载完成: ${comments.length} 条根评论（API totals=${rootTotals}，仅作声明值）`);

          let commentImageMapping: Record<string, string> = {};
          if (effectiveWantImages && comments.length > 0) {
            const imgEntries = collectCommentImageEntries(comments);
            addLog(`评论图片: ${imgEntries.length} 张`);
            const imgResult = await downloadCommentImages(imgEntries, 'comment_');
            commentImageMapping = imgResult.imageMapping;
            commentImageFiles = imgResult.imageFiles;
          }

          if (wantComment) {
            showProgress(1, 1, '正在生成评论 Markdown...');
            commentMd = buildCommentsMarkdown(comments, target.title, commentImageMapping);
            const encodedCommentFile = encodeURIComponent(commentFileName)
              .replace(/\(/g, '%28')
              .replace(/\)/g, '%29');
            md += `\n\n---\n\n> [查看评论区](./${encodedCommentFile})\n`;
          }

          if (wantBundle) {
            showProgress(1, 1, '正在生成 bundle.json...');
            bundleText = buildBundleText(comments, collection);
            addLog(`bundle.json 节点数: ${JSON.parse(bundleText).stats.total_nodes}`);
          }
        }

        if (needZip) {
          showProgress(1, 1, '正在打包 ZIP...');
          addLog(
            `打包 ZIP: 文章=${baseName}.md${wantComment ? ', 评论=' + commentFileName : ''}${wantBundle ? ', JSON=' + bundleFileName : ''}, 图片=${imageFiles.length + commentImageFiles.length} 张`,
          );
          const zip = new JSZip();
          zip.file(`${baseName}.md`, md);
          if (wantComment && commentMd) zip.file(commentFileName, commentMd);
          if (wantBundle && bundleText) zip.file(bundleFileName, bundleText);
          if (effectiveWantImages || commentImageFiles.length > 0) {
            const imagesFolder = zip.folder('images')!;
            for (const f of imageFiles) imagesFolder.file(f.path, f.buffer);
            for (const f of commentImageFiles) imagesFolder.file(f.path, f.buffer);
          }
          const blob = await zip.generateAsync(
            { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
            (meta) => showProgress(1, 1, `正在压缩... ${Math.round(meta.percent)}%`),
          );
          addLog(`ZIP 生成完成: ${(blob.size / 1024).toFixed(1)} KB`);
          triggerDownload(blob, `${baseName}.zip`);
        } else {
          const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
          addLog(`MD 文件: ${(blob.size / 1024).toFixed(1)} KB`);
          triggerDownload(blob, `${baseName}.md`);
        }
      } else {
        // === DOCX 导出 ===
        let imageData = new Map<string, { buffer: ArrayBuffer; ext: string }>();
        if (docxImgMode === 'embed' && imgUrls.length > 0) {
          setStatusText('正在下载图片...');
          addLog(`开始下载 ${imgUrls.length} 张图片...`);
          const result = await batchDownloadImages(imgUrls, '', (done, total) => {
            showProgress(done, total, `正在下载图片 ${done}/${total}`);
          });
          imageData = buildImageDataMap(result.imageMapping, result.imageFiles);
          addLog(`图片下载完成: ${imageData.size} 张`);
        }

        addLog('正在生成 Word 文档...');
        showProgress(1, 1, '正在生成 Word 文档...');
        const frontMatter = wantFm
          ? {
              id: target.id,
              title: target.title,
              author: target.author,
              url: target.url,
              createdTime: target.createdTime,
              updatedTime: target.updatedTime,
            }
          : null;
        const docxBlob = await htmlToDocx(target.html, {
          images: docxImgMode,
          imageData,
          frontMatter,
        });
        addLog(`Word 文档生成完成: ${(docxBlob.size / 1024).toFixed(1)} KB`);

        if (needComments) {
          setStatusText('正在加载评论...');
          addLog(`加载评论: type=${targetPage.type}, id=${targetPage.id}`);
          const collection = await fetchAllComments(
            targetPage.type,
            targetPage.id,
            (done, total) => {
              showProgress(done, total, `正在加载子评论 ${done}/${total}...`);
            },
          );
          const { comments } = collection;
          addLog(`评论加载完成: ${comments.length} 条根评论`);

          const zip = new JSZip();
          zip.file(`${baseName}.docx`, docxBlob);
          if (wantComment) {
            showProgress(1, 1, '正在生成评论文档...');
            const commentBlob = await commentsToDocx(comments, target.title);
            zip.file(`${baseName}-评论.docx`, commentBlob);
          }
          if (wantBundle) {
            zip.file(bundleFileName, buildBundleText(comments, collection));
          }
          showProgress(1, 1, '正在打包 ZIP...');
          const zipBlob = await zip.generateAsync(
            { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
            (meta) => showProgress(1, 1, `正在压缩... ${Math.round(meta.percent)}%`),
          );
          addLog(`ZIP 生成完成: ${(zipBlob.size / 1024).toFixed(1)} KB`);
          triggerDownload(zipBlob, `${baseName}.zip`);
        } else {
          triggerDownload(docxBlob, `${baseName}.docx`);
        }
      }

      addLog('下载成功');
      setStatusText('下载成功');
      setTimeout(() => {
        setIsExporting(false);
        setStatusText('');
        hideProgress();
      }, 2000);
    } catch (err: any) {
      addLog(`导出失败: ${err.message}`, 'error');
      addLog(`错误堆栈: ${err.stack || '无'}`, 'error');
      setStatusText(`失败: ${err.message}`);
      setIsExporting(false);
    }
  }, [
    format, wantFm, wantComment, wantBundle, wantImages, docxImgMode,
    imgUrls, addLog, showProgress, hideProgress, buildBundleText,
    activeContent, activePageInfo,
  ]);

  const handleSaveToFolder = useCallback(async () => {
    if (!activeContent || !activePageInfo) {
      addLog('请先选择一条回答。可在问题页向下滚动后再点「刷新回答列表」。', 'warn');
      return;
    }
    const target = activeContent;
    const targetPage = activePageInfo;
    let handle = dirHandle;

    // 如果没有已选文件夹，先弹选择器
    if (!handle) {
      handle = await pickFolder();
      if (!handle) return;
    }

    // 再次验证权限
    handle = await verifyDirHandle(handle);
    if (!handle) {
      handle = await pickFolder();
      if (!handle) return;
    }

    setIsExporting(true);

    const effectiveWantImages = wantImages && imgUrls.length > 0;
    const baseName = sanitizeFilename(
      `${target.title}-${target.author}的${TYPE_LABELS[target.type] || target.type}`,
    );
    const commentFileName = `${baseName}-评论.md`;
    const bundleFileName = `${baseName}.bundle.json`;
    const needComments = wantComment || wantBundle;

    addLog(`开始保存到文件夹: ${handle.name}`);

    try {
      if (format === 'md') {
        // === Markdown 保存到文件夹 ===
        let imageMapping: Record<string, string> = {};

        if (effectiveWantImages) {
          setStatusText('正在下载图片...');
          addLog(`开始下载 ${imgUrls.length} 张图片到文件夹...`);
          const imagesFolderHandle = await handle.getDirectoryHandle('images', { create: true });
          const result = await batchDownloadImagesToFolder(imgUrls, '', imagesFolderHandle);
          imageMapping = result.imageMapping;
          addLog(`图片保存完成: ${Object.keys(imageMapping).length} 张`);
        }

        addLog('正在转换 Markdown...');
        setStatusText('正在生成 Markdown...');
        let md = htmlToMarkdown(target.html, imageMapping);
        if (wantFm) md = buildFrontmatter(target) + md;

        if (needComments) {
          setStatusText('正在加载评论...');
          const collection = await fetchAllComments(
            targetPage.type,
            targetPage.id,
            (done, total) => {
              showProgress(done, total, `正在加载子评论 ${done}/${total}...`);
            },
          );
          const { comments } = collection;
          addLog(`评论加载完成: ${comments.length} 条根评论`);

          let commentImageMapping: Record<string, string> = {};
          if (effectiveWantImages && comments.length > 0) {
            const imgEntries = collectCommentImageEntries(comments);
            if (imgEntries.length > 0) {
              const imagesFolderHandle = await handle.getDirectoryHandle('images', { create: true });
              for (const entry of imgEntries) {
                for (let i = 0; i < entry.urls.length; i++) {
                  const url = entry.urls[i];
                  const result = await downloadImage(url);
                  if (result) {
                    const filename = `comment_${String(entry.commentIdx).padStart(3, '0')}_${String(i + 1).padStart(3, '0')}${result.ext}`;
                    commentImageMapping[url] = `images/${filename}`;
                    const fh = await imagesFolderHandle.getFileHandle(filename, { create: true });
                    const w = await fh.createWritable();
                    await w.write(result.buffer);
                    await w.close();
                  }
                }
              }
            }
          }

          if (wantComment) {
            const commentMd = buildCommentsMarkdown(comments, target.title, commentImageMapping);
            await writeTextFile(handle, commentFileName, commentMd);
            addLog(`评论已保存: ${commentFileName}`);

            const encodedCommentFile = encodeURIComponent(commentFileName)
              .replace(/\(/g, '%28')
              .replace(/\)/g, '%29');
            md += `\n\n---\n\n> [查看评论区](./${encodedCommentFile})\n`;
          }

          if (wantBundle) {
            await writeTextFile(handle, bundleFileName, buildBundleText(comments, collection));
            addLog(`JSON 已保存: ${bundleFileName}`);
          }
        }

        await writeTextFile(handle, `${baseName}.md`, md);
        addLog(`文章已保存: ${baseName}.md`);
      } else {
        // === DOCX 保存到文件夹 ===
        let imageData = new Map<string, { buffer: ArrayBuffer; ext: string }>();
        if (docxImgMode === 'embed' && imgUrls.length > 0) {
          setStatusText('正在下载图片...');
          addLog(`开始下载 ${imgUrls.length} 张图片...`);
          const result = await batchDownloadImages(imgUrls, '', (done, total) => {
            showProgress(done, total, `正在下载图片 ${done}/${total}`);
          });
          imageData = buildImageDataMap(result.imageMapping, result.imageFiles);
          addLog(`图片下载完成: ${imageData.size} 张`);
        }

        addLog('正在生成 Word 文档...');
        setStatusText('正在生成 Word 文档...');
        const frontMatter = wantFm
          ? {
              id: target.id,
              title: target.title,
              author: target.author,
              url: target.url,
              createdTime: target.createdTime,
              updatedTime: target.updatedTime,
            }
          : null;
        const docxBlob = await htmlToDocx(target.html, {
          images: docxImgMode,
          imageData,
          frontMatter,
        });

        if (needComments) {
          setStatusText('正在加载评论...');
          const collection = await fetchAllComments(
            targetPage.type,
            targetPage.id,
            (done, total) => {
              showProgress(done, total, `正在加载子评论 ${done}/${total}...`);
            },
          );
          const { comments } = collection;
          addLog(`评论加载完成: ${comments.length} 条根评论`);

          if (wantComment) {
            const commentBlob = await commentsToDocx(comments, target.title);
            await writeBlobFile(handle, `${baseName}-评论.docx`, commentBlob);
            addLog(`评论已保存: ${baseName}-评论.docx`);
          }
          if (wantBundle) {
            await writeTextFile(handle, bundleFileName, buildBundleText(comments, collection));
            addLog(`JSON 已保存: ${bundleFileName}`);
          }
        }

        await writeBlobFile(handle, `${baseName}.docx`, docxBlob);
        addLog(`文章已保存: ${baseName}.docx`);
      }

      addLog('保存成功');
      setStatusText('保存成功');
      setTimeout(() => {
        setIsExporting(false);
        setStatusText('');
        hideProgress();
      }, 2000);
    } catch (err: any) {
      addLog(`保存失败: ${err.message}`, 'error');
      setStatusText(`失败: ${err.message}`);
      setIsExporting(false);
    }
  }, [
    format, wantFm, wantComment, wantBundle, wantImages, docxImgMode,
    activeContent, activePageInfo, imgUrls, dirHandle, pickFolder, verifyDirHandle,
    addLog, showProgress, hideProgress, buildBundleText,
  ]);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="small">
      <div>
        <Tag color="blue">{TYPE_LABELS[activeContent?.type || content.type] || content.type}</Tag>
      </div>
      <Typography.Text strong>{content.title}</Typography.Text>
      {canPickAnswers ? (
        <>
          <Typography.Text type="secondary">
            已识别 {answerList.length} 条回答（当前页已加载的）。滚动加载更多后点刷新。
          </Typography.Text>
          <select
            value={selectedAnswerId}
            onChange={(event) => setSelectedAnswerId(event.target.value)}
            disabled={!answerList.length && pageInfo.type !== 'answer'}
            style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #d9d9d9' }}
          >
            {answerList.length === 0 && pageInfo.type !== 'answer' && (
              <option value="">暂无回答，请先滚动页面</option>
            )}
            {answerList.length === 0 && pageInfo.type === 'answer' && (
              <option value={pageInfo.id}>{content.author}（当前回答）</option>
            )}
            {answerList.map((item) => (
              <option key={item.id} value={item.id}>
                {item.author}
                {item.id === pageInfo.id && pageInfo.type === 'answer' ? '（当前）' : ''}
                {item.voteupCount != null ? ` · ${item.voteupCount} 赞` : ''}
              </option>
            ))}
          </select>
          <Button size="small" onClick={() => {
            const list = refreshAnswerList();
            addLog(`已刷新回答列表：${list.length} 条`);
          }}>
            刷新回答列表
          </Button>
        </>
      ) : (
        <Typography.Text type="secondary">{content.author}</Typography.Text>
      )}
      <Typography.Text type="secondary">
        {activeContent ? `${activeContent.author} · ` : ''}
        图片: {imgUrls.length > 0 ? `${imgUrls.length} 张` : '无'} ·
        内容: {activeContent?.html ? `${activeContent.html.length} 字符` : '空'}
      </Typography.Text>

      {/* Options */}
      <Radio.Group value={format} onChange={(e) => setFormat(e.target.value)} size="small">
        <Radio value="md">Markdown</Radio>
        <Radio value="docx">Word</Radio>
      </Radio.Group>
      <Checkbox checked={wantFm} onChange={(e) => setWantFm(e.target.checked)}>
        包含 Front Matter
      </Checkbox>
      {format === 'md' && (
        <Checkbox
          checked={wantImages}
          onChange={(e) => setWantImages(e.target.checked)}
          disabled={imgUrls.length === 0}
        >
          下载图片到本地
        </Checkbox>
      )}
      {format === 'docx' && (
        <Radio.Group value={docxImgMode} onChange={(e) => setDocxImgMode(e.target.value)} size="small">
          <Radio value="embed">嵌入文档</Radio>
          <Radio value="link">外部链接</Radio>
        </Radio.Group>
      )}
      <Checkbox checked={wantComment} onChange={(e) => setWantComment(e.target.checked)}>
        导出评论区（Markdown/Word）
      </Checkbox>
      <Checkbox checked={wantBundle} onChange={(e) => setWantBundle(e.target.checked)}>
        导出分析用 JSON（bundle.json，含评论树与富字段）
      </Checkbox>

      {/* Progress */}
      {progress && <Progress percent={progress.percent} size="small" />}
      {progress && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {progress.text}
        </Typography.Text>
      )}

      {/* 预填当前回答任务并打开工作台；真正开跑需在工作台点「启动」 */}
      <Button
        type="primary"
        block
        disabled={isExporting || !canRun}
        onClick={async () => {
          if (!activeContent || !activePageInfo) {
            addLog('请先选择一条回答。可向下滚动后再点「刷新回答列表」。', 'warn');
            return;
          }
          try {
            addLog(`正在打开工作台并预填：${activeContent.author} 的回答…`);
            await setPendingTask({
              id: createTaskId(),
              content: activeContent,
              pageInfo: activePageInfo,
              createdAt: Date.now(),
            });
            await openWorkbenchPage();
            addLog('已打开工作台（需在工作台点「启动」）', 'success');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            addLog(`打开工作台失败: ${msg}`, 'error');
          }
        }}
        style={{ background: '#0f6a5c', borderColor: '#0f6a5c' }}
      >
        打开工作台
      </Button>
      <Button type="default" block loading={isExporting} disabled={!canRun} onClick={handleDownload}>
        {isExporting ? statusText : downloadBtnText}
      </Button>

      {/* Folder save section */}
      <div>
        {dirHandle && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {dirHandle.name}
          </Typography.Text>
        )}
        <Button
          block
          onClick={handleSaveToFolder}
          loading={isExporting}
          disabled={!canRun}
          style={{ background: '#00994d', borderColor: '#00994d', color: '#fff' }}
        >
          保存到文件夹
        </Button>
      </div>

      {/* Debug log */}
      {logs.length > 0 && (
        <div
          style={{
            maxHeight: 120,
            overflowY: 'auto',
            fontSize: 11,
            lineHeight: 1.5,
            background: 'rgba(0,0,0,.03)',
            borderRadius: 4,
            padding: '6px 8px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {logs.map((l, i) => (
            <div key={i}>
              <span style={{ color: '#aaa' }}>[{l.time}]</span>{' '}
              <span
                style={{
                  color: l.type === 'error' ? '#e53e3e' : l.type === 'warn' ? '#d69e2e' : '#888',
                }}
              >
                {l.msg}
              </span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </Space>
  );
}
