import {
  AlertTriangle,
  ArrowUpDown,
  CalendarClock,
  Check,
  CheckCircle2,
  CheckSquare,
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
  ListChecks,
  LoaderCircle,
  Maximize2,
  LogIn,
  Plus,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Tags,
  Trash2,
  UploadCloud,
  UserRound,
  X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import { AssetPreview } from './components/AssetPreview';
import { BatchDocumentUploader } from './components/BatchDocumentUploader';
import { OriginalImageViewer } from './components/OriginalImageViewer';
import {
  appendImagesToDailyDocument,
  ensureDailyImageDocument,
  captureYuqueLogin,
  clearCookie,
  clearOpenApiToken,
  clearPreviewCache,
  createLibraryFolder,
  deleteAsset,
  getCacheStats,
  getCredentialStatus,
  getOpenApiTokenStatus,
    getUploadQuotaStatus,
    getStoredUploadContext,
    listAccountProfiles,

  listAssetTags,
  listAssets,
  listLibraryFolders,
  openExternalUrl,
  openYuqueLogin,
  saveAccountProfile,
  saveCookie,
    saveOpenApiToken,
    resolveUploadContext,
    saveStoredUploadContext,
    clearStoredUploadContext,
    updateAssetCategory,
    updateAssetTags,

  uploadImage,
} from './lib/tauri';
import {
  listStoredQueueItems,
  removeStoredQueueItem,
  saveStoredQueueItem,
  saveStoredQueueItems,
  toStoredQueueItem,
} from './lib/uploadQueueStore';
import type {
  AccountProfile,
  AssetRecord,
  CacheStats,
  DailyDocumentImage,
  StoredUploadQueueItem,
    UploadContextResult,
    UploadQueueItem,
    UploadQuotaStatus,

  ViewKey,
} from './types';

const DEFAULT_ACCOUNT = 'default';
const DEFAULT_CATEGORY = '未分类';
const EMPTY_CACHE_STATS: CacheStats = { asset_count: 0, cached_count: 0, cache_bytes: 0 };
const NO_TOKEN_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const TOKEN_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const QUEUE_PREVIEW_EDGE = 160;
const QUEUE_PREVIEW_CONCURRENCY = 3;
const AUTO_UPLOAD_DELAY_MS = 60 * 60 * 1000;
const IMAGE_EXTENSION = /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;

type LibrarySort = 'newest' | 'oldest' | 'name' | 'size' | 'category';
type LibraryViewMode = 'original' | 'square';

interface QueueItemRowProps {
  item: UploadQueueItem;
  onRetry: (id: string) => void;
  onCopy: (value: string) => void;
  onRemove: (id: string) => void;
}

const QueueItemRow = memo(function QueueItemRow({ item, onRetry, onCopy, onRemove }: QueueItemRowProps) {
  return (
    <article className={item.status === 'scheduled' ? 'queue-item scheduled' : 'queue-item'}>
      <img src={item.previewUrl} alt="" loading="lazy" decoding="async" draggable={false} />
      <div>
        <strong>{item.file.name}</strong>
        <small>
          {formatBytes(item.file.size)}
          {item.width && item.height ? ` · ${item.width} × ${item.height}` : ''}
          {` · ${item.category}`}
        </small>
        {item.status === 'scheduled' && item.scheduledAt && (
          <b className="scheduled-text"><CalendarClock size={13} />{formatScheduleTime(item.scheduledAt)} 自动上传</b>
        )}
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
        {(item.status === 'failed' || item.status === 'scheduled') && <button onClick={() => onRetry(item.id)}>立即上传</button>}
        {item.status === 'success' && item.result && (
          <button title="复制 Markdown" onClick={() => onCopy(`![${item.file.name}](${item.result?.asset.remote_url})`)}>
            <Copy size={15} />
          </button>
        )}
        <button title="移除" disabled={item.status === 'uploading'} onClick={() => onRemove(item.id)}><X size={15} /></button>
      </div>
    </article>
  );
});

async function createPreview(file: File): Promise<{ previewUrl: string; width: number | null; height: number | null }> {
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

  return { previewUrl, width, height };
}

async function createQueueItem(file: File, accountName: string, category: string, tags: string[]): Promise<UploadQueueItem> {
  const preview = await createPreview(file);
  return {
    id: crypto.randomUUID(),
    file,
    ...preview,
    accountName,
    category,
    tags,
    createdAt: Date.now(),
    scheduledAt: null,
    status: 'waiting',
  };
}

async function hydrateQueueItem(item: StoredUploadQueueItem): Promise<UploadQueueItem> {
  const preview = await createPreview(item.file);
  const validSchedule = item.status !== 'scheduled'
    || (typeof item.scheduledAt === 'number' && Number.isFinite(item.scheduledAt) && item.scheduledAt > 0);
  return {
    ...item,
    status: validSchedule ? item.status : 'waiting',
    scheduledAt: validSchedule ? item.scheduledAt : null,
    error: validSchedule ? item.error : '计划时间无效，已恢复为等待上传。',
    ...preview,
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
  const initialAccount = localStorage.getItem('quepic-account')?.trim() || DEFAULT_ACCOUNT;
  const [view, setView] = useState<ViewKey>('upload');
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const queueRef = useRef<UploadQueueItem[]>([]);
  const activeAccountRef = useRef(initialAccount);
  const contextRequestRef = useRef(0);
  const autoUploadRunningRef = useRef(false);
  const [queueReady, setQueueReady] = useState(false);
  const [accountName, setAccountName] = useState(initialAccount);
  const [accountDraft, setAccountDraft] = useState(initialAccount);
  const [accountProfiles, setAccountProfiles] = useState<AccountProfile[]>([]);
  const [accountSwitching, setAccountSwitching] = useState(false);
  const [credentialReady, setCredentialReady] = useState(false);
    const [tokenReady, setTokenReady] = useState(false);
    const [uploadContext, setUploadContext] = useState<UploadContextResult | null>(
        () => getStoredUploadContext(initialAccount),
    );
    const [uploadContextInput, setUploadContextInput] = useState(
        () => getStoredUploadContext(initialAccount)?.document_url || '',
    );
    const [uploadContextBusy, setUploadContextBusy] = useState(false);
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
  const [uploadTags, setUploadTags] = useState(() => localStorage.getItem('quepic-upload-tags') || '');
  const [libraryFolders, setLibraryFolders] = useState<string[]>([DEFAULT_CATEGORY]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [newFolderDraft, setNewFolderDraft] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('全部');
  const [tagFilter, setTagFilter] = useState('全部');
  const [search, setSearch] = useState('');
  const [librarySort, setLibrarySort] = useState<LibrarySort>('newest');
  const [selected, setSelected] = useState<AssetRecord | null>(null);
  const [originalViewerAsset, setOriginalViewerAsset] = useState<AssetRecord | null>(null);
  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>(
    () => localStorage.getItem('quepic-library-view') === 'square' ? 'square' : 'original',
  );
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<number>>(new Set());
  const [categoryDraft, setCategoryDraft] = useState(DEFAULT_CATEGORY);
  const [tagDraft, setTagDraft] = useState('');
  const [bulkCategory, setBulkCategory] = useState(DEFAULT_CATEGORY);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewRefreshTimerRef = useRef<number | null>(null);

  const commitQueue = useCallback((updater: (current: UploadQueueItem[]) => UploadQueueItem[]) => {
    setQueue((current) => {
      const next = updater(current);
      queueRef.current = next;
      return next;
    });
  }, []);

  const showToast = useCallback((type: 'success' | 'error', text: string) => {
    setToast({ type, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const refreshProfiles = useCallback(async () => {
    try {
      setAccountProfiles(await listAccountProfiles());
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
      setSelectedAssetIds((current) => new Set([...current].filter((id) => nextAssets.some((asset) => asset.id === id))));
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  }, [showToast]);

  const refreshTaxonomy = useCallback(async () => {
    try {
      const [folders, tags] = await Promise.all([listLibraryFolders(), listAssetTags()]);
      setLibraryFolders(folders.length ? folders : [DEFAULT_CATEGORY]);
      setAvailableTags(tags);
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  }, [showToast]);

  const refreshCacheStats = useCallback(async () => {
    try {
      setCacheStats(await getCacheStats());
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  }, [showToast]);

  const refreshAccountStatus = useCallback(async (targetAccount = activeAccountRef.current) => {
    try {
      const [credential, token, nextQuota] = await Promise.all([
        getCredentialStatus(targetAccount),
        getOpenApiTokenStatus(targetAccount),
        getUploadQuotaStatus(targetAccount),
      ]);
      if (activeAccountRef.current !== targetAccount) return;
      setCredentialReady(credential.configured);
      setTokenReady(token.configured);
      setQuota(nextQuota);
    } catch (error) {
      if (activeAccountRef.current === targetAccount) {
        setCredentialReady(false);
        setTokenReady(false);
        setQuota(null);
      }
      showToast('error', normalizeError(error));
    }
  }, [showToast]);

  const loadAccountContext = useCallback(async (targetAccount: string) => {
    const requestId = ++contextRequestRef.current;
    setQuota(null);
    setCredentialReady(false);
    setTokenReady(false);
    await Promise.all([
      refreshAssets(),
      refreshCacheStats(),
      refreshTaxonomy(),
      refreshAccountStatus(targetAccount),
    ]);
    if (requestId !== contextRequestRef.current) return;
  }, [refreshAccountStatus, refreshAssets, refreshCacheStats, refreshTaxonomy]);

  const handleSwitchAccount = useCallback(async (rawAccount: string) => {
    const nextAccount = rawAccount.trim() || DEFAULT_ACCOUNT;
    if (nextAccount === activeAccountRef.current) {
      const context = getStoredUploadContext(nextAccount);
      setAccountDraft(nextAccount);
      setUploadContext(context);
      setUploadContextInput(context?.document_url || '');
      await loadAccountContext(nextAccount);
      return;
    }
    setAccountSwitching(true);
    try {
      await saveAccountProfile(nextAccount);
      activeAccountRef.current = nextAccount;
      localStorage.setItem('quepic-account', nextAccount);
      setAccountName(nextAccount);
      setAccountDraft(nextAccount);
      const context = getStoredUploadContext(nextAccount);
      setUploadContext(context);
      setUploadContextInput(context?.document_url || '');
      await Promise.all([loadAccountContext(nextAccount), refreshProfiles()]);
      showToast('success', `已切换到账号“${nextAccount}”。上传身份已更新，共享图库保持不变。`);
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setAccountSwitching(false);
    }
  }, [loadAccountContext, refreshProfiles, showToast]);

  const handlePreviewCached = useCallback(() => {
    if (previewRefreshTimerRef.current !== null) window.clearTimeout(previewRefreshTimerRef.current);
    previewRefreshTimerRef.current = window.setTimeout(() => {
      previewRefreshTimerRef.current = null;
      void Promise.all([refreshAssets(), refreshCacheStats()]);
    }, 1_200);
  }, [refreshAssets, refreshCacheStats]);

  useEffect(() => {
    void Promise.all([refreshProfiles(), loadAccountContext(initialAccount)]);
  }, [initialAccount, loadAccountContext, refreshProfiles]);

  useEffect(() => {
    let disposed = false;
    void listStoredQueueItems()
      .then((stored) => mapWithConcurrency(stored, QUEUE_PREVIEW_CONCURRENCY, hydrateQueueItem))
      .then((restored) => {
        if (disposed) {
          restored.forEach((item) => URL.revokeObjectURL(item.previewUrl));
          return;
        }
        commitQueue((current) => {
          const currentIds = new Set(current.map((item) => item.id));
          return [...restored.filter((item) => !currentIds.has(item.id)), ...current];
        });
        setQueueReady(true);
      })
      .catch((error) => {
        if (!disposed) {
          setQueueReady(true);
          showToast('error', `恢复上传队列失败：${normalizeError(error)}`);
        }
      });
    return () => {
      disposed = true;
    };
  }, [commitQueue, showToast]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    if (!selected) return undefined;
    setCategoryDraft(selected.category || DEFAULT_CATEGORY);
    setTagDraft((selected.tags || []).join(', '));
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
    const values = new Set<string>([DEFAULT_CATEGORY, ...libraryFolders, ...assets.map((asset) => asset.category || DEFAULT_CATEGORY)]);
    return Array.from(values).sort((left, right) => left === DEFAULT_CATEGORY ? -1 : right === DEFAULT_CATEGORY ? 1 : left.localeCompare(right, 'zh-CN'));
  }, [assets, libraryFolders]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const asset of assets) counts.set(asset.category || DEFAULT_CATEGORY, (counts.get(asset.category || DEFAULT_CATEGORY) || 0) + 1);
    return counts;
  }, [assets]);

  const filteredAssets = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const filtered = assets.filter((asset) => {
      const categoryMatches = categoryFilter === '全部' || asset.category === categoryFilter;
      const tagMatches = tagFilter === '全部' || (asset.tags || []).includes(tagFilter);
      if (!categoryMatches || !tagMatches) return false;
      if (!keyword) return true;
      return [asset.file_name, asset.remote_url, asset.mime_type, asset.account_name, asset.category, ...(asset.tags || [])]
        .some((value) => value.toLowerCase().includes(keyword));
    });
    return [...filtered].sort((left, right) => {
      if (librarySort === 'oldest') return Date.parse(left.uploaded_at) - Date.parse(right.uploaded_at);
      if (librarySort === 'name') return left.file_name.localeCompare(right.file_name, 'zh-CN', { numeric: true });
      if (librarySort === 'size') return right.file_size - left.file_size;
      if (librarySort === 'category') return left.category.localeCompare(right.category, 'zh-CN') || left.file_name.localeCompare(right.file_name, 'zh-CN', { numeric: true });
      return Date.parse(right.uploaded_at) - Date.parse(left.uploaded_at);
    });
  }, [assets, categoryFilter, librarySort, search, tagFilter]);

  const activeQueue = useMemo(
    () => queue.filter((item) => item.accountName === accountName),
    [accountName, queue],
  );
  const pendingUploadCount = activeQueue.filter((item) => ['waiting', 'failed', 'scheduled'].includes(item.status)).length;
  const scheduledUploadCount = activeQueue.filter((item) => item.status === 'scheduled').length;
  const nextScheduledAt = activeQueue
    .filter((item) => item.status === 'scheduled' && item.scheduledAt)
    .reduce<number | null>((earliest, item) => earliest === null ? item.scheduledAt : Math.min(earliest, item.scheduledAt || earliest), null);
  const maxUploadBytes = tokenReady ? TOKEN_MAX_UPLOAD_BYTES : NO_TOKEN_MAX_UPLOAD_BYTES;
  const maxUploadMegabytes = maxUploadBytes / 1024 / 1024;
  const cachePercent = cacheStats.asset_count > 0
    ? Math.round((cacheStats.cached_count / cacheStats.asset_count) * 100)
    : 0;

  const persistAccount = async () => {
    const value = accountName.trim() || DEFAULT_ACCOUNT;
    await saveAccountProfile(value);
    localStorage.setItem('quepic-account', value);
    await refreshProfiles();
    return value;
  };

  const handleOpenYuqueLogin = async () => {
    if (!accountName.trim()) return showToast('error', '请先填写账号名称。');
    setLoginBusy(true);
    try {
      await persistAccount();
      await openYuqueLogin();
      showToast('success', '已打开语雀登录窗口。完成登录后返回这里保存会话。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const handleCaptureYuqueLogin = async () => {
    setLoginBusy(true);
    try {
      const account = await persistAccount();
      await captureYuqueLogin(account);
      await Promise.all([refreshAccountStatus(account), refreshProfiles()]);
      showToast('success', '语雀登录会话已安全保存。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const handleManualCookieSave = async () => {
    if (!cookieInput.trim()) return;
    setLoginBusy(true);
    try {
      const account = await persistAccount();
      await saveCookie(account, cookieInput.trim());
      setCookieInput('');
      await Promise.all([refreshAccountStatus(account), refreshProfiles()]);
      showToast('success', 'Cookie 已分片保存到系统密钥库。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const handleClearCredential = async () => {
    try {
      await clearCookie(accountName);
      await Promise.all([refreshAccountStatus(accountName), refreshProfiles()]);
      showToast('success', '已清除当前账号的语雀登录凭据。');
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  };

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return;
    setTokenBusy(true);
    try {
      const account = await persistAccount();
      await saveOpenApiToken(account, tokenInput.trim());
      setTokenInput('');
      await Promise.all([refreshAccountStatus(account), refreshProfiles()]);
      showToast('success', 'OpenAPI Token 已保存到系统密钥库。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setTokenBusy(false);
    }
  };

  const handleSaveUploadContext = async () => {
    if (!uploadContextInput.trim()) return;
    if (!credentialReady) return showToast('error', '请先为当前账号登录语雀并保存会话。');
    setUploadContextBusy(true);
    try {
        const context = await resolveUploadContext(accountName, uploadContextInput.trim());
        saveStoredUploadContext(context);
        setUploadContext(context);
        setUploadContextInput(context.document_url);
        showToast('success', `上传上下文已绑定到文档“${context.title}”（${context.source === 'openapi' ? 'OpenAPI' : '登录会话'}验证）。`);
    } catch (error) {
        showToast('error', normalizeError(error));
    } finally {
        setUploadContextBusy(false);
    }
};

    const handleClearUploadContext = () => {
    clearStoredUploadContext(accountName);
    setUploadContext(null);
    setUploadContextInput('');
    showToast('success', '已清除当前账号的上传上下文。');
};

    const handleClearToken = async () => {
    setTokenBusy(true);
    try {
      await clearOpenApiToken(accountName);
      setTokenInput('');
      await Promise.all([refreshAccountStatus(accountName), refreshProfiles()]);
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
      showToast('success', '共享图库的本地缓存已清理。进入视口的图片会按需重建缩略图。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setCacheBusy(false);
    }
  };

  const addFiles = async (files: File[]) => {
    const accepted = files.filter((file) => isImageFile(file) && file.size > 0 && file.size <= maxUploadBytes);
    if (accepted.length !== files.length) {
      showToast('error', `已忽略非图片、空文件或超过 ${maxUploadMegabytes} MB 的图片。${tokenReady ? '' : ' 保存 OpenAPI Token 后可上传 50 MB 图片。'}`);
    }
    if (accepted.length === 0) return;
    const account = activeAccountRef.current;
    const category = uploadCategory.trim() || DEFAULT_CATEGORY;
    const tags = parseTags(uploadTags);
    localStorage.setItem('quepic-upload-category', category);
    localStorage.setItem('quepic-upload-tags', uploadTags);
    const items = await mapWithConcurrency(
      accepted,
      QUEUE_PREVIEW_CONCURRENCY,
      (file) => createQueueItem(file, account, category, tags),
    );
    commitQueue((current) => [...items, ...current]);
    try {
      await saveStoredQueueItems(items.map(toStoredQueueItem));
    } catch (error) {
      showToast('error', `队列已加入，但持久化失败：${normalizeError(error)}`);
    }
  };

  const markQueueItem = useCallback((id: string, changes: Partial<UploadQueueItem>) => {
    let updated: UploadQueueItem | undefined;
    commitQueue((current) => current.map((item) => {
      if (item.id !== id) return item;
      updated = { ...item, ...changes };
      return updated;
    }));
    return updated;
  }, [commitQueue]);

  const prepareUploadContextForAccount = useCallback(async (targetAccount: string) => {
    const token = await getOpenApiTokenStatus(targetAccount);
    if (token.configured) {
      const document = await ensureDailyImageDocument(targetAccount);
      const context = getStoredUploadContext(targetAccount);
      if (!document || !context) return false;
      if (activeAccountRef.current === targetAccount) {
        setUploadContext(context);
        setUploadContextInput(context.document_url);
      }
      return true;
    }
    return Boolean(getStoredUploadContext(targetAccount));
  }, []);

  const uploadOne = useCallback(async (id: string, deferRefresh = false) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item || item.status === 'uploading' || item.status === 'success') return null;
    const credential = await getCredentialStatus(item.accountName);
    if (!credential.configured) {
      const failed = markQueueItem(id, {
        status: 'failed',
        scheduledAt: null,
        error: `账号“${item.accountName}”尚未保存有效语雀会话。`,
      });
      if (failed) await saveStoredQueueItem(toStoredQueueItem(failed));
      return null;
    }

    markQueueItem(id, { status: 'uploading', scheduledAt: null, error: undefined });
    try {
      const result = await uploadImage(item.file, item.accountName, item.width, item.height, item.category, item.tags || []);
      markQueueItem(id, { status: 'success', result, scheduledAt: null, error: undefined });
      await removeStoredQueueItem(id);
      if (!deferRefresh) {
        await Promise.all([refreshAssets(), refreshCacheStats(), refreshProfiles()]);
        if (activeAccountRef.current === item.accountName) {
          await refreshAccountStatus(item.accountName);
        }
      }
      return result;
    } catch (error) {
      const failed = markQueueItem(id, {
        status: 'failed',
        scheduledAt: null,
        error: normalizeError(error),
      });
      if (failed) await saveStoredQueueItem(toStoredQueueItem(failed));
      if (!deferRefresh && activeAccountRef.current === item.accountName) {
        await refreshAccountStatus(item.accountName);
      }
      return null;
    }
  }, [markQueueItem, refreshAccountStatus, refreshAssets, refreshCacheStats, refreshProfiles]);

  const persistDailyDocumentSyncFailure = useCallback(async (
    items: UploadQueueItem[],
    error: unknown,
  ) => {
    const reason = normalizeError(error);
    const ids = new Set(items.map((item) => item.id));
    const updated: UploadQueueItem[] = [];
    commitQueue((current) => current.map((item) => {
      if (!ids.has(item.id)) return item;
      const next: UploadQueueItem = {
        ...item,
        status: 'failed',
        scheduledAt: null,
        error: `图片已上传，但当天文档同步失败：${reason}。重试会复用现有链接。`,
      };
      updated.push(next);
      return next;
    }));
    try {
      await saveStoredQueueItems(updated.map(toStoredQueueItem));
      return reason;
    } catch (persistError) {
      return `${reason}；恢复持久队列失败：${normalizeError(persistError)}`;
    }
  }, [commitQueue]);

  const retryUploadOne = useCallback(async (id: string) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    try {
      if (!(await prepareUploadContextForAccount(item.accountName))) {
        showToast('error', `账号“${item.accountName}”没有 Token，也未配置手动上传上下文。`);
        return;
      }
    } catch (error) {
      showToast('error', `准备当天文档失败：${normalizeError(error)}`);
      return;
    }
    const result = await uploadOne(id);
    if (!item || !result) return;
    try {
      const dailyDocument = await appendImagesToDailyDocument(item.accountName, [{
        asset_id: result.asset.id,
        file_name: item.file.name,
        remote_url: result.asset.remote_url,
      }]);
      if (dailyDocument) showToast('success', `图片已写入当天文档“${dailyDocument.title}”。`);
    } catch (error) {
      const reason = await persistDailyDocumentSyncFailure([item], error);
      showToast('error', `图片上传成功，但当天文档同步失败：${reason}`);
    }
  }, [persistDailyDocumentSyncFailure, prepareUploadContextForAccount, showToast, uploadOne]);

  const uploadAll = async () => {
    if (!credentialReady) {
      setView('settings');
      return showToast('error', '请先为当前账号登录语雀并保存会话。');
    }
    try {
      if (!(await prepareUploadContextForAccount(accountName))) {
        setView('settings');
        return showToast('error', '当前账号没有 Token，请先手动配置一个有权限的语雀文档作为上传上下文。');
      }
    } catch (error) {
      return showToast('error', `自动创建当天文档失败：${normalizeError(error)}`);
    }

    const pendingItems = queueRef.current.filter(
      (item) => item.accountName === accountName && ['waiting', 'failed', 'scheduled'].includes(item.status),
    );
    if (pendingItems.length === 0) return showToast('error', '当前账号没有等待上传的图片。');

    const scheduleBatch = async (items: UploadQueueItem[], scheduledAt: number, reason: string) => {
      const ids = new Set(items.map((item) => item.id));
      const updated: UploadQueueItem[] = [];
      commitQueue((current) => current.map((item) => {
        if (!ids.has(item.id)) return item;
        const next: UploadQueueItem = { ...item, status: 'scheduled', scheduledAt, error: reason };
        updated.push(next);
        return next;
      }));
      await saveStoredQueueItems(updated.map(toStoredQueueItem));
    };

    try {
      const currentQuota = await getUploadQuotaStatus(accountName);
      setQuota(currentQuota);
      if (currentQuota.remaining <= 0) {
        const scheduledAt = resolveRetryTimestamp(currentQuota.reset_at);
        await scheduleBatch(pendingItems, scheduledAt, '当前小时额度已满，等待下一批');
        showToast('success', `当前小时额度已用完，${pendingItems.length} 张图片已安排在 ${formatScheduleTime(scheduledAt)} 自动继续。`);
        return;
      }

      const immediateItems = pendingItems.slice(0, currentQuota.remaining);
      const overflowItems = pendingItems.slice(currentQuota.remaining);
      const dailyImages: DailyDocumentImage[] = [];
      const dailyItems: UploadQueueItem[] = [];
      let successCount = 0;
      for (const item of immediateItems) {
        const result = await uploadOne(item.id, true);
        if (result) {
          successCount += 1;
          dailyImages.push({ asset_id: result.asset.id, file_name: item.file.name, remote_url: result.asset.remote_url });
          dailyItems.push(item);
        }
      }

      let scheduledCount = 0;
      let scheduledAt: number | null = null;
      if (overflowItems.length > 0) {
        const refreshedQuota = await getUploadQuotaStatus(accountName);
        scheduledAt = resolveRetryTimestamp(refreshedQuota.reset_at || currentQuota.reset_at);
        await scheduleBatch(overflowItems, scheduledAt, '本批额度已用完，等待下一小时自动上传');
        scheduledCount = overflowItems.length;
      }

      await Promise.all([refreshAssets(), refreshCacheStats(), refreshProfiles(), refreshAccountStatus(accountName)]);
      let dailyDocumentTitle = '';
      let dailyDocumentError = '';
      if (dailyImages.length > 0) {
        try {
          dailyDocumentTitle = (await appendImagesToDailyDocument(accountName, dailyImages))?.title || '';
        } catch (error) {
          dailyDocumentError = await persistDailyDocumentSyncFailure(dailyItems, error);
        }
      }
      const summary = [`已立即上传 ${successCount} 张`];
      if (scheduledCount > 0 && scheduledAt) {
        summary.push(`${scheduledCount} 张将在 ${formatScheduleTime(scheduledAt)} 自动继续`);
      }
      if (dailyDocumentTitle) summary.push(`已写入当天文档“${dailyDocumentTitle}”`);
      if (dailyDocumentError) {
        showToast('error', `${summary.join('，')}；当天文档同步失败：${dailyDocumentError}`);
      } else {
        showToast('success', summary.join('，'));
      }
    } catch (error) {
      showToast('error', `批量上传失败：${normalizeError(error)}`);
    }
  };

  const scheduleRemaining = async () => {
    const scheduledAt = Date.now() + AUTO_UPLOAD_DELAY_MS;
    const updated: UploadQueueItem[] = [];
    commitQueue((current) => current.map((item) => {
      if (item.accountName !== accountName || !['waiting', 'failed', 'scheduled'].includes(item.status)) return item;
      const next: UploadQueueItem = { ...item, status: 'scheduled', scheduledAt, error: undefined };
      updated.push(next);
      return next;
    }));
    if (updated.length === 0) return showToast('error', '当前账号没有可计划的剩余图片。');
    try {
      await saveStoredQueueItems(updated.map(toStoredQueueItem));
      showToast('success', `已将 ${updated.length} 张图片整体延后，将在 ${formatScheduleTime(scheduledAt)} 自动上传。`);
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  };

  const rescheduleItems = useCallback(async (items: UploadQueueItem[], scheduledAt: number, reason?: string) => {
    const ids = new Set(items.map((item) => item.id));
    const updated: UploadQueueItem[] = [];
    commitQueue((current) => current.map((item) => {
      if (!ids.has(item.id)) return item;
      const next: UploadQueueItem = { ...item, status: 'scheduled', scheduledAt, error: reason };
      updated.push(next);
      return next;
    }));
    await saveStoredQueueItems(updated.map(toStoredQueueItem));
  }, [commitQueue]);

  const runDueUploads = useCallback(async () => {
    if (autoUploadRunningRef.current) return;
    const due = queueRef.current.filter((item) => item.status === 'scheduled' && (item.scheduledAt || 0) <= Date.now());
    if (due.length === 0) return;
    autoUploadRunningRef.current = true;
    try {
      const accounts = Array.from(new Set<string>(due.map((item) => item.accountName)));
      for (const account of accounts) {
        const accountItems = due.filter((item) => item.accountName === account);
        const credential = await getCredentialStatus(account);
        if (!credential.configured) {
          for (const item of accountItems) {
            const failed = markQueueItem(item.id, {
              status: 'failed',
              scheduledAt: null,
              error: `账号“${account}”未登录，自动上传已暂停。`,
            });
            if (failed) await saveStoredQueueItem(toStoredQueueItem(failed));
          }
          continue;
        }
        try {
          if (!(await prepareUploadContextForAccount(account))) {
            for (const item of accountItems) {
              const failed = markQueueItem(item.id, {
                status: 'failed',
                scheduledAt: null,
                error: `账号“${account}”没有 Token，也未配置手动上传上下文。`,
              });
              if (failed) await saveStoredQueueItem(toStoredQueueItem(failed));
            }
            continue;
          }
        } catch (error) {
          await rescheduleItems(accountItems, Date.now() + 5 * 60 * 1000, `准备当天文档失败：${normalizeError(error)}`);
          continue;
        }
        const accountQuota = await getUploadQuotaStatus(account);
        if (accountQuota.remaining <= 0) {
          const resetAt = resolveRetryTimestamp(accountQuota.reset_at);
          await rescheduleItems(accountItems, resetAt, '等待下一小时上传额度');
          continue;
        }
        const dailyImages: DailyDocumentImage[] = [];
        const dailyItems: UploadQueueItem[] = [];
        for (const item of accountItems.slice(0, accountQuota.remaining)) {
          const result = await uploadOne(item.id, true);
          if (result) {
            dailyImages.push({ asset_id: result.asset.id, file_name: item.file.name, remote_url: result.asset.remote_url });
            dailyItems.push(item);
          }
        }
        if (dailyImages.length > 0) {
          try {
            await appendImagesToDailyDocument(account, dailyImages);
          } catch (error) {
            const reason = await persistDailyDocumentSyncFailure(dailyItems, error);
            showToast('error', `账号“${account}”图片已上传，但当天文档同步失败：${reason}`);
          }
        }
        const overflow = accountItems.slice(accountQuota.remaining);
        if (overflow.length > 0) {
          const resetAt = resolveRetryTimestamp(accountQuota.reset_at);
          await rescheduleItems(overflow, resetAt, '等待下一小时上传额度');
        }
      }
      await Promise.all([refreshAssets(), refreshCacheStats(), refreshProfiles()]);
      if (activeAccountRef.current) await refreshAccountStatus(activeAccountRef.current);
    } catch (error) {
      const retryAt = Date.now() + 5 * 60 * 1000;
      try {
        await rescheduleItems(due, retryAt, '自动检查失败，五分钟后重试');
      } catch {
        // 保留原错误；持久队列写入失败会在下一次状态变化时再次暴露。
      }
      showToast('error', `自动上传失败：${normalizeError(error)}`);
    } finally {
      autoUploadRunningRef.current = false;
    }
  }, [markQueueItem, persistDailyDocumentSyncFailure, prepareUploadContextForAccount, refreshAccountStatus, refreshAssets, refreshCacheStats, refreshProfiles, rescheduleItems, showToast, uploadOne]);

  useEffect(() => {
    if (!queueReady) return undefined;
    void runDueUploads();
    const timer = window.setInterval(() => void runDueUploads(), 60_000);
    return () => window.clearInterval(timer);
  }, [queueReady, runDueUploads]);

  const copyText = useCallback(async (value: string) => {
    await navigator.clipboard.writeText(value);
    showToast('success', '已复制到剪贴板');
  }, [showToast]);

  const removeQueueItem = useCallback((id: string) => {
    const target = queueRef.current.find((item) => item.id === id);
    if (target?.status === 'uploading') return;
    if (target) URL.revokeObjectURL(target.previewUrl);
    commitQueue((current) => current.filter((item) => item.id !== id));
    void removeStoredQueueItem(id).catch((error) => showToast('error', normalizeError(error)));
  }, [commitQueue, showToast]);

  const clearCompletedQueue = () => {
    const completed = queueRef.current.filter((item) => item.accountName === accountName && item.status === 'success');
    completed.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    const ids = new Set(completed.map((item) => item.id));
    commitQueue((current) => current.filter((item) => !ids.has(item.id)));
  };

  const handleDeleteAsset = async (asset: AssetRecord) => {
    try {
      await deleteAsset(asset.id);
      setSelected(null);
      setSelectedAssetIds((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
      await Promise.all([refreshAssets(), refreshCacheStats(), refreshProfiles()]);
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

  const toggleAssetSelection = (id: number) => {
    setSelectedAssetIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelectedAssetIds(new Set(filteredAssets.map((asset) => asset.id)));
  };

  const handleBulkCategory = async () => {
    const ids = [...selectedAssetIds];
    if (ids.length === 0) return;
    const category = bulkCategory.trim() || DEFAULT_CATEGORY;
    setLibraryBusy(true);
    try {
      for (const id of ids) await updateAssetCategory(id, category);
      await refreshAssets();
      showToast('success', `已将 ${ids.length} 张图片归类到“${category}”。`);
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLibraryBusy(false);
    }
  };

  const handleCreateFolder = async () => {
    const name = newFolderDraft.trim();
    if (!name) return;
    setLibraryBusy(true);
    try {
      const created = await createLibraryFolder(name);
      setNewFolderDraft('');
      setUploadCategory(created);
      await refreshTaxonomy();
      showToast('success', `已创建文件夹“${created}”。`);
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLibraryBusy(false);
    }
  };

  const handleSaveTags = async () => {
    if (!selected) return;
    setLibraryBusy(true);
    try {
      const updated = await updateAssetTags(selected.id, parseTags(tagDraft));
      setSelected(updated);
      await Promise.all([refreshAssets(), refreshTaxonomy()]);
      showToast('success', '图片标签已保存。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLibraryBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedAssetIds];
    if (ids.length === 0) return;
    if (!window.confirm(`确认删除选中的 ${ids.length} 条本地图片记录和缓存吗？语雀远程图片不会删除。`)) return;
    setLibraryBusy(true);
    try {
      for (const id of ids) await deleteAsset(id);
      setSelected(null);
      setSelectedAssetIds(new Set());
      await Promise.all([refreshAssets(), refreshCacheStats(), refreshProfiles()]);
      showToast('success', `已删除 ${ids.length} 条本地图片记录。`);
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLibraryBusy(false);
    }
  };

  const navItems: Array<{ key: ViewKey; label: string; icon: typeof CloudUpload }> = [
    { key: 'upload', label: '上传', icon: CloudUpload },
    { key: 'document', label: '文件夹转文档', icon: FolderUp },
    { key: 'library', label: '图片库', icon: Images },
    { key: 'settings', label: '设置', icon: Settings },
  ];

  const pageInfo: Record<ViewKey, { title: string; description: string }> = {
    upload: { title: '上传图片', description: '选择上传账号，所有上传结果统一进入共享图库。' },
    document: { title: '文件夹转文档', description: '按文件名顺序上传整个文件夹并创建或更新语雀文档。' },
    library: { title: '共享图片库', description: '集中管理所有账号上传的图片、分类和本地缓存。' },
    settings: { title: '设置', description: '账号仅管理上传身份、语雀会话、Token 与独立额度。' },
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
          <div><strong>{credentialReady ? '语雀账号可用' : '尚未登录语雀'}</strong><small>{scheduledUploadCount ? `${scheduledUploadCount} 项等待自动上传` : uploadContext ? `上传文档：${uploadContext.title}` : tokenReady ? '请配置上传上下文文档' : '前往设置完善配置'}</small></div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="page-title"><span>QUEPIC WORKSPACE</span><h1>{pageInfo[view].title}</h1><p>{pageInfo[view].description}</p></div>
          <label className="account-switcher">
            <UserRound size={16} />
            <select
              value={accountName}
              disabled={accountSwitching}
              onChange={(event) => void handleSwitchAccount(event.target.value)}
            >
              {!accountProfiles.some((profile) => profile.account_name === accountName) && <option value={accountName}>{accountName}</option>}
              {accountProfiles.map((profile) => <option key={profile.account_name} value={profile.account_name}>{profile.account_name}</option>)}
            </select>
            {accountSwitching ? <LoaderCircle className="spin" size={15} /> : <span className={credentialReady ? 'dot ready' : 'dot'} />}
          </label>
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
                <span className="drop-eyebrow">PERSISTENT UPLOAD QUEUE</span>
                <span className="drop-icon"><UploadCloud size={34} /></span>
                <h2>将图片拖到这里</h2>
                <p>图片加入队列时绑定上传账号和分类；上传完成后统一进入共享图库，切换账号不会隐藏已有图片。</p>
                <div className="upload-organization-fields">
                  <label className="upload-category-field">
                    <FolderUp size={16} />
                    <select value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value)}>
                      {categories.map((category) => <option value={category} key={category}>{category}</option>)}
                    </select>
                  </label>
                  <label className="upload-category-field">
                    <Tags size={16} />
                    <input value={uploadTags} onChange={(event) => setUploadTags(event.target.value)} placeholder="标签，用逗号分隔" list="tag-options" />
                  </label>
                </div>
                <datalist id="category-options">{categories.map((category) => <option value={category} key={category} />)}</datalist>
                <datalist id="tag-options">{availableTags.map((tag) => <option value={tag} key={tag} />)}</datalist>
                <div className="drop-hints"><span>单张 {maxUploadMegabytes} MB</span><span>{tokenReady ? 'Token 增强模式' : '无 Token 基础模式'}</span><span>140 张/小时</span><span>额度内连续上传</span><span>队列持久化</span></div>
                <div className="actions">
                  <button className="button primary" disabled={!queueReady} onClick={() => fileInputRef.current?.click()}><FileImage size={17} />选择图片</button>
                  <button className="button secondary" disabled={!queueReady} onClick={async () => {
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
                <div className="panel-heading queue-heading">
                  <div><span>UPLOAD QUEUE · {accountName}</span><h2>上传图片队列</h2><p>{pendingUploadCount ? `${pendingUploadCount} 项等待处理` : '没有待处理任务'}</p></div>
                  <div className="queue-heading-actions">
                    <button className="button secondary compact" disabled={pendingUploadCount === 0} onClick={() => void scheduleRemaining()}><CalendarClock size={16} />全部延后 1 小时</button>
                    <button className="button primary compact" disabled={!credentialReady || (!uploadContext && !tokenReady) || pendingUploadCount === 0} onClick={() => void uploadAll()}><UploadCloud size={16} />立即上传本批</button>
                  </div>
                </div>
                <div className="quota-strip">
                  <Gauge size={16} />
                  <span>{quota ? `过去一小时已使用 ${quota.used}/${quota.limit}，剩余 ${quota.remaining}` : '正在读取上传额度'}</span>
                  {quota?.retry_after_seconds ? <b>{formatDuration(quota.retry_after_seconds)} 后进入下一批</b> : <b>额度内连续上传</b>}
                </div>
                {nextScheduledAt && (
                  <div className="queue-schedule-banner"><CalendarClock size={16} /><span>下一批自动上传：{formatScheduleTime(nextScheduledAt)}</span><small>本小时额度内会连续处理；超出部分保留到下一额度窗口。应用关闭后会在下次启动补传。</small></div>
                )}
                {!credentialReady && <div className="warning">当前账号尚未保存语雀会话；队列可继续添加，但到点后会暂停并提示登录。</div>}
                {credentialReady && !uploadContext && !tokenReady && <div className="warning">当前账号没有 Token，请在设置中手动验证一个有权限访问的语雀文档 URL。</div>}
                {credentialReady && !uploadContext && tokenReady && <div className="queue-auto-context-note">首次上传时会自动创建今天日期的 Markdown 文档，并将其绑定为上传上下文。</div>}
                {activeQueue.length === 0 ? <div className="empty"><FileImage size={26} /><p>当前账号的待上传图片会显示在这里。</p></div> : (
                  <div className="queue-list">
                    {activeQueue.map((item) => (
                      <QueueItemRow key={item.id} item={item} onRetry={retryUploadOne} onCopy={copyText} onRemove={removeQueueItem} />
                    ))}
                  </div>
                )}
                {activeQueue.some((item) => item.status === 'success') && (
                  <button className="queue-clear-completed" onClick={clearCompletedQueue}><ListChecks size={15} />清除已完成项目</button>
                )}
              </div>
            </div>
          )}

          {view === 'document' && (
            <BatchDocumentUploader accountName={accountName} onUploaded={() => void Promise.all([refreshAssets(), refreshCacheStats(), refreshAccountStatus(), refreshProfiles()])} />
          )}

          {view === 'library' && (
            <div className="library-layout">
              <aside className="library-taxonomy">
                <div className="taxonomy-section">
                  <div className="taxonomy-title"><FolderUp size={15} /><strong>文件夹</strong></div>
                  <button className={categoryFilter === '全部' ? 'active' : ''} onClick={() => setCategoryFilter('全部')}><span>全部图片</span><em>{assets.length}</em></button>
                  {categories.map((category) => <button key={category} className={categoryFilter === category ? 'active' : ''} onClick={() => setCategoryFilter(category)}><span>{category}</span><em>{categoryCounts.get(category) || 0}</em></button>)}
                  <div className="taxonomy-create"><input value={newFolderDraft} onChange={(event) => setNewFolderDraft(event.target.value)} placeholder="新建文件夹" /><button disabled={libraryBusy || !newFolderDraft.trim()} onClick={() => void handleCreateFolder()}><Plus size={14} /></button></div>
                </div>
                <div className="taxonomy-section">
                  <div className="taxonomy-title"><Tags size={15} /><strong>标签</strong></div>
                  <button className={tagFilter === '全部' ? 'active' : ''} onClick={() => setTagFilter('全部')}><span>全部标签</span></button>
                  {availableTags.map((tag) => <button key={tag} className={tagFilter === tag ? 'active' : ''} onClick={() => setTagFilter(tag)}><span>#{tag}</span></button>)}
                </div>
              </aside>
              <div className={libraryViewMode === 'original' ? 'library-main original-ratio-view' : 'library-main square-view'}>
                <div className="library-heading">
                  <div><span>SHARED LOCAL FIRST ASSET INDEX</span><h2>共享图片内容管理</h2><p>所有账号使用同一个图库；账号切换只改变上传身份，不改变这里的内容。</p></div>
                  <div className="library-heading-controls">
                    <div className="library-view-switch" role="group" aria-label="图库显示方式">
                      <button className={libraryViewMode === 'original' ? 'active' : ''} onClick={() => { setLibraryViewMode('original'); localStorage.setItem('quepic-library-view', 'original'); }}><Images size={15} />原始比例</button>
                      <button className={libraryViewMode === 'square' ? 'active' : ''} onClick={() => { setLibraryViewMode('square'); localStorage.setItem('quepic-library-view', 'square'); }}><Square size={15} />统一方格</button>
                    </div>
                    <label className="search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名、分类、链接或类型" /></label>
                    <label className="library-sort"><ArrowUpDown size={16} /><select value={librarySort} onChange={(event) => setLibrarySort(event.target.value as LibrarySort)}><option value="newest">最新上传</option><option value="oldest">最早上传</option><option value="name">文件名</option><option value="size">文件大小</option><option value="category">分类</option></select></label>
                  </div>
                </div>
                <div className="category-filter legacy-category-filter">
                  <button className={categoryFilter === '全部' ? 'active' : ''} onClick={() => setCategoryFilter('全部')}>全部 {assets.length}</button>
                  {categories.map((category) => (
                    <button key={category} className={categoryFilter === category ? 'active' : ''} onClick={() => setCategoryFilter(category)}>{category} {categoryCounts.get(category) || 0}</button>
                  ))}
                </div>
                <div className="library-overview">
                  <div><Images size={18} /><span><strong>{assets.length}</strong><small>图片记录</small></span></div>
                  <div><Tags size={18} /><span><strong>{categories.length}</strong><small>图片分类</small></span></div>
                  <div><HardDrive size={18} /><span><strong>{cacheStats.cached_count}</strong><small>本地缓存</small></span></div>
                  <div><Database size={18} /><span><strong>{formatBytes(cacheStats.cache_bytes)}</strong><small>缓存占用</small></span></div>
                </div>
                <div className="library-bulk-toolbar">
                  <button className="select-toggle" disabled={filteredAssets.length === 0} onClick={selectedAssetIds.size === filteredAssets.length && filteredAssets.length > 0 ? () => setSelectedAssetIds(new Set()) : selectAllFiltered}>
                    {selectedAssetIds.size === filteredAssets.length && filteredAssets.length > 0 ? <CheckSquare size={16} /> : <Square size={16} />}
                    {selectedAssetIds.size ? `已选 ${selectedAssetIds.size} 张` : '选择当前结果'}
                  </button>
                  <div className="bulk-category-editor">
                    <Tags size={15} /><input value={bulkCategory} onChange={(event) => setBulkCategory(event.target.value)} list="category-options" placeholder="批量分类" />
                    <button disabled={libraryBusy || selectedAssetIds.size === 0} onClick={() => void handleBulkCategory()}>应用分类</button>
                  </div>
                  <button className="bulk-delete" disabled={libraryBusy || selectedAssetIds.size === 0} onClick={() => void handleBulkDelete()}>{libraryBusy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}删除本地记录</button>
                </div>
                {filteredAssets.length === 0 ? <div className="empty large"><Images size={30} /><h3>{assets.length ? '没有匹配图片' : '还没有上传记录'}</h3></div> : (
                  <div className={`asset-grid ${libraryViewMode}`}>
                    {filteredAssets.map((asset) => {
                      const checked = selectedAssetIds.has(asset.id);
                      return (
                        <article
                          className={checked ? 'asset-card selected' : 'asset-card'}
                          key={asset.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`查看 ${asset.file_name}`}
                          onClick={() => setSelected(asset)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') setSelected(asset);
                          }}
                        >
                          <button className="asset-select" aria-label={checked ? '取消选择' : '选择图片'} onClick={(event) => { event.stopPropagation(); toggleAssetSelection(asset.id); }}>{checked ? <CheckSquare size={18} /> : <Square size={18} />}</button>
                          <button className="asset-original-action" title="原图显示" aria-label={`查看 ${asset.file_name} 原图`} onClick={(event) => { event.stopPropagation(); setOriginalViewerAsset(asset); }}><Maximize2 size={16} /></button>
                          <AssetPreview asset={asset} preserveAspectRatio={libraryViewMode === 'original'} allowWordpressFallback={allowWordpressFallback} cacheEpoch={cacheEpoch} onCacheChanged={handlePreviewCached} />
                          <div className="asset-card-body">
                            <strong>{asset.file_name}</strong>
                            <span className="asset-category-tag">{asset.category || DEFAULT_CATEGORY}</span>
                            {(asset.tags || []).length > 0 && <span className="asset-tag-summary">#{asset.tags.slice(0, 2).join(' #')}</span>}
                            <span className={asset.cache_status === 'ready' ? 'asset-cache-state ready' : 'asset-cache-state'}>{asset.cache_status === 'ready' ? '已缓存' : '按需缓存'}</span>
                            <small>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.mime_type} · {formatBytes(asset.file_size)} · 来源：{asset.account_name}</small>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
              {selected && (
                <>
                  <button className="detail-backdrop" aria-label="关闭图片详情" onClick={() => setSelected(null)} />
                  <aside className="detail" aria-label="图片详情">
                    <button className="detail-close" aria-label="关闭图片详情" onClick={() => setSelected(null)}><X size={17} /></button>
                    <AssetPreview asset={selected} allowWordpressFallback={allowWordpressFallback} cacheEpoch={cacheEpoch} className="detail-preview" onCacheChanged={handlePreviewCached} />
                    <div className="detail-body">
                      <span>IMAGE DETAILS</span><h3>{selected.file_name}</h3>
                      <dl>
                        <div><dt>文件夹</dt><dd>{selected.category}</dd></div>
                        <div><dt>标签</dt><dd>{selected.tags?.length ? selected.tags.map((tag) => `#${tag}`).join(' ') : '无'}</dd></div>
                        <div><dt>来源账号</dt><dd>{selected.account_name}</dd></div>
                        <div><dt>尺寸</dt><dd>{selected.width && selected.height ? `${selected.width} × ${selected.height}` : '未知'}</dd></div>
                        <div><dt>格式</dt><dd>{selected.mime_type}</dd></div>
                        <div><dt>大小</dt><dd>{formatBytes(selected.file_size)}</dd></div>
                        <div><dt>缓存</dt><dd>{selected.cache_status === 'ready' ? formatBytes(selected.cache_bytes || 0) : '按需建立'}</dd></div>
                        <div><dt>上传时间</dt><dd>{new Date(selected.uploaded_at).toLocaleString()}</dd></div>
                      </dl>
                      <label className="field detail-category-field"><span>所属文件夹</span><select value={categoryDraft} onChange={(event) => setCategoryDraft(event.target.value)}>{categories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
                      <button className="button primary" disabled={libraryBusy} onClick={() => void handleSaveCategory()}><Save size={16} />保存文件夹</button>
                      <label className="field detail-category-field"><span>图片标签</span><input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="标签，用逗号分隔" list="tag-options" /></label>
                      <button className="button secondary" disabled={libraryBusy} onClick={() => void handleSaveTags()}><Tags size={16} />保存标签</button>
                      <button className="button secondary" onClick={() => setOriginalViewerAsset(selected)}><Maximize2 size={16} />原图显示</button>
                      <button className="button secondary" onClick={() => void copyText(selected.remote_url)}><Copy size={16} />复制 URL</button>
                      <button className="button secondary" onClick={() => void copyText(`![${selected.file_name}](${selected.remote_url})`)}><Copy size={16} />复制 Markdown</button>
                      <button className="button secondary" onClick={() => void openExternalUrl(selected.remote_url).catch((error) => showToast('error', normalizeError(error)))}><ExternalLink size={16} />使用系统浏览器打开</button>
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
                <div className="panel settings-panel account-manager-panel">
                  <div className="panel-heading"><div><span>UPLOAD IDENTITIES</span><h2>上传账号管理</h2><p>账号分别保存凭据、Token 和上传额度；所有账号共同使用下方同一个图片库。</p></div><UserRound size={20} /></div>
                  <div className="account-create-row">
                    <label className="field"><span>账号名称</span><input value={accountDraft} onChange={(event) => setAccountDraft(event.target.value)} list="account-options" placeholder="例如：个人、工作" /></label>
                    <datalist id="account-options">{accountProfiles.map((profile) => <option key={profile.account_name} value={profile.account_name} />)}</datalist>
                    <button className="button primary" disabled={accountSwitching || !accountDraft.trim()} onClick={() => void handleSwitchAccount(accountDraft)}>{accountSwitching ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}添加或切换</button>
                  </div>
                  <div className="account-profile-grid">
                    {accountProfiles.map((profile) => (
                      <button key={profile.account_name} className={profile.account_name === accountName ? 'account-profile active' : 'account-profile'} onClick={() => void handleSwitchAccount(profile.account_name)}>
                        <strong>{profile.account_name}</strong><small>{profile.asset_count} 条来源记录 · {profile.cached_count} 张已缓存</small><span>{profile.credential_configured ? '已登录' : '未登录'} · {profile.token_configured ? 'Token 已配置' : 'Token 未配置'}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="panel settings-panel">
                  <div className="panel-heading"><div><span>YUQUE ACCOUNT</span><h2>语雀登录</h2><p>当前账号：{accountName}。登录会话用于上传图片和私有图片回源。</p></div><div className={credentialReady ? 'status ready-status' : 'status'}>{credentialReady ? <CheckCircle2 size={15} /> : <KeyRound size={15} />}{credentialReady ? '已连接' : '未连接'}</div></div>
                  <div className="actions">
                    <button className="button primary" disabled={loginBusy} onClick={() => void handleOpenYuqueLogin()}>{loginBusy ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}登录语雀</button>
                    <button className="button secondary" disabled={loginBusy} onClick={() => void handleCaptureYuqueLogin()}><ShieldCheck size={17} />完成登录并保存</button>
                    <button className="button danger" disabled={!credentialReady} onClick={() => void handleClearCredential()}><Trash2 size={17} />清除登录凭据</button>
                  </div>
                  <details>
                    <summary>高级：手动粘贴 Cookie</summary>
                    <label className="field"><span>完整 Cookie</span><textarea value={cookieInput} onChange={(event) => setCookieInput(event.target.value)} rows={6} placeholder="从 /api/upload/attach 请求头复制完整 Cookie 值" /><small>长 Cookie 会自动拆分成多个系统密钥库条目。</small></label>
                    <button className="button secondary" disabled={loginBusy || !cookieInput.trim()} onClick={() => void handleManualCookieSave()}><ShieldCheck size={17} />手动安全保存</button>
                  </details>
                </div>

                <div className="panel settings-panel token-panel">
                  <div className="panel-heading"><div><span>YUQUE OPENAPI</span><h2>OpenAPI Token</h2><p>用于读取和管理知识库、创建文件夹文档，并将单图上限从 10 MB 提升到 50 MB。</p></div><div className={tokenReady ? 'status ready-status' : 'status'}>{tokenReady ? <CheckCircle2 size={15} /> : <KeyRound size={15} />}{tokenReady ? '50 MB 模式' : '10 MB 模式'}</div></div>
                  <label className="field"><span>Token</span><input type="password" autoComplete="off" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder={tokenReady ? '输入新 Token 可覆盖现有配置' : '粘贴语雀 OpenAPI Token'} /><small>Token 不写入 localStorage、SQLite 或前端配置文件。</small></label>
                  <div className="actions">
                    <button className="button primary" disabled={tokenBusy || !tokenInput.trim()} onClick={() => void handleSaveToken()}>{tokenBusy ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}安全保存 Token</button>
                    <button className="button danger" disabled={tokenBusy || !tokenReady} onClick={() => void handleClearToken()}><Trash2 size={17} />清除 Token</button>
                  </div>
                </div>

                <div className="panel settings-panel upload-context-panel">
                <div className="panel-heading"><div><span>UPLOAD CONTEXT</span><h2>上传上下文文档</h2><p>每个账号绑定自己有权限的语雀文档，作为图片上传的文档上下文。</p></div><ExternalLink size={20} /></div>
                <label className="field"><span>语雀文档 URL</span><input type="url" value={uploadContextInput} onChange={(event) => setUploadContextInput(event.target.value)} placeholder="https://www.yuque.com/账号/知识库/文档" /><small>{tokenReady ? '使用 OpenAPI Token 验证并解析文档 ID。' : '未配置 Token 时，使用当前登录会话读取文档页面并解析 ID。'}本地只保存文档 URL、ID 和标题。</small></label>
                {uploadContext && <p className="panel-note">已绑定：{uploadContext.title} · 文档 ID {uploadContext.attachable_id}</p>}
                <div className="actions">
                  <button className="button primary" disabled={uploadContextBusy || !credentialReady || !uploadContextInput.trim()} onClick={() => void handleSaveUploadContext()}>{uploadContextBusy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}验证并保存</button>
                  <button className="button danger" disabled={uploadContextBusy || !uploadContext} onClick={handleClearUploadContext}><Trash2 size={17} />清除上下文</button>
                </div>
              </div>

              <div className="panel settings-panel quota-panel">
                  <div className="panel-heading"><div><span>UPLOAD GOVERNOR</span><h2>上传批次与额度</h2><p>当前小时额度内连续上传；额度用完后，剩余任务自动进入下一批。</p></div><Gauge size={20} /></div>
                  <div className="quota-metrics">
                    <div><strong>{quota?.used ?? 0}</strong><small>过去一小时尝试</small></div>
                    <div><strong>{quota?.remaining ?? 140}</strong><small>剩余额度</small></div>
                    <div><strong>连续</strong><small>额度内立即上传</small></div>
                  </div>
                  <p className="panel-note">不再对每张图片设置固定秒级等待。失败请求仍计入本地小时额度；无 Token 单图上限 10 MB，保存 Token 后为 50 MB。超出当前额度的队列任务会自动安排到下一窗口。</p>
                </div>

                <div className="panel settings-panel cache-panel">
                  <div className="panel-heading"><div><span>PREVIEW CACHE</span><h2>图片显示与缓存</h2><p>本地缓存 → 已上传 URL 限速缩略图 → 语雀会话回源 → 可选兼容代理。</p></div><HardDrive size={20} /></div>
                  <div className="cache-metrics">
                    <div><Database size={17} /><strong>{cacheStats.cached_count}/{cacheStats.asset_count}</strong><small>已缓存图片</small></div>
                    <div><HardDrive size={17} /><strong>{formatBytes(cacheStats.cache_bytes)}</strong><small>缓存占用</small></div>
                  </div>
                  <label className="toggle-row">
                    <span><Globe2 size={17} /><span><strong>WordPress CDN 兼容兜底</strong><small>仅在本地、远程 URL 和语雀回源均失败时使用 `i3.wp.com`。</small></span></span>
                    <input className="switch-input" type="checkbox" checked={allowWordpressFallback} onChange={(event) => handleWordpressFallbackChange(event.target.checked)} />
                  </label>
                  <div className="actions"><button className="button danger" disabled={cacheBusy || cacheStats.cached_count === 0} onClick={() => void handleClearPreviewCache()}>{cacheBusy ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}清理共享图库缓存</button></div>
                </div>
              </div>
              <div className="guide"><ShieldCheck size={24} /><div><h3>共享图库策略</h3><ol><li>所有账号上传的图片统一进入同一个本地图库与分类体系。</li><li>每条记录保留来源账号，私有图片优先使用来源账号会话回源。</li><li>上传队列、Cookie、Token 和小时额度仍按账号隔离。</li><li>切换账号只改变新的上传身份，不影响图库筛选和当前选择。</li><li>共享缓存只保存一份，可在设置中统一清理和重建。</li></ol></div></div>
            </div>
          )}
        </section>
      </main>

      {originalViewerAsset && <OriginalImageViewer asset={originalViewerAsset} cacheEpoch={cacheEpoch} onClose={() => setOriginalViewerAsset(null)} onCacheChanged={handlePreviewCached} />}

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

function resolveRetryTimestamp(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.max(parsed + 1_000, Date.now() + 60_000)
    : Date.now() + AUTO_UPLOAD_DELAY_MS;
}

function formatScheduleTime(value: number): string {
  return new Date(value).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function parseTags(value: string): string[] {
  return Array.from(new Set(value.split(/[,，;；\n]/).map((item) => item.trim()).filter(Boolean))).slice(0, 20);
}

function normalizeError(error: unknown) {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '操作失败，请检查语雀登录状态、网络连接和本地缓存权限。';
}
