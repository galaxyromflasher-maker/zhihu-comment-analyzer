/** 打开扩展内分析工作台页，优先走 background 建标签，失败则回退 window.open。 */
export function getWorkbenchUrl(): string {
  return chrome.runtime.getURL('src/workbench/index.html');
}

export async function openWorkbenchPage(): Promise<void> {
  const url = getWorkbenchUrl();

  try {
    const result = await chrome.runtime.sendMessage({ action: 'openExportPage', url }) as
      | { ok?: boolean; error?: string }
      | undefined;
    if (result?.ok === false) {
      throw new Error(result.error || '后台打开工作台失败');
    }
    // 旧版 SW 可能不回包（port closed）；若已建标签则这里仍会进 catch，再用 window.open 兜底。
    if (result?.ok) return;
  } catch {
    // fall through
  }

  const popup = window.open(url, '_blank');
  if (!popup) {
    throw new Error('无法打开工作台标签页。请点浏览器工具栏「知乎分析采集器」图标，或允许本站弹窗后重试。');
  }
}