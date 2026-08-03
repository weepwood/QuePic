import {
  Archive,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  HardDriveDownload,
  LoaderCircle,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DriveFileRecord, DriveQueueItem } from '../drive-types';
import {
  createDriveFolder,
  deleteDriveFile,
  listDriveFiles,
  listDriveFolders,
  listDriveTags,
  pickDriveFiles,
  saveDriveFile,
  updateDriveFileFolder,
  updateDriveFileTags,
  uploadDriveFile,
} from '../lib/drive';
import { getCredentialStatus, openExternalUrl } from '../lib/tauri';

const DEFAULT_ACCOUNT = 'default';
const DEFAULT_FOLDER = '未分类';
const YUQUE_ATTACHMENT_HELP = 'https://www.yuque.com/yuque/gpvawt/ca13hg';

function parseTags(value: string): string[] {
  return Array.from(new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))).slice(0, 20);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function fileTypeIcon(file: Pick<DriveFileRecord, 'mime_type' | 'extension'>) {
  if (file.mime_type.startsWith('image/')) return <FileImage size={21} />;
  if (file.mime_type.startsWith('video/')) return <FileVideo size={21} />;
  if (file.mime_type.startsWith('audio/')) return <FileAudio size={21} />;
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(file.extension)) return <FileArchive size={21} />;
  if (file.mime_type.startsWith('text/') || ['pdf', 'doc', 'docx', 'md', 'txt'].includes(file.extension)) return <FileText size={21} />;
  return <FileIcon size={21} />;
}

