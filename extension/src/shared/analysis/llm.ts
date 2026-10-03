import type { AnalysisSettings } from './settings';

export type LlmErrorCategory = 'config' | 'auth' | 'rate_limit' | 'network' | 'server' | 'invalid_json' | 'unknown';

export class LlmError extends Error {
  readonly category: LlmErrorCategory;
  readonly status?: number;

  constructor(message: string, category: LlmErrorCategory, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.category = category;
    this.status = status;
  }
}

export interface LlmConnectionResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  modelCount?: number;
  models?: string[];
  message: string;
  category?: LlmErrorCategory;
}

function getBaseUrl(settings: AnalysisSettings): string {
  const base = settings.baseUrl.trim().replace(/\/$/, '');
  if (!base) throw new LlmError('请先配置 API Base URL', 'config');
  return base;
}

function categoryForStatus(status: number): LlmErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** 连接探测用短超时；分析 completions 用长超时。timeoutMs<=0 表示不限时。 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 12000,
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new LlmError(
        `无法连接 API：${error instanceof Error ? error.message : String(error)}`,
        'network',
      );
    }
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new LlmError('API 请求超时，请检查地址或网络连接', 'network');
    }
    throw new LlmError(`无法连接 API：${error instanceof Error ? error.message : String(error)}`, 'network');
  } finally {
    window.clearTimeout(timer);
  }
}

/** 议题树分析可能远超连接探测时间；10 分钟足够常规中转，又避免永久挂起。 */
const CHAT_COMPLETION_TIMEOUT_MS = 600_000;

function authHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey.trim()}`,
    'Content-Type': 'application/json',
  };
}

/** 用 /models 做轻量连接检查，不发送分析内容。 */
export async function testLlmConnection(settings: AnalysisSettings): Promise<LlmConnectionResult> {
  const started = performance.now();
  if (!settings.apiKey.trim()) {
    return {
      ok: false,
      latencyMs: 0,
      message: '尚未填写 API Key',
      category: 'config',
    };
  }

  try {
    const base = getBaseUrl(settings);
    const resp = await fetchWithTimeout(`${base}/models`, {
      method: 'GET',
      headers: authHeaders(settings.apiKey),
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!resp.ok) {
      const text = await resp.text();
      const category = categoryForStatus(resp.status);
      return {
        ok: false,
        status: resp.status,
        latencyMs,
        message: `API 返回 HTTP ${resp.status}${text ? `：${text.slice(0, 160)}` : ''}`,
        category,
      };
    }
    const data = await resp.json().catch(() => null) as { data?: unknown[] } | null;
    const models = Array.isArray(data?.data)
      ? data.data
        .map((item: unknown) => item && typeof item === 'object' && 'id' in item ? String((item as { id?: unknown }).id || '') : '')
        .filter(Boolean)
      : [];
    return {
      ok: true,
      status: resp.status,
      latencyMs,
      modelCount: models.length || undefined,
      models,
      message: `连接成功，${latencyMs} ms${models.length ? `，可见模型 ${models.length} 个` : ''}`,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    const llmError = error instanceof LlmError
      ? error
      : new LlmError(String(error), 'unknown');
    return {
      ok: false,
      latencyMs,
      message: llmError.message,
      category: llmError.category,
    };
  }
}

export async function chatJson(
  settings: AnalysisSettings,
  system: string,
  user: string,
): Promise<Record<string, unknown>> {
  if (!settings.apiKey.trim()) {
    throw new LlmError('请先配置 API Key', 'config');
  }
  const base = getBaseUrl(settings);
  let resp: Response;
  try {
    resp = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(settings.apiKey),
      body: JSON.stringify({
        model: settings.model || 'deepseek-chat',
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    }, CHAT_COMPLETION_TIMEOUT_MS);
  } catch (error) {
    throw error instanceof LlmError ? error : new LlmError(String(error), 'network');
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new LlmError(
      `LLM HTTP ${resp.status}${text ? `：${text.slice(0, 400)}` : ''}`,
      categoryForStatus(resp.status),
      resp.status,
    );
  }

  let data: any;
  try {
    data = await resp.json();
  } catch (error) {
    throw new LlmError(`模型响应不是有效 JSON：${error instanceof Error ? error.message : String(error)}`, 'invalid_json');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LlmError('LLM 响应缺少 content', 'invalid_json');
  }
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      try {
        return JSON.parse(m[1]) as Record<string, unknown>;
      } catch {
        // 统一落到可操作的 JSON 错误提示。
      }
    }
    throw new LlmError(`无法解析模型 JSON：${content.slice(0, 200)}`, 'invalid_json');
  }
}
