import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ensureDirPermission,
  loadWorkbenchDirHandle,
  pickWorkbenchFolder,
} from '@/shared/analysis/folder';
import { runReportPipeline, type ProgressEvent } from '@/shared/analysis/runReport';
import { loadSettings, saveSettings, type AnalysisSettings } from '@/shared/analysis/settings';
import { takePendingTask, type ReportTask } from '@/shared/analysis/task';
import { DEFAULT_SYSTEM, DEFAULT_USER_TEMPLATE } from '@/shared/analysis/prompts';

type LogLine = { t: string; msg: string; level: 'info' | 'ok' | 'warn' | 'err' };

const STEPS = [
  { id: 'setup', label: '准备环境', desc: 'API Key · 临时目录' },
  { id: 'collect', label: '采集评论', desc: '回答正文 + 评论树' },
  { id: 'save', label: '保存数据', desc: '写入 bundle.json' },
  { id: 'analyze', label: '模型分析', desc: '议题树 / 态度 / 摘要' },
  { id: 'render', label: '生成报告', desc: 'HTML 议题树报告' },
  { id: 'done', label: '完成', desc: '可在本页阅读' },
] as const;

function nowTs() {
  return new Date().toLocaleTimeString();
}

export function WorkbenchApp() {
  const [settings, setSettings] = useState<AnalysisSettings | null>(null);
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null);
  const [task, setTask] = useState<ReportTask | null>(null);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<string>('setup');
  const [percent, setPercent] = useState(0);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [reportHtml, setReportHtml] = useState('');
  const [showPrompts, setShowPrompts] = useState(false);
  const [error, setError] = useState('');
  const autoStarted = useRef(false);
  const logEnd = useRef<HTMLDivElement>(null);

  const pushLog = useCallback((msg: string, level: LogLine['level'] = 'info') => {
    setLogs((prev) => [...prev, { t: nowTs(), msg, level }]);
  }, []);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      setSettings(s);
      const handle = await ensureDirPermission(await loadWorkbenchDirHandle());
      setDir(handle);
      const pending = await takePendingTask();
      setTask(pending);
      setReady(true);
      if (!pending) {
        pushLog('未检测到待处理任务。请从知乎回答页点击「生成报告」。', 'warn');
      } else {
        pushLog(`已接收任务：${pending.content.title}`, 'ok');
      }
    })().catch((e) => {
      setError(String(e));
      pushLog(String(e), 'err');
    });
  }, [pushLog]);

  const setupOk = Boolean(settings?.apiKey?.trim() && dir);

  const stepState = useMemo(() => {
    const order = STEPS.map((s) => s.id);
    const idx = order.indexOf(step as (typeof order)[number]);
    return STEPS.map((s, i) => {
      if (step === 'error') {
        return { ...s, state: i === 0 ? 'error' : i < idx ? 'done' : '' };
      }
      if (step === 'done') return { ...s, state: 'done' };
      if (i < idx) return { ...s, state: 'done' };
      if (i === idx) return { ...s, state: 'active' };
      return { ...s, state: '' };
    });
  }, [step]);

  const onPickFolder = async () => {
    const handle = await pickWorkbenchFolder();
    if (!handle) {
      pushLog('未选择目录', 'warn');
      return;
    }
    setDir(handle);
    await saveSettings({ folderName: handle.name });
    setSettings((prev) => (prev ? { ...prev, folderName: handle.name } : prev));
    pushLog(`临时目录已设置：${handle.name}`, 'ok');
  };

  const persistSettings = async (next: AnalysisSettings) => {
    setSettings(next);
    await saveSettings(next);
  };

  const start = useCallback(async () => {
    if (!settings || !dir || !task || running) return;
    if (!settings.apiKey.trim()) {
      setError('请先填写 API Key');
      return;
    }
    const permitted = await ensureDirPermission(dir);
    if (!permitted) {
      setError('目录权限失效，请重新选择临时目录');
      setDir(null);
      return;
    }

    setRunning(true);
    setError('');
    setReportHtml('');
    setStep('collect');
    setPercent(5);
    pushLog('开始流水线…', 'ok');

    try {
      const result = await runReportPipeline({
        content: task.content,
        pageInfo: task.pageInfo,
        dir: permitted,
        settings,
        onProgress: (e: ProgressEvent) => {
          setStep(e.step === 'done' ? 'done' : e.step === 'error' ? 'error' : e.step);
          if (typeof e.percent === 'number') setPercent(e.percent);
          if (e.step === 'render' || e.message.includes('渲染')) setStep('render');
          pushLog(e.message, e.step === 'done' ? 'ok' : 'info');
        },
      });
      setStep('done');
      setPercent(100);
      setReportHtml(result.reportHtml);
      pushLog(`完成：${result.reportPath}（评论 ${result.commentCount}）`, 'ok');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStep('error');
      setError(msg);
      pushLog(msg, 'err');
    } finally {
      setRunning(false);
    }
  }, [settings, dir, task, running, pushLog]);

  useEffect(() => {
    if (!ready || autoStarted.current || !task || !setupOk || running) return;
    autoStarted.current = true;
    void start();
  }, [ready, task, setupOk, running, start]);

  if (!ready || !settings) {
    return (
      <div className="app">
        <div className="topbar"><div className="brand"><strong>知乎分析工作台</strong><span>加载中…</span></div></div>
      </div>
    );
  }

  const needSetup = !setupOk;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>知乎分析工作台</strong>
          <span>粘贴链路的终点：进度 · 议题树报告 · 可改提示词</span>
        </div>
        <div className="row" style={{ marginTop: 0 }}>
          <button type="button" className="btn ghost" onClick={() => setShowPrompts((v) => !v)}>
            {showPrompts ? '收起设置' : '设置 / 提示词'}
          </button>
          <button type="button" className="btn" disabled={!setupOk || !task || running} onClick={() => void start()}>
            {running ? '进行中…' : '重新生成'}
          </button>
        </div>
      </header>

      {needSetup ? (
        <main className="setup-hero card" style={{ margin: '2rem auto', width: 'min(560px, calc(100% - 2rem))' }}>
          <h1>首次使用：完成两步准备</h1>
          <p>生成报告需要把评论 JSON 暂存在你指定的本地目录，并用你的大模型 API 做议题树分析。数据留在本机。</p>

          <label className="field">DeepSeek API Key</label>
          <input
            type="password"
            value={settings.apiKey}
            placeholder="sk-..."
            onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
          />
          <label className="field">API Base URL</label>
          <input
            value={settings.baseUrl}
            onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
          />
          <label className="field">模型</label>
          <input
            value={settings.model}
            onChange={(e) => setSettings({ ...settings, model: e.target.value })}
          />

          <div className="row">
            <button
              type="button"
              className="btn soft"
              onClick={() => void persistSettings(settings)}
            >
              保存 API 设置
            </button>
            <button type="button" className="btn" onClick={() => void onPickFolder()}>
              {dir ? `更换目录（当前：${dir.name}）` : '选择临时文件目录'}
            </button>
          </div>
          <p className="hint">目录用于存放 bundle.json 与 report.html。选定后会记住，下次一般不用再选。</p>
          {task && setupOk && (
            <div className="row">
              <button type="button" className="btn" onClick={() => void start()}>开始分析</button>
            </div>
          )}
          {!task && <p className="hint">还没有任务：请到知乎回答页打开扩展，点击「生成报告」。</p>}
        </main>
      ) : (
        <div className="layout">
          <aside className="side">
            <div className="card">
              <h2>任务</h2>
              {task ? (
                <>
                  <div style={{ fontWeight: 600 }}>{task.content.title}</div>
                  <div className="hint">答主：{task.content.author}</div>
                  <div className="hint" style={{ wordBreak: 'break-all' }}>{task.content.url}</div>
                </>
              ) : (
                <div className="hint">无待处理任务</div>
              )}
              <div className="hint" style={{ marginTop: '0.6rem' }}>
                临时目录：{dir?.name || settings.folderName || '未选择'}
              </div>
              <div className="row">
                <button type="button" className="btn ghost" onClick={() => void onPickFolder()}>更换目录</button>
              </div>
            </div>

            <div className="card">
              <h2>步骤</h2>
              <ul className="steps">
                {stepState.map((s) => (
                  <li key={s.id} className={`step ${s.state}`}>
                    <i className="dot" />
                    <div>
                      <div className="label">{s.label}</div>
                      <div className="desc">{s.desc}</div>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="progress"><i style={{ width: `${percent}%` }} /></div>
              <div className="hint">{percent}%</div>
            </div>

            {showPrompts && (
              <div className="card">
                <h2>提示词（一般定稿后不用改）</h2>
                <label className="field">System</label>
                <textarea
                  value={settings.system}
                  onChange={(e) => setSettings({ ...settings, system: e.target.value })}
                />
                <label className="field">User 模板（保留 {'{validation}'} / {'{corpus}'}）</label>
                <textarea
                  style={{ minHeight: 160 }}
                  value={settings.userTemplate}
                  onChange={(e) => setSettings({ ...settings, userTemplate: e.target.value })}
                />
                <div className="row">
                  <button type="button" className="btn soft" onClick={() => void persistSettings(settings)}>保存提示词</button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() =>
                      void persistSettings({
                        ...settings,
                        system: DEFAULT_SYSTEM,
                        userTemplate: DEFAULT_USER_TEMPLATE,
                      })
                    }
                  >
                    恢复默认
                  </button>
                </div>
                <label className="field">API Key</label>
                <input
                  type="password"
                  value={settings.apiKey}
                  onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                />
                <div className="row">
                  <button type="button" className="btn ghost" onClick={() => void persistSettings(settings)}>保存 API</button>
                </div>
              </div>
            )}
          </aside>

          <section className="main">
            <div className="card">
              <h2>过程日志</h2>
              <div className="terminal">
                {logs.map((l, i) => (
                  <div key={i} className={`line ${l.level}`}>
                    <span className="ts">[{l.t}]</span>
                    {l.msg}
                  </div>
                ))}
                <div ref={logEnd} />
              </div>
              {error && <p className="hint" style={{ color: 'var(--danger)' }}>{error}</p>}
            </div>

            <div className="card">
              <h2>报告预览</h2>
              {reportHtml ? (
                <iframe className="report-frame" title="report" srcDoc={reportHtml} />
              ) : (
                <p className="hint">生成完成后，议题树报告会显示在这里（无需再跳转）。</p>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
