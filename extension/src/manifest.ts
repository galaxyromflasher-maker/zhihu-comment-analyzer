import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

export default defineManifest({
  manifest_version: 3,
  name: '知乎分析采集器',
  description: '知乎回答评论采集 + 一键生成议题树分析报告（工作台）',
  version: pkg.version,
  permissions: ['activeTab', 'storage', 'unlimitedStorage', 'scripting'],
  host_permissions: [
    'https://www.zhihu.com/*',
    'https://zhuanlan.zhihu.com/*',
    'https://api.deepseek.com/*',
  ],
  background: {
    service_worker: 'src/background/index.ts',
  },
  icons: {
    '16': 'src/assets/icons/icon16.png',
    '48': 'src/assets/icons/icon48.png',
    '128': 'src/assets/icons/icon128.png',
  },
  content_scripts: [
    {
      matches: [
        'https://www.zhihu.com/*',
        'https://zhuanlan.zhihu.com/*',
      ],
      js: ['src/content/index.tsx'],
      run_at: 'document_idle',
    },
  ],
  web_accessible_resources: [
    {
      resources: ['src/assets/icons/icon48.png', 'src/content/fetch-bridge.js'],
      matches: ['https://www.zhihu.com/*', 'https://zhuanlan.zhihu.com/*'],
    },
  ],
});
