import { DEFAULT_SYSTEM, DEFAULT_USER_TEMPLATE } from './prompts';

const KEYS = {
  apiKey: 'za_api_key',
  baseUrl: 'za_base_url',
  model: 'za_model',
  system: 'za_system_prompt',
  userTemplate: 'za_user_template',
  folderName: 'za_folder_name',
} as const;

export interface AnalysisSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  system: string;
  userTemplate: string;
  folderName: string;
}

export async function loadSettings(): Promise<AnalysisSettings> {
  const data = await chrome.storage.local.get(Object.values(KEYS));
  return {
    apiKey: String(data[KEYS.apiKey] || ''),
    baseUrl: String(data[KEYS.baseUrl] || 'https://api.deepseek.com'),
    model: String(data[KEYS.model] || 'deepseek-chat'),
    system: String(data[KEYS.system] || DEFAULT_SYSTEM),
    userTemplate: String(data[KEYS.userTemplate] || DEFAULT_USER_TEMPLATE),
    folderName: String(data[KEYS.folderName] || ''),
  };
}

export async function saveSettings(partial: Partial<AnalysisSettings>): Promise<void> {
  const payload: Record<string, string> = {};
  if (partial.apiKey !== undefined) payload[KEYS.apiKey] = partial.apiKey;
  if (partial.baseUrl !== undefined) payload[KEYS.baseUrl] = partial.baseUrl;
  if (partial.model !== undefined) payload[KEYS.model] = partial.model;
  if (partial.system !== undefined) payload[KEYS.system] = partial.system;
  if (partial.userTemplate !== undefined) payload[KEYS.userTemplate] = partial.userTemplate;
  if (partial.folderName !== undefined) payload[KEYS.folderName] = partial.folderName;
  await chrome.storage.local.set(payload);
}
