import type { AnalysisSettings } from './settings';

export async function chatJson(
  settings: AnalysisSettings,
  system: string,
  user: string,
): Promise<Record<string, unknown>> {
  if (!settings.apiKey.trim()) {
    throw new Error('请先配置 API Key');
  }
  const base = settings.baseUrl.replace(/\/$/, '');
  const url = `${base}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.model || 'deepseek-chat',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 400)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('LLM 响应缺少 content');
  }
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) return JSON.parse(m[1]) as Record<string, unknown>;
    throw new Error(`无法解析模型 JSON: ${content.slice(0, 200)}`);
  }
}
