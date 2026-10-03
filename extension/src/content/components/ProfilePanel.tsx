import React from 'react';
import { Button, Tag, Space, Typography } from 'antd';
import type { CollectionInfo } from '@/types/zhihu';

interface Props {
  info: CollectionInfo;
}

export function ProfilePanel({ info }: Props) {
  const openExportManager = () => {
    const exportUrl = chrome.runtime.getURL(
      `src/export/index.html?id=${encodeURIComponent(info.id)}&name=${encodeURIComponent(info.title)}&api=${encodeURIComponent(info.apiUrl)}&source=profile`
    );
    chrome.runtime.sendMessage({ action: 'openExportPage', url: exportUrl });
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <div><Tag color="purple">个人主页</Tag></div>
      <Typography.Text strong>{info.title}</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        导出该用户的文章、回答、想法
      </Typography.Text>
      <Button type="primary" block onClick={openExportManager}>
        打开导出管理器
      </Button>
    </Space>
  );
}
