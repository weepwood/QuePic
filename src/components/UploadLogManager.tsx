import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clipboard,
  Clock3,
  Download,
  Eraser,
  FileSearch,
  Search,
  Send,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  clearUploadLogs,
  listUploadLogs,
  subscribeUploadLogs,
  type UploadLogEntry,
  type UploadLogPhase,
} from '../lib/uploadLogger';

type PhaseFilter = 'all' | UploadLogPhase;

const PHASE_LABELS: Record<UploadLogPhase, string> = {
  prepared: '请求准备',
  sent: '已发送',
  success: '响应成功',
  error: '响应失败',
};

function phaseIcon(phase: UploadLogPhase) {
  if (phase === 'success') return <CheckCircle2 size={16} />;
  if (phase === 'error') return <AlertCircle size={16} />;
  if (phase === 'sent') return <Send size={16} />;
  return <Clock3 size={16} />;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function logText(entry: UploadLogEntry): string {
  return JSON.stringify(entry, null, 2);
}

export function UploadLogManager() {
  const [navTarget, setNavTarget] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<UploadLogEntry[]>(() => listUploadLogs());
  const [phase, setPhase] = useState<PhaseFilter>('all');
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let disposed = false;
    let animationFrame = 0;
    const locate = () => {
      const target = document.querySelector<HTMLElement>('.sidebar nav');
      if (target) {
        if (!disposed) setNavTarget(target);
        return;
      }
      animationFrame = window.requestAnimationFrame(locate);
    };
    locate();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => subscribeUploadLogs(setLogs), []);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  const filteredLogs = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    return logs.filter((entry) => {
      if (phase !== 'all' && entry.phase !== phase) return false;
      if (!normalizedQuery) return true;
      return [
        entry.title,
        entry.account_name,
        entry.file_name,
        entry.command,
        entry.error ?? '',
        JSON.stringify(entry.request),
        JSON.stringify(entry.response),
      ].join('\n').toLocaleLowerCase('zh-CN').includes(normalizedQuery);
    });
  }, [logs, phase, query]);

  const failedCount = useMemo(() => logs.filter((entry) => entry.phase === 'error').length, [logs]);

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(filteredLogs, null, 2));
      setMessage(`已复制 ${filteredLogs.length} 条日志。`);
    } catch (error) {
      setMessage(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportLogs = () => {
    const blob = new Blob([JSON.stringify(filteredLogs, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
    link.href = url;
    link.download = `quepic-upload-logs-${timestamp}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage(`已导出 ${filteredLogs.length} 条日志。`);
  };

  const removeLogs = () => {
    if (logs.length > 0 && !window.confirm('确定清空全部上传日志吗？此操作无法撤销。')) return;
    clearUploadLogs();
    setMessage('上传日志已清空。');
  };

  return (
    <>
      {navTarget && createPortal(
        <button className={open ? 'nav-item active' : 'nav-item'} type="button" onClick={() => setOpen(true)}>
          <Activity size={18} />
          <span>上传日志</span>
          <em className={failedCount > 0 ? 'upload-log-nav-count error' : 'upload-log-nav-count'}>
            {failedCount > 0 ? failedCount : logs.length || ''}
          </em>
        </button>,
        navTarget,
      )}

      {open && createPortal(
        <div className="upload-log-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setOpen(false);
        }}>
          <section className="upload-log-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-log-title">
            <header className="upload-log-header">
              <div className="upload-log-heading">
                <div className="upload-log-heading-icon"><Activity size={22} /></div>
                <div>
                  <span>UPLOAD OBSERVABILITY</span>
                  <h2 id="upload-log-title">上传请求日志</h2>
                  <p>记录上传命令的请求准备、发送状态、实际返回值与错误信息；Cookie、Token 和文件字节不会写入日志。</p>
                </div>
              </div>
              <button className="upload-log-close" type="button" aria-label="关闭上传日志" onClick={() => setOpen(false)}>
                <X size={19} />
              </button>
            </header>

            <div className="upload-log-toolbar">
              <label className="upload-log-search">
                <Search size={16} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号、文件名、请求参数或错误" />
              </label>
              <select value={phase} onChange={(event) => setPhase(event.target.value as PhaseFilter)} aria-label="筛选日志阶段">
                <option value="all">全部阶段</option>
                <option value="prepared">请求准备</option>
                <option value="sent">已发送</option>
                <option value="success">响应成功</option>
                <option value="error">响应失败</option>
              </select>
              <button type="button" disabled={filteredLogs.length === 0} onClick={() => void copyLogs()}><Clipboard size={15} />复制</button>
              <button type="button" disabled={filteredLogs.length === 0} onClick={exportLogs}><Download size={15} />导出 JSON</button>
              <button className="danger" type="button" disabled={logs.length === 0} onClick={removeLogs}><Eraser size={15} />清空</button>
            </div>

            <div className="upload-log-summary">
              <span>共 <strong>{logs.length}</strong> 条</span>
              <span>当前显示 <strong>{filteredLogs.length}</strong> 条</span>
              <span className={failedCount > 0 ? 'has-error' : ''}>失败响应 <strong>{failedCount}</strong> 条</span>
              {message && <b>{message}</b>}
            </div>

            <div className="upload-log-list">
              {filteredLogs.length === 0 ? (
                <div className="upload-log-empty">
                  <FileSearch size={36} />
                  <strong>{logs.length === 0 ? '还没有上传日志' : '没有匹配的日志'}</strong>
                  <p>{logs.length === 0 ? '执行一次图片上传后，这里会出现完整的请求生命周期。' : '调整阶段筛选或搜索条件后重试。'}</p>
                </div>
              ) : filteredLogs.map((entry) => (
                <article className={`upload-log-entry ${entry.phase}`} key={entry.id}>
                  <div className="upload-log-entry-status">{phaseIcon(entry.phase)}</div>
                  <div className="upload-log-entry-main">
                    <div className="upload-log-entry-title">
                      <strong>{entry.title}</strong>
                      <span>{PHASE_LABELS[entry.phase]}</span>
                      <code>{entry.request_id.slice(0, 8)}</code>
                    </div>
                    <p>{entry.file_name} · {formatBytes(entry.file_size)} · 账号：{entry.account_name}</p>
                    <small>
                      {formatTime(entry.created_at)}
                      {entry.duration_ms !== null ? ` · ${entry.duration_ms} ms` : ''}
                      {` · ${entry.command}`}
                    </small>
                    {entry.error && <div className="upload-log-error">{entry.error}</div>}
                    <details>
                      <summary>查看请求与响应详情</summary>
                      <div className="upload-log-detail-grid">
                        <section>
                          <h3>发送的请求</h3>
                          <pre>{JSON.stringify(entry.request, null, 2)}</pre>
                        </section>
                        <section>
                          <h3>实际响应</h3>
                          <pre>{entry.response === null ? entry.error ?? '尚未收到响应' : JSON.stringify(entry.response, null, 2)}</pre>
                        </section>
                      </div>
                      <button className="upload-log-copy-one" type="button" onClick={() => void navigator.clipboard.writeText(logText(entry))}>
                        <Clipboard size={14} />复制本条日志
                      </button>
                    </details>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
