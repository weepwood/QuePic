import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clipboard,
  CloudUpload,
  Copy,
  ExternalLink,
  FileImage,
  Images,
  KeyRound,
  LoaderCircle,
  LogIn,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  captureYuqueLogin,
  clearCookie,
  deleteAsset,
  getCredentialStatus,
  listAssets,
  openYuqueLogin,
  saveCookie,
  uploadImage,
} from './lib/tauri';
import type { AssetRecord, UploadQueueItem, ViewKey } from './types';

const DEFAULT_ACCOUNT = 'default';

export default function App() {
  const [view, setView] = useState<ViewKey>('upload');
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const queueRef = useRef<UploadQueueItem[]>([]);
  const [accountName, setAccountName] = useState(() => localStorage.getItem('quepic-account') || DEFAULT_ACCOUNT);
  const [credentialReady, setCredentialReady] = useState(false);
  const [cookieInput, setCookieInput] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AssetRecord | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((type: 'success' | 'error', text: string) => {
    setToast({ type, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const refreshAssets = useCallback(async () => {
    try {
      setAssets(await listAssets());
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  }, [showToast]);

  const refreshCredential = useCallback(async () => {
    try {
      const status = await getCredentialStatus(accountName);
      setCredentialReady(status.configured);
    } catch (error) {
      setCredentialReady(false);
      showToast('error', normalizeError(error));
    }
  }, [accountName, showToast]);

  useEffect(() => {
    void refreshAssets();
    void refreshCredential();
  }, [refreshAssets, refreshCredential]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => () => {
    queueRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  }, []);

  const filteredAssets = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return assets;
    return assets.filter((asset) =>
      [asset.file_name, asset.remote_url, asset.mime_type, asset.account_name]
        .some((value) => value.toLowerCase().includes(keyword)),
    );
  }, [assets, search]);

  const persistAccount = () => {
    const value = accountName.trim();
    if (value) localStorage.setItem('quepic-account', value);
    return value;
  };

  const handleOpenYuqueLogin = async () => {
    if (!accountName.trim()) {
      showToast('error', '请先填写账号名称。');
      return;
    }
    setLoginBusy(true);
    try {
      persistAccount();
      await openYuqueLogin();
      showToast('success', '已打开语雀登录窗口。完成登录后返回这里点击“完成登录并保存”。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const handleCaptureYuqueLogin = async () => {
    const account = persistAccount();
    if (!account) {
      showToast('error', '请先填写账号名称。');
      return;
    }
    setLoginBusy(true);
    try {
      await captureYuqueLogin(account);
      setCredentialReady(true);
      showToast('success', '语雀登录会话已安全保存，可以开始上传。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const handleManualCookieSave = async () => {
    const account = persistAccount();
    if (!account || !cookieInput.trim()) return;
    setLoginBusy(true);
    try {
      await saveCookie(account, cookieInput.trim());
      setCookieInput('');
      setCredentialReady(true);
      showToast('success', 'Cookie 已分片保存到系统密钥库。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const handleClearCredential = async () => {
    const account = accountName.trim();
    if (!account) return;
    try {
      await clearCookie(account);
      setCredentialReady(false);
      showToast('success', '已清除 QuePic 保存的语雀凭据。');
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  };

  const addFiles = async (files: File[]) => {
    const accepted = files.filter((file) => file.type.startsWith('image/') && file.size <= 25 * 1024 * 1024);
    if (accepted.length !== files.length) {
      showToast('error', '已忽略非图片文件或超过 25 MB 的图片。');
    }
    const items = await Promise.all(accepted.map(async (file): Promise<UploadQueueItem> => {
      let width: number | null = null;
      let height: number | null = null;
      try {
        const bitmap = await createImageBitmap(file);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close();
      } catch {
        // SVG 等格式仍可上传，尺寸留空。
      }
      return {
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        width,
        height,
        status: 'waiting',
      };
    }));
    setQueue((current) => [...items, ...current]);
  };

  const uploadOne = async (id: string) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item || item.status === 'uploading') return;
    setQueue((current) => current.map((candidate) =>
      candidate.id === id ? { ...candidate, status: 'uploading', error: undefined } : candidate,
    ));
    try {
      const result = await uploadImage(item.file, accountName, item.width, item.height);
      setQueue((current) => current.map((candidate) =>
        candidate.id === id ? { ...candidate, status: 'success', result } : candidate,
      ));
      await refreshAssets();
    } catch (error) {
      setQueue((current) => current.map((candidate) =>
        candidate.id === id ? { ...candidate, status: 'failed', error: normalizeError(error) } : candidate,
      ));
    }
  };

  const uploadAll = async () => {
    if (!credentialReady) {
      setView('settings');
      showToast('error', '请先登录语雀并保存会话。');
      return;
    }
    const ids = queueRef.current
      .filter((item) => item.status === 'waiting' || item.status === 'failed')
      .map((item) => item.id);
    for (const id of ids) await uploadOne(id);
  };

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
    showToast('success', '已复制到剪贴板');
  };

  const removeQueueItem = (id: string) => {
    setQueue((current) => {
      const target = current.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  };

  const navItems: Array<{ key: ViewKey; label: string; icon: typeof CloudUpload }> = [
    { key: 'upload', label: '上传', icon: CloudUpload },
    { key: 'library', label: '图片库', icon: Images },
    { key: 'settings', label: '设置', icon: Settings },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={18} /></span>
          <div><strong>QuePic</strong><small>雀图库</small></div>
        </div>
        <nav>
          {navItems.map(({ key, label, icon: Icon }) => (
            <button key={key} className={view === key ? 'nav-item active' : 'nav-item'} onClick={() => setView(key)}>
              <Icon size={18} /><span>{label}</span>{key === 'library' && <em>{assets.length}</em>}
            </button>
          ))}
        </nav>
        <div className="credential-summary">
          <span className={credentialReady ? 'dot ready' : 'dot'} />
          <div><strong>{credentialReady ? '语雀账号可用' : '尚未登录语雀'}</strong><small>{credentialReady ? '会话分片位于系统密钥库' : '前往设置完成登录'}</small></div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div><h1>{view === 'upload' ? '上传图片' : view === 'library' ? '图片库' : '设置'}</h1><p>{view === 'upload' ? '上传到语雀并建立本地索引。' : view === 'library' ? '搜索、查看和复制远程链接。' : '登录语雀并管理本地安全凭据。'}</p></div>
          <div className="account-pill"><span className={credentialReady ? 'dot ready' : 'dot'} /><div><strong>{accountName}</strong><small>{credentialReady ? '语雀会话已安全保存' : '未连接语雀'}</small></div></div>
        </header>

        <section className="content">
          {view === 'upload' && (
            <div className="upload-layout">
              <div
                className="drop-zone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void addFiles(Array.from(event.dataTransfer.files));
                }}
              >
                <input ref={fileInputRef} hidden type="file" accept="image/*" multiple onChange={(event) => {
                  void addFiles(Array.from(event.target.files || []));
                  event.currentTarget.value = '';
                }} />
                <span className="drop-icon"><UploadCloud size={34} /></span>
                <h2>将图片拖到这里</h2>
                <p>支持 PNG、JPEG、GIF、WebP、SVG 等格式，单张最大 25 MB。</p>
                <div className="actions">
                  <button className="button primary" onClick={() => fileInputRef.current?.click()}><FileImage size={17} />选择图片</button>
                  <button className="button secondary" onClick={async () => {
                    try {
                      const clipboardItems = await navigator.clipboard.read();
                      const files: File[] = [];
                      for (const item of clipboardItems) {
                        const imageType = item.types.find((type) => type.startsWith('image/'));
                        if (!imageType) continue;
                        const blob = await item.getType(imageType);
                        files.push(new File([blob], `clipboard-${Date.now()}.${imageType.split('/')[1] || 'png'}`, { type: imageType }));
                      }
                      await addFiles(files);
                    } catch (error) {
                      showToast('error', normalizeError(error));
                    }
                  }}><Clipboard size={17} />粘贴图片</button>
                </div>
              </div>

              <div className="panel queue-panel">
                <div className="panel-heading"><div><span>UPLOAD QUEUE</span><h2>上传队列</h2></div><button className="button primary compact" disabled={!credentialReady || !queue.some((item) => item.status === 'waiting' || item.status === 'failed')} onClick={() => void uploadAll()}><UploadCloud size={16} />全部上传</button></div>
                {!credentialReady && <div className="warning">请先在设置中登录语雀并保存会话。</div>}
                {queue.length === 0 ? <div className="empty"><FileImage size={26} /><p>待上传图片会显示在这里。</p></div> : (
                  <div className="queue-list">
                    {queue.map((item) => (
                      <article className="queue-item" key={item.id}>
                        <img src={item.previewUrl} alt="" />
                        <div><strong>{item.file.name}</strong><small>{formatBytes(item.file.size)}{item.width && item.height ? ` · ${item.width} × ${item.height}` : ''}</small>{item.status === 'failed' && <b className="error-text">{item.error}</b>}{item.status === 'success' && <b className="success-text"><Check size={13} />{item.result?.deduplicated ? '复用历史链接' : '上传成功'}</b>}</div>
                        <div className="item-actions">{item.status === 'uploading' && <LoaderCircle className="spin" size={18} />}{item.status === 'failed' && <button onClick={() => void uploadOne(item.id)}>重试</button>}{item.status === 'success' && item.result && <button title="复制 Markdown" onClick={() => void copyText(`![${item.file.name}](${item.result?.asset.remote_url})`)}><Copy size={15} /></button>}<button onClick={() => removeQueueItem(item.id)}><X size={15} /></button></div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {view === 'library' && (
            <div className="library-layout">
              <div className="library-main">
                <div className="library-heading"><div><span>LOCAL ASSET INDEX</span><h2>所有图片</h2><p>{assets.length} 张已记录图片</p></div><label className="search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名、链接或类型" /></label></div>
                {filteredAssets.length === 0 ? <div className="empty large"><Images size={30} /><h3>{assets.length ? '没有匹配图片' : '还没有上传记录'}</h3></div> : <div className="asset-grid">{filteredAssets.map((asset) => <button className="asset-card" key={asset.id} onClick={() => setSelected(asset)}><div><img src={asset.remote_url} alt={asset.file_name} loading="lazy" /></div><strong>{asset.file_name}</strong><small>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.mime_type}</small></button>)}</div>}
              </div>
              {selected && <aside className="detail"><img src={selected.remote_url} alt={selected.file_name} /><div><span>IMAGE DETAILS</span><h3>{selected.file_name}</h3><dl><div><dt>尺寸</dt><dd>{selected.width && selected.height ? `${selected.width} × ${selected.height}` : '未知'}</dd></div><div><dt>格式</dt><dd>{selected.mime_type}</dd></div><div><dt>大小</dt><dd>{formatBytes(selected.file_size)}</dd></div><div><dt>上传时间</dt><dd>{new Date(selected.uploaded_at).toLocaleString()}</dd></div></dl><button className="button primary" onClick={() => void copyText(selected.remote_url)}><Copy size={16} />复制 URL</button><button className="button secondary" onClick={() => void copyText(`![${selected.file_name}](${selected.remote_url})`)}><Copy size={16} />复制 Markdown</button><button className="button secondary" onClick={() => window.open(selected.remote_url, '_blank')}><ExternalLink size={16} />浏览器打开</button><button className="button danger" onClick={() => void deleteAsset(selected.id).then(refreshAssets).then(() => setSelected(null)).catch((error) => showToast('error', normalizeError(error)))}><Trash2 size={16} />删除本地记录</button><p>删除本地记录不会删除语雀服务器上的图片。</p></div></aside>}
            </div>
          )}

          {view === 'settings' && (
            <div className="settings-layout">
              <div className="panel settings-panel">
                <div className="panel-heading"><div><span>YUQUE ACCOUNT</span><h2>语雀登录</h2><p>在 QuePic 的独立窗口中登录语雀，Rust 后端会读取包含 HttpOnly 的会话 Cookie，并分片写入系统密钥库。</p></div><div className={credentialReady ? 'status ready-status' : 'status'}>{credentialReady ? <CheckCircle2 size={15} /> : <KeyRound size={15} />}{credentialReady ? '已连接' : '未连接'}</div></div>
                <label className="field"><span>账号名称</span><input value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="default" /><small>仅用于区分 QuePic 中保存的多组凭据，不要求与语雀昵称一致。</small></label>
                <div className="actions">
                  <button className="button primary" disabled={loginBusy || !accountName.trim()} onClick={() => void handleOpenYuqueLogin()}>{loginBusy ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}登录语雀</button>
                  <button className="button secondary" disabled={loginBusy || !accountName.trim()} onClick={() => void handleCaptureYuqueLogin()}><ShieldCheck size={17} />完成登录并保存</button>
                  <button className="button danger" disabled={!credentialReady} onClick={() => void handleClearCredential()}><Trash2 size={17} />清除凭据</button>
                </div>
                <details>
                  <summary>高级：手动粘贴 Cookie</summary>
                  <label className="field"><span>完整 Cookie</span><textarea value={cookieInput} onChange={(event) => setCookieInput(event.target.value)} rows={6} placeholder="从 /api/upload/attach 请求头复制完整 Cookie 值" /><small>长 Cookie 会自动拆分成多个系统密钥库条目，避免 Windows 单条凭据 2560 字符限制。</small></label>
                  <button className="button secondary" disabled={loginBusy || !accountName.trim() || !cookieInput.trim()} onClick={() => void handleManualCookieSave()}><ShieldCheck size={17} />手动安全保存</button>
                </details>
              </div>
              <div className="guide"><ShieldCheck size={24} /><div><h3>登录流程</h3><ol><li>填写用于区分凭据的账号名称。</li><li>点击“登录语雀”，在独立窗口中完成扫码或账号登录。</li><li>登录成功并看到语雀主页后，返回 QuePic。</li><li>点击“完成登录并保存”。</li><li>QuePic 只保存语雀域名对应的 Cookie，不读取密码。</li></ol></div></div>
            </div>
          )}
        </section>
      </main>

      {toast && <div className={toast.type === 'success' ? 'toast success' : 'toast error'}>{toast.type === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}<span>{toast.text}</span></div>}
    </div>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function normalizeError(error: unknown) {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '操作失败，请检查语雀登录状态和网络连接。';
}
