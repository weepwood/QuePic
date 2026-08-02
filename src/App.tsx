import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clipboard,
  CloudUpload,
  Copy,
  Database,
  ExternalLink,
  FileImage,
  FolderUp,
  Gauge,
  Globe2,
  HardDrive,
  Images,
  KeyRound,
  LoaderCircle,
  LogIn,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Tags,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import { AssetPreview } from './components/AssetPreview';
import { BatchDocumentUploader } from './components/BatchDocumentUploader';
import {
  captureYuqueLogin,
  clearCookie,
  clearOpenApiToken,
  clearPreviewCache,
  deleteAsset,
  getCacheStats,
  getCredentialStatus,
  getOpenApiTokenStatus,
  getUploadQuotaStatus,
  listAssets,
  openYuqueLogin,
  saveCookie,
  saveOpenApiToken,
  updateAssetCategory,
  uploadImage,
} from './lib/tauri';
import type {
  AssetRecord,
  CacheStats,
  UploadQueueItem,
  UploadQuotaStatus,
  ViewKey,
} from './types';

const DEFAULT_ACCOUNT = 'default';
const DEFAULT_CATEGORY = '未分类';
const EMPTY_CACHE_STATS: CacheStats = { asset_count: 0, cached_count: 0, cache_bytes: 0 };
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const QUEUE_PREVIEW_EDGE = 160;
const QUEUE_PREVIEW_CONCURRENCY = 3;
const IMAGE_EXTENSION = /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;

interface QueueItemRowProps {
  item: UploadQueueItem;
  onRetry: (id: string) => void;
  onCopy: (value: string) => void;
  onRemove: (id: string) => void;
}

const QueueItemRow = memo(function QueueItemRow({ item, onRetry, onCopy, onRemove }: QueueItemRowProps) {
  return (
    <article className="queue-item">
      <img src={item.previewUrl} alt="" loading="lazy" decoding="async" draggable={false} />
      <div>
        <strong>{item.file.name}</strong>
        <small>{formatBytes(item.file.size)}{item.width && item.height ? ` · ${item.width} × ${item.height}` : ''}</small>
        {item.status === 'failed' && <b className="error-text">{item.error}</b>}
        {item.status === 'success' && (
          <b className="success-text">
            <Check size={13} />
            {item.result?.deduplicated ? '复用历史链接，不计入小时额度' : '上传并缓存成功'}
          </b>
        )}
      </div>
      <div className="item-actions">
        {item.status === 'uploading' && <LoaderCircle className="spin" size={18} />}
        {item.status === 'failed' && <button onClick={() => onRetry(item.id)}>重试</button>}
        {item.status === 'success' && item.result && (
          <button title="复制 Markdown" onClick={() => onCopy(`![${item.file.name}](${item.result?.asset.remote_url})`)}>
            <Copy size={15} />
          </button>
        )}
        <button title="移除" onClick={() => onRemove(item.id)}><X size={15} /></button>
      </div>
    </article>
  );
});

async function createQueueItem(file: File): Promise<UploadQueueItem> {
  let width: number | null = null;
  let height: number | null = null;
  let previewUrl = '';
  let bitmap: ImageBitmap | null = null;

  try {
    bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    const scale = Math.min(1, QUEUE_PREVIEW_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('无法创建图片预览画布。');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const previewBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('无法生成队列预览。')),
        'image/webp',
        0.72,
      );
    });
    previewUrl = URL.createObjectURL(previewBlob);
  } catch {
    previewUrl = URL.createObjectURL(file);
  } finally {
    bitmap?.close();
  }

  return {
    id: crypto.randomUUID(),
    file,
    previewUrl,
    width,
    height,
    status: 'waiting',
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSION.test(file.name);
}