export function CloudDriveManager() {
  const [navTarget, setNavTarget] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<DriveFileRecord[]>([]);
  const [folders, setFolders] = useState<string[]>([DEFAULT_FOLDER]);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [queue, setQueue] = useState<DriveQueueItem[]>([]);
  const [accountName, setAccountName] = useState(DEFAULT_ACCOUNT);
  const [credentialReady, setCredentialReady] = useState(false);
  const [activeFolder, setActiveFolder] = useState('全部');
  const [search, setSearch] = useState('');
  const [uploadFolder, setUploadFolder] = useState(DEFAULT_FOLDER);
  const [uploadTags, setUploadTags] = useState('');
  const [selected, setSelected] = useState<DriveFileRecord | null>(null);
  const [folderDraft, setFolderDraft] = useState(DEFAULT_FOLDER);
  const [tagDraft, setTagDraft] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let disposed = false;
    let frame = 0;
    const locate = () => {
      const target = document.querySelector<HTMLElement>('.sidebar nav');
      if (target) {
        if (!disposed) setNavTarget(target);
        return;
      }
      frame = window.requestAnimationFrame(locate);
    };
    locate();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const refresh = useCallback(async () => {
    const [nextFiles, nextFolders, nextTags] = await Promise.all([
      listDriveFiles(),
      listDriveFolders(),
      listDriveTags(),
    ]);
    setFiles(nextFiles);
    setFolders(nextFolders.length ? nextFolders : [DEFAULT_FOLDER]);
    setKnownTags(nextTags);
    setSelected((current) => current ? nextFiles.find((file) => file.id === current.id) || null : null);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const nextAccount = localStorage.getItem('quepic-account')?.trim() || DEFAULT_ACCOUNT;
    setAccountName(nextAccount);
    setMessage('');
    void Promise.all([refresh(), getCredentialStatus(nextAccount)])
      .then(([, status]) => setCredentialReady(status.configured))
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open, refresh]);

  useEffect(() => {
    if (!selected) return;
    setFolderDraft(selected.folder || DEFAULT_FOLDER);
    setTagDraft((selected.tags || []).join(', '));
  }, [selected]);

  const filteredFiles = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    return files.filter((file) => {
      if (activeFolder !== '全部' && file.folder !== activeFolder) return false;
      if (!keyword) return true;
      return [file.file_name, file.extension, file.mime_type, file.account_name, file.folder, file.remote_url, ...file.tags]
        .join('\n')
        .toLocaleLowerCase('zh-CN')
        .includes(keyword);
    });
  }, [activeFolder, files, search]);

  const folderCounts = useMemo(() => {
    const result = new Map<string, number>();
    files.forEach((file) => result.set(file.folder, (result.get(file.folder) || 0) + 1));
    return result;
  }, [files]);

  const chooseFiles = async () => {
    try {
      const picked = await pickDriveFiles();
      const items: DriveQueueItem[] = picked.map((file) => ({
        ...file,
        id: crypto.randomUUID(),
        status: file.supported ? 'waiting' : 'error',
        error: file.validation_message || undefined,
      }));
      setQueue((current) => [...items, ...current]);
      if (items.length > 0) setMessage(`已加入 ${items.length} 个本地文件。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const uploadQueue = async () => {
    const waiting = queue.filter((item) => item.status === 'waiting' || item.status === 'error' && item.supported);
    if (waiting.length === 0) return;
    if (!credentialReady) {
      setMessage(`账号“${accountName}”尚未保存有效语雀会话，请先前往设置登录。`);
      return;
    }
    setBusy(true);
    let succeeded = 0;
    let failed = 0;
    for (const item of waiting) {
      setQueue((current) => current.map((candidate) => candidate.id === item.id
        ? { ...candidate, status: 'uploading', error: undefined }
        : candidate));
      try {
        const result = await uploadDriveFile(item, accountName, uploadFolder, parseTags(uploadTags));
        succeeded += 1;
        setQueue((current) => current.map((candidate) => candidate.id === item.id
          ? { ...candidate, status: 'success', result }
          : candidate));
      } catch (error) {
        failed += 1;
        const text = error instanceof Error ? error.message : String(error);
        setQueue((current) => current.map((candidate) => candidate.id === item.id
          ? { ...candidate, status: 'error', error: text }
          : candidate));
      }
    }
    try {
      await refresh();
    } catch (error) {
      setMessage(`上传已结束，但刷新索引失败：${error instanceof Error ? error.message : String(error)}`);
    }
    setMessage(`上传完成：成功 ${succeeded} 个，失败 ${failed} 个。`);
    setBusy(false);
  };

  const downloadFile = async (file: DriveFileRecord) => {
    setBusy(true);
    try {
      const result = await saveDriveFile(file.id);
      setMessage(result.cancelled ? '已取消下载。' : `原始文件已保存到：${result.path}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const removeFile = async (file: DriveFileRecord) => {
    if (!window.confirm(`只删除“${file.file_name}”的本地索引吗？语雀远程附件不会被删除。`)) return;
    setBusy(true);
    try {
      await deleteDriveFile(file.id);
      setSelected(null);
      await refresh();
      setMessage('本地索引已删除，语雀远程附件保持不变。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const saveMetadata = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await updateDriveFileFolder(selected.id, folderDraft);
      await updateDriveFileTags(selected.id, parseTags(tagDraft));
      await refresh();
      setMessage('文件夹与标签已保存。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const addFolder = async () => {
    const name = newFolder.trim();
    if (!name) return;
    try {
      const created = await createDriveFolder(name);
      setNewFolder('');
      setUploadFolder(created);
      await refresh();
      setMessage(`已创建文件夹“${created}”。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      {navTarget && createPortal(
        <button className={open ? 'nav-item active' : 'nav-item'} type="button" onClick={() => setOpen(true)}>
          <Cloud size={18} /><span>语雀云盘</span><em>{files.length || ''}</em>
        </button>,
        navTarget,
      )}

      {open && createPortal(
        <div className="cloud-drive-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setOpen(false);
        }}>
          <section className="cloud-drive-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-drive-title">
            <header className="cloud-drive-header">
              <div className="cloud-drive-heading">
                <span className="cloud-drive-logo"><Cloud size={24} /></span>
                <div><span>YUQUE-BACKED LOCAL DRIVE</span><h2 id="cloud-drive-title">语雀云盘</h2><p>本地只保存管理索引，原始文件存放在语雀；下载时按来源账号回源。</p></div>
              </div>
              <div className="cloud-drive-header-actions">
                <button type="button" onClick={() => void openExternalUrl(YUQUE_ATTACHMENT_HELP)}><ExternalLink size={15} />语雀格式说明</button>
                <button type="button" onClick={() => void refresh()}><RefreshCw size={15} />刷新</button>
                <button className="icon-only" type="button" aria-label="关闭语雀云盘" onClick={() => setOpen(false)}><X size={19} /></button>
              </div>
            </header>

            <div className="cloud-drive-account-strip">
              <Archive size={16} />
              <span>当前上传账号：<strong>{accountName}</strong></span>
              <b className={credentialReady ? 'ready' : 'missing'}>{credentialReady ? '语雀会话可用' : '需要登录语雀'}</b>
              <small>附件接口由语雀网页端提供，服务端仍会最终校验格式、大小和权限。</small>
            </div>

            <div className="cloud-drive-layout">
              <aside className="cloud-drive-sidebar">
                <div className="cloud-drive-sidebar-title"><Folder size={15} /><strong>文件夹</strong></div>
                <button className={activeFolder === '全部' ? 'active' : ''} onClick={() => setActiveFolder('全部')}><span>全部文件</span><em>{files.length}</em></button>
                {folders.map((folder) => (
                  <button key={folder} className={activeFolder === folder ? 'active' : ''} onClick={() => setActiveFolder(folder)}>
                    <span>{folder}</span><em>{folderCounts.get(folder) || 0}</em>
                  </button>
                ))}
                <div className="cloud-drive-new-folder">
                  <input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="新建文件夹" />
                  <button type="button" disabled={!newFolder.trim()} onClick={() => void addFolder()}><FolderPlus size={14} /></button>
                </div>
                <div className="cloud-drive-tags"><div><Tags size={14} /><strong>已有标签</strong></div>{knownTags.length ? knownTags.map((tag) => <span key={tag}>#{tag}</span>) : <small>暂无标签</small>}</div>
              </aside>

              <main className="cloud-drive-main">
                <section className="cloud-drive-upload-card">
                  <div className="cloud-drive-upload-copy"><UploadCloud size={27} /><div><strong>从本地上传附件</strong><p>选择文件后由 Rust 从磁盘流式上传，不把大文件整体载入前端内存。</p></div></div>
                  <div className="cloud-drive-upload-fields">
                    <select value={uploadFolder} onChange={(event) => setUploadFolder(event.target.value)}>{folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</select>
                    <input value={uploadTags} onChange={(event) => setUploadTags(event.target.value)} placeholder="标签，用逗号分隔" />
                    <button type="button" onClick={() => void chooseFiles()}><FileIcon size={16} />选择文件</button>
                    <button className="primary" type="button" disabled={busy || !credentialReady || !queue.some((item) => item.supported && item.status !== 'success' && item.status !== 'uploading')} onClick={() => void uploadQueue()}>
                      {busy ? <LoaderCircle className="spin" size={16} /> : <UploadCloud size={16} />}上传队列
                    </button>
                  </div>
                  {queue.length > 0 && <div className="cloud-drive-queue">
                    {queue.map((item) => <article key={item.id} className={`cloud-drive-queue-item ${item.status}`}>
                      <span>{fileTypeIcon(item)}</span>
                      <div><strong>{item.file_name}</strong><small>{formatBytes(item.file_size)} · {item.extension || '无扩展名'} · {item.mime_type}</small>{item.error && <b>{item.error}</b>}</div>
                      <em>{item.status === 'waiting' ? '等待上传' : item.status === 'uploading' ? '上传中' : item.status === 'success' ? (item.result?.deduplicated ? '复用地址' : '已上传') : '失败'}</em>
                      <button type="button" disabled={item.status === 'uploading'} onClick={() => setQueue((current) => current.filter((candidate) => candidate.id !== item.id))}><X size={14} /></button>
                    </article>)}
                  </div>}
                </section>

                <div className="cloud-drive-toolbar">
                  <label><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名、类型、标签或下载地址" /></label>
                  <span>显示 <strong>{filteredFiles.length}</strong> / {files.length} 个文件</span>
                  {message && <b>{message}</b>}
                </div>

                <section className="cloud-drive-file-list">
                  {filteredFiles.length === 0 ? <div className="cloud-drive-empty"><HardDriveDownload size={34} /><strong>还没有文件</strong><p>从本地选择附件并上传后，语雀地址和本地管理信息会显示在这里。</p></div> : filteredFiles.map((file) => (
                    <article key={file.id} className={selected?.id === file.id ? 'selected' : ''} onClick={() => setSelected(file)}>
                      <span className="cloud-drive-file-icon">{fileTypeIcon(file)}</span>
                      <div className="cloud-drive-file-name"><strong>{file.file_name}</strong><small>{file.mime_type} · {file.extension || '无扩展名'}</small></div>
                      <div className="cloud-drive-file-meta"><span>{formatBytes(file.file_size)}</span><small>{formatDate(file.uploaded_at)}</small></div>
                      <div className="cloud-drive-file-location"><span><Folder size={13} />{file.folder}</span><small>{file.tags.map((tag) => `#${tag}`).join(' ') || '无标签'}</small></div>
                      <div className="cloud-drive-file-actions">
                        <button title="复制下载地址" type="button" onClick={(event) => { event.stopPropagation(); void navigator.clipboard.writeText(file.remote_url); setMessage('下载地址已复制。'); }}><Copy size={15} /></button>
                        <button title="在浏览器打开" type="button" onClick={(event) => { event.stopPropagation(); void openExternalUrl(file.remote_url); }}><ExternalLink size={15} /></button>
                        <button title="下载原始文件" type="button" onClick={(event) => { event.stopPropagation(); void downloadFile(file); }}><Download size={15} /></button>
                        <button title="删除本地索引" type="button" onClick={(event) => { event.stopPropagation(); void removeFile(file); }}><Trash2 size={15} /></button>
                      </div>
                    </article>
                  ))}
                </section>
              </main>

              {selected && <aside className="cloud-drive-detail">
                <div className="cloud-drive-detail-header"><span>{fileTypeIcon(selected)}</span><div><strong>{selected.file_name}</strong><small>{formatBytes(selected.file_size)}</small></div><button type="button" onClick={() => setSelected(null)}><X size={15} /></button></div>
                <dl><div><dt>来源账号</dt><dd>{selected.account_name}</dd></div><div><dt>上传时间</dt><dd>{formatDate(selected.uploaded_at)}</dd></div><div><dt>SHA-256</dt><dd title={selected.sha256}>{selected.sha256.slice(0, 18)}…</dd></div><div><dt>原本地路径</dt><dd title={selected.local_path || ''}>{selected.local_path || '未保留'}</dd></div></dl>
                <label>文件夹<select value={folderDraft} onChange={(event) => setFolderDraft(event.target.value)}>{folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</select></label>
                <label>标签<input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="标签，用逗号分隔" /></label>
                <button className="primary" type="button" disabled={busy} onClick={() => void saveMetadata()}>保存分类信息</button>
                <button type="button" disabled={busy} onClick={() => void downloadFile(selected)}><Download size={15} />下载原始文件</button>
                <button type="button" onClick={() => void navigator.clipboard.writeText(selected.remote_url)}><Copy size={15} />复制语雀地址</button>
                <p>删除操作只移除本地 SQLite 索引，不会删除语雀服务器上的附件。</p>
              </aside>}
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