export default function App() {
  const [view, setView] = useState<ViewKey>('upload');
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const queueRef = useRef<UploadQueueItem[]>([]);
  const [accountName, setAccountName] = useState(() => localStorage.getItem('quepic-account') || DEFAULT_ACCOUNT);
  const [credentialReady, setCredentialReady] = useState(false);
  const [tokenReady, setTokenReady] = useState(false);
  const [cookieInput, setCookieInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheStats, setCacheStats] = useState<CacheStats>(EMPTY_CACHE_STATS);
  const [cacheEpoch, setCacheEpoch] = useState(0);
  const [quota, setQuota] = useState<UploadQuotaStatus | null>(null);
  const [allowWordpressFallback, setAllowWordpressFallback] = useState(
    () => localStorage.getItem('quepic-wordpress-fallback') === 'true',
  );
  const [uploadCategory, setUploadCategory] = useState(
    () => localStorage.getItem('quepic-upload-category') || DEFAULT_CATEGORY,
  );
  const [categoryFilter, setCategoryFilter] = useState('全部');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AssetRecord | null>(null);
  const [categoryDraft, setCategoryDraft] = useState(DEFAULT_CATEGORY);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewRefreshTimerRef = useRef<number | null>(null);

  const cachePercent = cacheStats.asset_count > 0
    ? Math.round((cacheStats.cached_count / cacheStats.asset_count) * 100)
    : 0;
  const pendingUploadCount = queue.filter((item) => item.status === 'waiting' || item.status === 'failed').length;
  const quotaAvailable = !quota || quota.remaining > 0;

  const showToast = useCallback((type: 'success' | 'error', text: string) => {
    setToast({ type, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const refreshCacheStats = useCallback(async () => {
    try {
      setCacheStats(await getCacheStats());
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  }, [showToast]);

  const refreshAssets = useCallback(async () => {
    try {
      const nextAssets = await listAssets();
      setAssets(nextAssets);
      setSelected((current) => current
        ? nextAssets.find((asset) => asset.id === current.id) || null
        : null);
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  }, [showToast]);

  const refreshAccountStatus = useCallback(async () => {
    const account = accountName.trim();
    if (!account) return;
    try {
      const [credential, token, nextQuota] = await Promise.all([
        getCredentialStatus(account),
        getOpenApiTokenStatus(account),
        getUploadQuotaStatus(account),
      ]);
      setCredentialReady(credential.configured);
      setTokenReady(token.configured);
      setQuota(nextQuota);
    } catch (error) {
      setCredentialReady(false);
      setTokenReady(false);
      showToast('error', normalizeError(error));
    }
  }, [accountName, showToast]);

  const handlePreviewCached = useCallback(() => {
    if (previewRefreshTimerRef.current !== null) window.clearTimeout(previewRefreshTimerRef.current);
    previewRefreshTimerRef.current = window.setTimeout(() => {
      previewRefreshTimerRef.current = null;
      void Promise.all([refreshAssets(), refreshCacheStats()]);
    }, 1_200);
  }, [refreshAssets, refreshCacheStats]);

  useEffect(() => {
    void Promise.all([refreshAssets(), refreshAccountStatus(), refreshCacheStats()]);
  }, [refreshAssets, refreshAccountStatus, refreshCacheStats]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    if (!selected) return undefined;
    setCategoryDraft(selected.category || DEFAULT_CATEGORY);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selected]);

  useEffect(() => () => {
    queueRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    if (previewRefreshTimerRef.current !== null) window.clearTimeout(previewRefreshTimerRef.current);
  }, []);

  const categories = useMemo(() => {
    const values = new Set(assets.map((asset) => asset.category || DEFAULT_CATEGORY));
    return Array.from(values).sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }, [assets]);

  const filteredAssets = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return assets.filter((asset) => {
      const categoryMatches = categoryFilter === '全部' || asset.category === categoryFilter;
      if (!categoryMatches) return false;
      if (!keyword) return true;
      return [asset.file_name, asset.remote_url, asset.mime_type, asset.account_name, asset.category]
        .some((value) => value.toLowerCase().includes(keyword));
    });
  }, [assets, categoryFilter, search]);

  const persistAccount = () => {
    const value = accountName.trim();
    if (value) localStorage.setItem('quepic-account', value);
    return value;
  };

  const handleAccountNameBlur = () => {
    const previous = localStorage.getItem('quepic-account')?.trim() || DEFAULT_ACCOUNT;
    const next = accountName.trim() || DEFAULT_ACCOUNT;
    setAccountName(next);
    localStorage.setItem('quepic-account', next);
    if (next !== previous) {
      window.location.reload();
      return;
    }
    void refreshAccountStatus();
  };

  const handleOpenYuqueLogin = async () => {
    if (!accountName.trim()) return showToast('error', '请先填写账号名称。');
    setLoginBusy(true);
    try {
      persistAccount();
      await openYuqueLogin();
      showToast('success', '已打开语雀登录窗口。完成登录后返回这里保存会话。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const handleCaptureYuqueLogin = async () => {
    const account = persistAccount();
    if (!account) return showToast('error', '请先填写账号名称。');
    setLoginBusy(true);
    try {
      await captureYuqueLogin(account);
      setCredentialReady(true);
      showToast('success', '语雀登录会话已安全保存。');
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
      showToast('success', '已清除 QuePic 保存的语雀登录凭据。');
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  };

  const handleSaveToken = async () => {
    const account = persistAccount();
    if (!account || !tokenInput.trim()) return;
    setTokenBusy(true);
    try {
      await saveOpenApiToken(account, tokenInput.trim());
      setTokenInput('');
      setTokenReady(true);
      showToast('success', 'OpenAPI Token 已保存到系统密钥库。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setTokenBusy(false);
    }
  };

  const handleClearToken = async () => {
    const account = accountName.trim();
    if (!account) return;
    setTokenBusy(true);
    try {
      await clearOpenApiToken(account);
      setTokenReady(false);
      setTokenInput('');
      showToast('success', 'OpenAPI Token 已从系统密钥库清除。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setTokenBusy(false);
    }
  };

  const handleWordpressFallbackChange = (enabled: boolean) => {
    setAllowWordpressFallback(enabled);
    localStorage.setItem('quepic-wordpress-fallback', String(enabled));
    setCacheEpoch((value) => value + 1);
  };

  const handleClearPreviewCache = async () => {
    setCacheBusy(true);
    try {
      setCacheStats(await clearPreviewCache());
      await refreshAssets();
      setCacheEpoch((value) => value + 1);
      showToast('success', '本地缓存已清理。进入视口的图片会通过已上传 URL 限速重建缩略图。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setCacheBusy(false);
    }
  };

  const addFiles = async (files: File[]) => {
    const accepted = files.filter((file) => isImageFile(file) && file.size > 0 && file.size <= MAX_UPLOAD_BYTES);
    if (accepted.length !== files.length) showToast('error', '已忽略非图片、空文件或超过 50 MB 的图片。');
    const items = await mapWithConcurrency(accepted, QUEUE_PREVIEW_CONCURRENCY, createQueueItem);
    setQueue((current) => [...items, ...current]);
  };

  const uploadOne = useCallback(async (id: string) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item || item.status === 'uploading') return;
    setQueue((current) => current.map((candidate) =>
      candidate.id === id ? { ...candidate, status: 'uploading', error: undefined } : candidate,
    ));
    try {
      const category = uploadCategory.trim() || DEFAULT_CATEGORY;
      localStorage.setItem('quepic-upload-category', category);
      const result = await uploadImage(item.file, accountName, item.width, item.height, category);
      setQueue((current) => current.map((candidate) =>
        candidate.id === id ? { ...candidate, status: 'success', result } : candidate,
      ));
      const [nextQuota] = await Promise.all([
        getUploadQuotaStatus(accountName),
        refreshAssets(),
        refreshCacheStats(),
      ]);
      setQuota(nextQuota);
    } catch (error) {
      setQueue((current) => current.map((candidate) =>
        candidate.id === id ? { ...candidate, status: 'failed', error: normalizeError(error) } : candidate,
      ));
      try {
        setQuota(await getUploadQuotaStatus(accountName));
      } catch {
        // 上传错误本身已在队列中展示。
      }
    }
  }, [accountName, refreshAssets, refreshCacheStats, uploadCategory]);

  const uploadAll = async () => {
    if (!credentialReady) {
      setView('settings');
      return showToast('error', '请先登录语雀并保存会话。');
    }
    if (!quotaAvailable) return showToast('error', `当前小时上传额度已用完，请在 ${formatResetTime(quota?.reset_at || null)} 后继续。`);
    const ids = queueRef.current
      .filter((item) => item.status === 'waiting' || item.status === 'failed')
      .map((item) => item.id);
    for (const id of ids) await uploadOne(id);
  };

  const copyText = useCallback(async (value: string) => {
    await navigator.clipboard.writeText(value);
    showToast('success', '已复制到剪贴板');
  }, [showToast]);

  const removeQueueItem = useCallback((id: string) => {
    setQueue((current) => {
      const target = current.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const handleDeleteAsset = async (asset: AssetRecord) => {
    try {
      await deleteAsset(asset.id);
      setSelected(null);
      await Promise.all([refreshAssets(), refreshCacheStats()]);
      showToast('success', '本地记录和对应缓存已删除，语雀远程图片未删除。');
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  };

  const handleSaveCategory = async () => {
    if (!selected) return;
    try {
      const updated = await updateAssetCategory(selected.id, categoryDraft.trim() || DEFAULT_CATEGORY);
      setSelected(updated);
      await refreshAssets();
      showToast('success', `图片已归类到“${updated.category}”。`);
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  };

  const navItems: Array<{ key: ViewKey; label: string; icon: typeof CloudUpload }> = [
    { key: 'upload', label: '上传', icon: CloudUpload },
    { key: 'document', label: '文件夹转文档', icon: FolderUp },
    { key: 'library', label: '图片库', icon: Images },
    { key: 'settings', label: '设置', icon: Settings },
  ];

  const pageInfo: Record<ViewKey, { title: string; description: string }> = {
    upload: { title: '上传图片', description: '受控限速上传到语雀，并同步建立本地预览。' },
    document: { title: '文件夹转文档', description: '按文件名顺序上传整个文件夹并创建语雀文档。' },
    library: { title: '图片库', description: '本地缓存优先，缺失时从已上传 URL 限速恢复缩略图。' },
    settings: { title: '设置', description: '管理语雀会话、OpenAPI Token、缓存与上传额度。' },
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={18} /></span>
          <div><strong>QuePic</strong><small>本地优先的雀图库</small></div>
        </div>
        <nav>
          {navItems.map(({ key, label, icon: Icon }) => (
            <button key={key} className={view === key ? 'nav-item active' : 'nav-item'} onClick={() => setView(key)}>
              <Icon size={18} /><span>{label}</span>{key === 'library' && <em>{assets.length}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-cache-card">
          <div className="sidebar-cache-heading"><HardDrive size={15} /><span>本地缓存</span><strong>{cachePercent}%</strong></div>
          <div className="cache-progress"><span style={{ width: `${cachePercent}%` }} /></div>
          <small>{cacheStats.cached_count}/{cacheStats.asset_count} 张 · {formatBytes(cacheStats.cache_bytes)}</small>
        </div>
        <div className="sidebar-quota-card">
          <Gauge size={15} />
          <div><strong>{quota ? `${quota.remaining}/${quota.limit}` : '--'} 张可用</strong><small>滚动一小时上传额度</small></div>
        </div>
        <div className="credential-summary">
          <span className={credentialReady ? 'dot ready' : 'dot'} />
          <div><strong>{credentialReady ? '语雀账号可用' : '尚未登录语雀'}</strong><small>{tokenReady ? '会话与 Token 已就绪' : '前往设置完善配置'}</small></div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="page-title"><span>QUEPIC WORKSPACE</span><h1>{pageInfo[view].title}</h1><p>{pageInfo[view].description}</p></div>
          <div className="account-pill"><span className={credentialReady ? 'dot ready' : 'dot'} /><div><strong>{accountName}</strong><small>{credentialReady ? '语雀会话已保存' : '未连接语雀'}</small></div></div>
        </header>

        <section className="content">
          {view === 'upload' && (
            <div className="upload-layout">
              <div
                className="drop-zone"
                onDragOver={(event: React.DragEvent<HTMLDivElement>) => event.preventDefault()}
                onDrop={(event: React.DragEvent<HTMLDivElement>) => {
                  event.preventDefault();
                  void addFiles(Array.from(event.dataTransfer.files));
                }}
              >
                <input ref={fileInputRef} hidden type="file" accept="image/*" multiple onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                  void addFiles(Array.from(event.target.files || []));
                  event.currentTarget.value = '';
                }} />
                <span className="drop-eyebrow">RATE-LIMITED UPLOAD</span>
                <span className="drop-icon"><UploadCloud size={34} /></span>
                <h2>将图片拖到这里</h2>
                <p>远程上传至少间隔 25 秒，并使用滚动一小时额度；重复图片直接复用历史链接。</p>
                <label className="upload-category-field">
                  <Tags size={16} />
                  <input value={uploadCategory} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setUploadCategory(event.target.value)} placeholder="上传分类" list="category-options" />
                </label>
                <datalist id="category-options">{categories.map((category) => <option value={category} key={category} />)}</datalist>
                <div className="drop-hints"><span>单张 50 MB</span><span>140 张/小时</span><span>自动去重</span></div>
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
                <div className="panel-heading">
                  <div><span>UPLOAD QUEUE</span><h2>上传队列</h2><p>{pendingUploadCount ? `${pendingUploadCount} 项等待处理` : '没有待处理任务'}</p></div>
                  <button className="button primary compact" disabled={!credentialReady || !quotaAvailable || pendingUploadCount === 0} onClick={() => void uploadAll()}><UploadCloud size={16} />全部上传</button>
                </div>
                <div className="quota-strip">
                  <Gauge size={16} />
                  <span>{quota ? `过去一小时已使用 ${quota.used}/${quota.limit}，剩余 ${quota.remaining}` : '正在读取上传额度'}</span>
                  {quota?.retry_after_seconds ? <b>{formatDuration(quota.retry_after_seconds)} 后可继续</b> : <b>可上传</b>}
                </div>
                {!credentialReady && <div className="warning">请先在设置中登录语雀并保存会话。</div>}
                {queue.length === 0 ? <div className="empty"><FileImage size={26} /><p>待上传图片会显示在这里。</p></div> : (
                  <div className="queue-list">
                    {queue.map((item) => (
                      <QueueItemRow key={item.id} item={item} onRetry={uploadOne} onCopy={copyText} onRemove={removeQueueItem} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {view === 'document' && (
            <BatchDocumentUploader accountName={accountName} onUploaded={() => void Promise.all([refreshAssets(), refreshCacheStats(), refreshAccountStatus()])} />
          )}

          {view === 'library' && (
            <div className="library-layout">
              <div className="library-main">
                <div className="library-heading">
                  <div><span>LOCAL FIRST ASSET INDEX</span><h2>所有图片</h2><p>缓存缺失时从已上传 URL 限速获取缩略图，失败后可手动重试。</p></div>
                  <label className="search"><Search size={17} /><input value={search} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)} placeholder="搜索文件名、分类、链接或类型" /></label>
                </div>
                <div className="category-filter">
                  {['全部', ...categories].map((category) => (
                    <button key={category} className={categoryFilter === category ? 'active' : ''} onClick={() => setCategoryFilter(category)}>{category}</button>
                  ))}
                </div>
                <div className="library-overview">
                  <div><Images size={18} /><span><strong>{assets.length}</strong><small>图片记录</small></span></div>
                  <div><Tags size={18} /><span><strong>{categories.length}</strong><small>图片分类</small></span></div>
                  <div><HardDrive size={18} /><span><strong>{cacheStats.cached_count}</strong><small>本地缓存</small></span></div>
                  <div><Database size={18} /><span><strong>{formatBytes(cacheStats.cache_bytes)}</strong><small>缓存占用</small></span></div>
                </div>
                {filteredAssets.length === 0 ? <div className="empty large"><Images size={30} /><h3>{assets.length ? '没有匹配图片' : '还没有上传记录'}</h3></div> : (
                  <div className="asset-grid">
                    {filteredAssets.map((asset) => (
                      <article
                        className="asset-card"
                        key={asset.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`查看 ${asset.file_name}`}
                        onClick={() => setSelected(asset)}
                        onKeyDown={(event: React.KeyboardEvent<HTMLElement>) => {
                          if (event.key === 'Enter' || event.key === ' ') setSelected(asset);
                        }}
                      >
                        <AssetPreview asset={asset} allowWordpressFallback={allowWordpressFallback} cacheEpoch={cacheEpoch} onCacheChanged={handlePreviewCached} />
                        <div className="asset-card-body">
                          <strong>{asset.file_name}</strong>
                          <span className="asset-category-tag">{asset.category || DEFAULT_CATEGORY}</span>
                          <span className={asset.cache_status === 'ready' ? 'asset-cache-state ready' : 'asset-cache-state'}>{asset.cache_status === 'ready' ? '已缓存' : '按需缓存'}</span>
                          <small>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.mime_type}</small>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
              {selected && (
                <>
                  <button className="detail-backdrop" aria-label="关闭图片详情" onClick={() => setSelected(null)} />
                  <aside className="detail" aria-label="图片详情">
                    <button className="detail-close" aria-label="关闭图片详情" onClick={() => setSelected(null)}><X size={17} /></button>
                    <AssetPreview asset={selected} preferOriginal allowWordpressFallback={allowWordpressFallback} cacheEpoch={cacheEpoch} className="detail-preview" onCacheChanged={handlePreviewCached} />
                    <div className="detail-body">
                      <span>IMAGE DETAILS</span><h3>{selected.file_name}</h3>
                      <dl>
                        <div><dt>分类</dt><dd>{selected.category}</dd></div>
                        <div><dt>尺寸</dt><dd>{selected.width && selected.height ? `${selected.width} × ${selected.height}` : '未知'}</dd></div>
                        <div><dt>格式</dt><dd>{selected.mime_type}</dd></div>
                        <div><dt>大小</dt><dd>{formatBytes(selected.file_size)}</dd></div>
                        <div><dt>缓存</dt><dd>{selected.cache_status === 'ready' ? formatBytes(selected.cache_bytes || 0) : '按需建立'}</dd></div>
                        <div><dt>上传时间</dt><dd>{new Date(selected.uploaded_at).toLocaleString()}</dd></div>
                      </dl>
                      <label className="field detail-category-field">
                        <span>图片分类</span>
                        <input value={categoryDraft} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setCategoryDraft(event.target.value)} list="category-options" placeholder="未分类" />
                      </label>
                      <button className="button primary" onClick={() => void handleSaveCategory()}><Save size={16} />保存分类</button>
                      <button className="button secondary" onClick={() => void copyText(selected.remote_url)}><Copy size={16} />复制 URL</button>
                      <button className="button secondary" onClick={() => void copyText(`![${selected.file_name}](${selected.remote_url})`)}><Copy size={16} />复制 Markdown</button>
                      <button className="button secondary" onClick={() => window.open(selected.remote_url, '_blank')}><ExternalLink size={16} />浏览器打开</button>
                      <button className="button danger" onClick={() => void handleDeleteAsset(selected)}><Trash2 size={16} />删除本地记录和缓存</button>
                      <p>删除操作不会删除语雀服务器上的远程图片。</p>
                    </div>
                  </aside>
                </>
              )}
            </div>
          )}

          {view === 'settings' && (
            <div className="settings-layout">
              <div className="settings-stack">
                <div className="panel settings-panel">
                  <div className="panel-heading"><div><span>YUQUE ACCOUNT</span><h2>语雀登录</h2><p>登录会话用于上传图片，以及私有图片回源。</p></div><div className={credentialReady ? 'status ready-status' : 'status'}>{credentialReady ? <CheckCircle2 size={15} /> : <KeyRound size={15} />}{credentialReady ? '已连接' : '未连接'}</div></div>
                  <label className="field"><span>账号名称</span><input value={accountName} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAccountName(event.target.value)} onBlur={handleAccountNameBlur} placeholder="default" /><small>Cookie、Token 和上传额度均按账号隔离；账号变化后应用会统一切换上下文。</small></label>
                  <div className="actions">
                    <button className="button primary" disabled={loginBusy || !accountName.trim()} onClick={() => void handleOpenYuqueLogin()}>{loginBusy ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}登录语雀</button>
                    <button className="button secondary" disabled={loginBusy || !accountName.trim()} onClick={() => void handleCaptureYuqueLogin()}><ShieldCheck size={17} />完成登录并保存</button>
                    <button className="button danger" disabled={!credentialReady} onClick={() => void handleClearCredential()}><Trash2 size={17} />清除登录凭据</button>
                  </div>
                  <details>
                    <summary>高级：手动粘贴 Cookie</summary>
                    <label className="field"><span>完整 Cookie</span><textarea value={cookieInput} onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setCookieInput(event.target.value)} rows={6} placeholder="从 /api/upload/attach 请求头复制完整 Cookie 值" /><small>长 Cookie 会自动拆分成多个系统密钥库条目。</small></label>
                    <button className="button secondary" disabled={loginBusy || !accountName.trim() || !cookieInput.trim()} onClick={() => void handleManualCookieSave()}><ShieldCheck size={17} />手动安全保存</button>
                  </details>
                </div>

                <div className="panel settings-panel token-panel">
                  <div className="panel-heading"><div><span>YUQUE OPENAPI</span><h2>OpenAPI Token</h2><p>用于“文件夹转文档”创建 Markdown 文档，按账号保存到系统密钥库。</p></div><div className={tokenReady ? 'status ready-status' : 'status'}>{tokenReady ? <CheckCircle2 size={15} /> : <KeyRound size={15} />}{tokenReady ? '已保存' : '未配置'}</div></div>
                  <label className="field"><span>Token</span><input type="password" autoComplete="off" value={tokenInput} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTokenInput(event.target.value)} placeholder={tokenReady ? '输入新 Token 可覆盖现有配置' : '粘贴语雀 OpenAPI Token'} /><small>Token 不写入 localStorage、SQLite 或前端配置文件。</small></label>
                  <div className="actions">
                    <button className="button primary" disabled={tokenBusy || !accountName.trim() || !tokenInput.trim()} onClick={() => void handleSaveToken()}>{tokenBusy ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}安全保存 Token</button>
                    <button className="button danger" disabled={tokenBusy || !tokenReady} onClick={() => void handleClearToken()}><Trash2 size={17} />清除 Token</button>
                  </div>
                </div>

                <div className="panel settings-panel quota-panel">
                  <div className="panel-heading"><div><span>UPLOAD GOVERNOR</span><h2>上传速度与额度</h2><p>为语雀上传接口保留安全余量，避免接近每小时约 150 张的上限。</p></div><Gauge size={20} /></div>
                  <div className="quota-metrics">
                    <div><strong>{quota?.used ?? 0}</strong><small>过去一小时尝试</small></div>
                    <div><strong>{quota?.remaining ?? 140}</strong><small>剩余额度</small></div>
                    <div><strong>{quota?.minimum_interval_seconds ?? 25}s</strong><small>最小间隔</small></div>
                  </div>
                  <p className="panel-note">QuePic 使用 140 次/小时的保守上限。失败请求也计入本地额度，重复图片在上传前去重，不计入额度。</p>
                </div>

                <div className="panel settings-panel cache-panel">
                  <div className="panel-heading"><div><span>PREVIEW CACHE</span><h2>图片显示与缓存</h2><p>本地缓存 → 已上传 URL 限速缩略图 → 语雀会话回源 → 可选兼容代理。</p></div><HardDrive size={20} /></div>
                  <div className="cache-metrics">
                    <div><Database size={17} /><strong>{cacheStats.cached_count}/{cacheStats.asset_count}</strong><small>已缓存图片</small></div>
                    <div><HardDrive size={17} /><strong>{formatBytes(cacheStats.cache_bytes)}</strong><small>缓存占用</small></div>
                  </div>
                  <label className="toggle-row">
                    <span><Globe2 size={17} /><span><strong>WordPress CDN 兼容兜底</strong><small>仅在本地、远程 URL 和语雀回源均失败时使用 `i3.wp.com`。</small></span></span>
                    <input className="switch-input" type="checkbox" checked={allowWordpressFallback} onChange={(event: React.ChangeEvent<HTMLInputElement>) => handleWordpressFallbackChange(event.target.checked)} />
                  </label>
                  <div className="actions"><button className="button danger" disabled={cacheBusy || cacheStats.cached_count === 0} onClick={() => void handleClearPreviewCache()}>{cacheBusy ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}清理本地缓存</button></div>
                </div>
              </div>
              <div className="guide"><ShieldCheck size={24} /><div><h3>受控访问策略</h3><ol><li>缩略图只在接近可视区域时按需请求。</li><li>远程 URL 回源最多两路并发，并保持全局访问间隔。</li><li>所有远程地址必须使用 HTTPS 且属于语雀或 nlark 域名。</li><li>上传使用 140 次/小时与 25 秒最小间隔双重限制。</li><li>OpenAPI Token 与 Cookie 均保存在系统密钥库。</li></ol></div></div>
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
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} 分钟`;
}

function formatResetTime(value: string | null): string {
  if (!value) return '稍后';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function normalizeError(error: unknown) {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '操作失败，请检查语雀登录状态、网络连接和本地缓存权限。';
}
