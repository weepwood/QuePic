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
  Users,
  X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import { AssetPreview } from './components/AssetPreview';
import { BatchDocumentUploader } from './components/BatchDocumentUploader';
import { YuqueDocumentManager } from './components/YuqueDocumentManager';
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
import {
  nextHourlyResetTimestamp,
  NO_TOKEN_MAX_UPLOAD_BYTES,
  prioritizeUploadProfiles,
  TOKEN_MAX_UPLOAD_BYTES,
  uploadLimitForProfile,
} from './lib/uploadRouting';
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
const QUEUE_PREVIEW_EDGE = 160;
const QUEUE_PREVIEW_CONCURRENCY = 3;
const PRIMARY_ACCOUNT_STORAGE_KEY = 'quepic-primary-account';
const ACCOUNT_FAILOVER_STORAGE_KEY = 'quepic-account-failover';
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
        {item.uploadAccountName && <small>实际上传账号：{item.uploadAccountName}</small>}
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
  const [primaryAccountName, setPrimaryAccountName] = useState(
    () => localStorage.getItem(PRIMARY_ACCOUNT_STORAGE_KEY)?.trim() || initialAccount,
  );
  const [accountFailoverEnabled, setAccountFailoverEnabled] = useState(
    () => localStorage.getItem(ACCOUNT_FAILOVER_STORAGE_KEY) !== 'false',
  );
  const [masterKnowledgeBaseUrl, setMasterKnowledgeBaseUrl] = useState(
    () => localStorage.getItem('quepic-knowledge-base-url') || '',
  );
  const [masterDocumentUrl, setMasterDocumentUrl] = useState(
    () => localStorage.getItem('quepic-document-url') || '',
  );
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
    if (accountProfiles.length === 0) return;
    if (accountProfiles.some((profile) => profile.account_name === primaryAccountName)) return;
    const nextPrimary = accountProfiles.find((profile) => profile.token_configured)?.account_name
      || accountProfiles.find((profile) => profile.credential_configured)?.account_name
      || accountProfiles[0].account_name;
    setPrimaryAccountName(nextPrimary);
    localStorage.setItem(PRIMARY_ACCOUNT_STORAGE_KEY, nextPrimary);
  }, [accountProfiles, primaryAccountName]);

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

  const activeQueue = queue;
  const pendingUploadCount = activeQueue.filter((item) => ['waiting', 'failed', 'scheduled'].includes(item.status)).length;
  const scheduledUploadCount = activeQueue.filter((item) => item.status === 'scheduled').length;
  const nextScheduledAt = activeQueue
    .filter((item) => item.status === 'scheduled' && item.scheduledAt)
    .reduce<number | null>((earliest, item) => earliest === null ? item.scheduledAt : Math.min(earliest, item.scheduledAt || earliest), null);
  const primaryProfile = accountProfiles.find((profile) => profile.account_name === primaryAccountName);
  const primaryCredentialReady = primaryProfile?.credential_configured
    ?? (primaryAccountName === accountName && credentialReady);
  const primaryTokenReady = primaryProfile?.token_configured
    ?? (primaryAccountName === accountName && tokenReady);
  const fallbackProfiles = accountProfiles.filter(
    (profile) => profile.account_name !== primaryAccountName && profile.credential_configured,
  );
  const maxUploadBytes = primaryTokenReady ? TOKEN_MAX_UPLOAD_BYTES : NO_TOKEN_MAX_UPLOAD_BYTES;
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
      showToast('error', `已忽略非图片、空文件或超过 ${maxUploadMegabytes} MB 的图片。${primaryTokenReady ? '' : ' 主账号保存 OpenAPI Token 后可上传 50 MB 图片。'}`);
    }
    if (accepted.length === 0) return;
    const account = primaryAccountName;
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

  const preparePrimaryUploadContext = useCallback(async (targetAccount: string) => {
    const token = await getOpenApiTokenStatus(targetAccount);
    if (!token.configured) return false;
    const document = await ensureDailyImageDocument(targetAccount);
    const context = getStoredUploadContext(targetAccount);
    if (!document || !context) return false;
    if (activeAccountRef.current === targetAccount) {
      setUploadContext(context);
      setUploadContextInput(context.document_url);
    }
    return true;
  }, []);

  const uploadOne = useCallback(async (
    id: string,
    uploadAccountName: string,
    contextAccountName: string,
    deferRefresh = false,
  ) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item || item.status === 'uploading' || item.status === 'success') return null;
    if (item.result) {
      const restored = markQueueItem(id, {
        status: 'success',
        uploadAccountName: item.uploadAccountName || uploadAccountName,
        scheduledAt: null,
        error: undefined,
      });
      if (restored) await saveStoredQueueItem(toStoredQueueItem(restored));
      return item.result;
    }
    const credential = await getCredentialStatus(uploadAccountName);
    if (!credential.configured) {
      const failed = markQueueItem(id, {
        status: 'failed',
        uploadAccountName,
        scheduledAt: null,
        error: `账号“${uploadAccountName}”尚未保存有效语雀会话。`,
      });
      if (failed) await saveStoredQueueItem(toStoredQueueItem(failed));
      return null;
    }

    markQueueItem(id, { status: 'uploading', uploadAccountName, scheduledAt: null, error: undefined });
    try {
      const result = await uploadImage(
        item.file,
        uploadAccountName,
        item.width,
        item.height,
        item.category,
        item.tags || [],
        contextAccountName,
      );
      const succeeded = markQueueItem(id, {
        status: 'success',
        result,
        uploadAccountName,
        scheduledAt: null,
        error: undefined,
      });
      if (succeeded) await saveStoredQueueItem(toStoredQueueItem(succeeded));
      if (!deferRefresh) {
        await Promise.all([refreshAssets(), refreshCacheStats(), refreshProfiles()]);
        if (activeAccountRef.current === uploadAccountName) {
          await refreshAccountStatus(uploadAccountName);
        }
      }
      return result;
    } catch (error) {
      const failed = markQueueItem(id, {
        status: 'failed',
        uploadAccountName,
        scheduledAt: null,
        error: `账号“${uploadAccountName}”上传失败：${normalizeError(error)}`,
      });
      if (failed) await saveStoredQueueItem(toStoredQueueItem(failed));
      if (!deferRefresh && activeAccountRef.current === uploadAccountName) {
        await refreshAccountStatus(uploadAccountName);
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

  const scheduleRemaining = async () => {
    const scheduledAt = nextHourlyResetTimestamp();
    const updated: UploadQueueItem[] = [];
    commitQueue((current) => current.map((item) => {
      if (!['waiting', 'failed', 'scheduled'].includes(item.status)) return item;
      const next: UploadQueueItem = { ...item, status: 'scheduled', scheduledAt, error: undefined };
      updated.push(next);
      return next;
    }));
    if (updated.length === 0) return showToast('error', '当前队列没有可计划的剩余图片。');
    try {
      await saveStoredQueueItems(updated.map(toStoredQueueItem));
      showToast('success', `已将 ${updated.length} 张图片安排到下一整点 ${formatScheduleTime(scheduledAt)} 自动上传。`);
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

  const resolveRoutingCandidates = useCallback(async (targetPrimary: string) => {
    const profiles = await listAccountProfiles();
    const primary = profiles.find((profile) => profile.account_name === targetPrimary);
    if (!primary?.credential_configured) throw new Error(`主账号“${targetPrimary}”尚未登录语雀。`);
    if (!primary.token_configured) throw new Error(`主账号“${targetPrimary}”必须配置 OpenAPI Token。`);
    const eligible = [
      primary,
      ...(accountFailoverEnabled
        ? profiles.filter((profile) => profile.account_name !== targetPrimary && profile.credential_configured)
        : []),
    ];
    const quotas = await Promise.all(eligible.map((profile) => getUploadQuotaStatus(profile.account_name)));
    return eligible.map((profile, index) => ({ profile, quota: quotas[index] }));
  }, [accountFailoverEnabled]);

  const processUploadBatch = useCallback(async (items: UploadQueueItem[], announce: boolean) => {
    const targetPrimary = primaryAccountName.trim() || DEFAULT_ACCOUNT;
    if (!(await preparePrimaryUploadContext(targetPrimary))) {
      throw new Error(`主账号“${targetPrimary}”必须配置 Token，才能创建当天文档并作为上传主账号。`);
    }
    const candidates = await resolveRoutingCandidates(targetPrimary);
    const profiles = candidates.map((candidate) => candidate.profile);
    const quotaRemaining = new Map(
      candidates.map((candidate) => [candidate.profile.account_name, candidate.quota.remaining]),
    );
    const remaining: UploadQueueItem[] = [];
    const dailyImages: DailyDocumentImage[] = [];
    const dailyItems: UploadQueueItem[] = [];
    const routedCounts = new Map<string, number>();
    let successCount = 0;
    let deduplicatedCount = 0;
    let failedCount = 0;

    for (const item of items) {
      if (item.result) {
        const result = await uploadOne(
          item.id,
          item.uploadAccountName || targetPrimary,
          targetPrimary,
          true,
        );
        if (!result) {
          failedCount += 1;
          remaining.push(item);
          continue;
        }
        successCount += 1;
        deduplicatedCount += 1;
        dailyImages.push({ asset_id: result.asset.id, file_name: item.file.name, remote_url: result.asset.remote_url });
        dailyItems.push(item);
        continue;
      }

      const orderedProfiles = prioritizeUploadProfiles(
        profiles,
        targetPrimary,
        accountFailoverEnabled,
        item.file.size,
      );
      let completed = false;
      for (const profile of orderedProfiles) {
        const available = quotaRemaining.get(profile.account_name) ?? 0;
        if (available <= 0 || item.file.size > uploadLimitForProfile(profile)) continue;
        const result = await uploadOne(item.id, profile.account_name, targetPrimary, true);
        if (!result) {
          quotaRemaining.set(profile.account_name, available - 1);
          failedCount += 1;
          continue;
        }
        if (!result.deduplicated) quotaRemaining.set(profile.account_name, available - 1);
        successCount += 1;
        if (result.deduplicated) deduplicatedCount += 1;
        routedCounts.set(profile.account_name, (routedCounts.get(profile.account_name) || 0) + 1);
        dailyImages.push({ asset_id: result.asset.id, file_name: item.file.name, remote_url: result.asset.remote_url });
        dailyItems.push(item);
        completed = true;
        break;
      }
      if (!completed) remaining.push(item);
    }

    let scheduledAt: number | null = null;
    if (remaining.length > 0) {
      scheduledAt = nextHourlyResetTimestamp();
      await rescheduleItems(remaining, scheduledAt, '当前可用账号额度不足，等待下一整点重置');
    }

    await Promise.all([refreshAssets(), refreshCacheStats(), refreshProfiles()]);
    if (activeAccountRef.current) await refreshAccountStatus(activeAccountRef.current);

    let dailyDocumentTitle = '';
    let dailyDocumentError = '';
    if (dailyImages.length > 0) {
      try {
        const dailyDocument = await appendImagesToDailyDocument(targetPrimary, dailyImages);
        if (!dailyDocument) throw new Error('主账号当天文档未返回有效结果。');
        dailyDocumentTitle = dailyDocument.title;
        await Promise.all(dailyItems.map((item) => removeStoredQueueItem(item.id)));
      } catch (documentError) {
        dailyDocumentError = await persistDailyDocumentSyncFailure(dailyItems, documentError);
      }
    }

    const summary: string[] = [];
    if (successCount > 0) summary.push(`成功处理 ${successCount} 张`);
    if (routedCounts.size > 0) {
      summary.push(Array.from(routedCounts.entries()).map(([name, count]) => `${name} ${count} 张`).join('、'));
    }
    if (deduplicatedCount > 0) summary.push(`${deduplicatedCount} 张复用历史链接`);
    if (failedCount > 0) summary.push(`${failedCount} 次上传失败`);
    if (remaining.length > 0 && scheduledAt) summary.push(`${remaining.length} 张将在 ${formatScheduleTime(scheduledAt)} 继续`);
    if (dailyDocumentTitle) summary.push(`已写入主账号当天文档“${dailyDocumentTitle}”`);
    const message = summary.join('，') || '没有需要处理的图片。';
    if (dailyDocumentError) showToast('error', `${message}；当天文档同步失败：${dailyDocumentError}`);
    else if (announce) showToast(failedCount > 0 ? 'error' : 'success', message);
  }, [
    accountFailoverEnabled,
    persistDailyDocumentSyncFailure,
    preparePrimaryUploadContext,
    primaryAccountName,
    refreshAccountStatus,
    refreshAssets,
    refreshCacheStats,
    refreshProfiles,
    rescheduleItems,
    resolveRoutingCandidates,
    showToast,
    uploadOne,
  ]);

  const retryUploadOne = useCallback(async (id: string) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    try {
      await processUploadBatch([item], true);
    } catch (error) {
      setView('settings');
      showToast('error', normalizeError(error));
    }
  }, [processUploadBatch, showToast]);

  const uploadAll = async () => {
    const pendingItems = queueRef.current.filter((item) => ['waiting', 'failed', 'scheduled'].includes(item.status));
    if (pendingItems.length === 0) return showToast('error', '当前队列没有等待上传的图片。');
    try {
      await processUploadBatch(pendingItems, true);
    } catch (error) {
      setView('settings');
      showToast('error', normalizeError(error));
    }
  };

  const runDueUploads = useCallback(async () => {
    if (autoUploadRunningRef.current) return;
    const due = queueRef.current.filter((item) => item.status === 'scheduled' && (item.scheduledAt || 0) <= Date.now());
    if (due.length === 0) return;
    autoUploadRunningRef.current = true;
    try {
      await processUploadBatch(due, false);
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
  }, [processUploadBatch, rescheduleItems, showToast]);

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
    const completed = queueRef.current.filter((item) => item.status === 'success');
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
    upload: { title: '上传图片', description: '小图优先使用子账号，大图由主账号上传，所有链接统一写入主账号文档。' },
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
          <div><strong>{quota ? `${quota.remaining}/${quota.limit}` : '--'} 张可用</strong><small>当前账号 · 整点重置额度</small></div>
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
                <div className="drop-hints"><span>单张 {maxUploadMegabytes} MB</span><span>{primaryTokenReady ? '主账号 Token 增强模式' : '主账号基础模式'}</span><span>每账号 140 张/整点小时</span><span>小图子账号优先 · 大图主账号</span><span>队列持久化</span></div>
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
                  <div><span>UPLOAD ROUTER · 主账号 {primaryAccountName}</span><h2>上传图片队列</h2><p>{pendingUploadCount ? `${pendingUploadCount} 项等待处理` : '没有待处理任务'}</p></div>
                  <div className="queue-heading-actions">
                    <button className="button secondary compact" disabled={pendingUploadCount === 0} onClick={() => void scheduleRemaining()}><CalendarClock size={16} />延后到下一整点</button>
                    <button className="button primary compact" disabled={!primaryCredentialReady || !primaryTokenReady || pendingUploadCount === 0} onClick={() => void uploadAll()}><UploadCloud size={16} />开始智能上传</button>
                  </div>
                </div>
                <div className="quota-strip">
                  <Gauge size={16} />
                  <span>{accountName === primaryAccountName && quota ? `主账号本整点已使用 ${quota.used}/${quota.limit}，剩余 ${quota.remaining}` : `主账号 ${primaryAccountName}，子账号 ${accountFailoverEnabled ? '自动接力' : '未启用'}`}</span>
                  <b>每小时整点重置</b>
                </div>
                {nextScheduledAt && (
                  <div className="queue-schedule-banner"><CalendarClock size={16} /><span>下一批自动上传：{formatScheduleTime(nextScheduledAt)}</span><small>所有账号在整点统一进入新额度窗口；应用关闭后会在下次启动补传。</small></div>
                )}
                {!primaryCredentialReady && <div className="warning">主账号“{primaryAccountName}”尚未保存语雀会话。</div>}
                {primaryCredentialReady && !primaryTokenReady && <div className="warning">主账号“{primaryAccountName}”必须配置 OpenAPI Token；子账号可以不配置 Token。</div>}
                {primaryCredentialReady && primaryTokenReady && <div className="queue-auto-context-note">主账号负责当天文档和大图；已登录子账号优先处理不超过 10 MB 的小图，图片链接仍统一写入主账号当天文档。</div>}
                {activeQueue.length === 0 ? <div className="empty"><FileImage size={26} /><p>主账号与子账号共同处理的全局上传队列会显示在这里。</p></div> : (
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

          <div style={{ display: view === 'document' ? 'block' : 'none' }}>
            <BatchDocumentUploader
              primaryAccountName={primaryAccountName}
              accountFailoverEnabled={accountFailoverEnabled}
              knowledgeBaseUrl={masterKnowledgeBaseUrl}
              documentUrl={masterDocumentUrl}
              onUploaded={() => void Promise.all([refreshAssets(), refreshCacheStats(), refreshAccountStatus(), refreshProfiles()])}
            />
          </div>

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
                <div className="panel settings-panel unified-settings-panel">
                  <div className="panel-heading">
                    <div><span>UNIFIED CONFIGURATION</span><h2>账号与应用设置</h2><p>账号、主子关系、凭据、Token、目标知识库和缓存统一在这里管理。</p></div>
                    <Settings size={20} />
                  </div>

                  <section className="settings-section">
                    <div className="settings-section-heading"><div><strong>账号与角色</strong><small>主账号负责 Token、文档和大图；子账号只需要 Cookie。</small></div><UserRound size={18} /></div>
                    <div className="account-create-row">
                      <label className="field"><span>账号名称</span><input value={accountDraft} onChange={(event) => setAccountDraft(event.target.value)} list="account-options" placeholder="例如：主账号、子账号 1" /></label>
                      <datalist id="account-options">{accountProfiles.map((profile) => <option key={profile.account_name} value={profile.account_name} />)}</datalist>
                      <button className="button primary" disabled={accountSwitching || !accountDraft.trim()} onClick={() => void handleSwitchAccount(accountDraft)}>{accountSwitching ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}添加或切换</button>
                    </div>
                    <div className="account-profile-grid">
                      {accountProfiles.map((profile) => (
                        <button key={profile.account_name} className={profile.account_name === accountName ? 'account-profile active' : 'account-profile'} onClick={() => void handleSwitchAccount(profile.account_name)}>
                          <strong>{profile.account_name}{profile.account_name === primaryAccountName ? ' · 主账号' : ' · 子账号'}</strong>
                          <small>{profile.asset_count} 条来源记录 · {profile.cached_count} 张已缓存</small>
                          <span>{profile.credential_configured ? 'Cookie 已配置' : 'Cookie 未配置'} · {profile.account_name === primaryAccountName ? (profile.token_configured ? 'Token 已配置' : 'Token 缺失') : '无需 Token'}</span>
                        </button>
                      ))}
                    </div>
                    <label className="field"><span>主账号</span><select value={primaryAccountName} onChange={(event) => { const value = event.target.value; setPrimaryAccountName(value); localStorage.setItem(PRIMARY_ACCOUNT_STORAGE_KEY, value); }}>{accountProfiles.map((profile) => <option key={profile.account_name} value={profile.account_name}>{profile.account_name}{profile.token_configured ? ' · Token' : ''}</option>)}</select><small>主账号必须登录并配置 Token；其他账号自动视为子账号。</small></label>
                    <label className="toggle-row">
                      <span><Users size={17} /><span><strong>启用子账号小图接力</strong><small>不超过 10 MB 的图片优先使用子账号；大图只使用主账号。</small></span></span>
                      <input className="switch-input" type="checkbox" checked={accountFailoverEnabled} onChange={(event) => { setAccountFailoverEnabled(event.target.checked); localStorage.setItem(ACCOUNT_FAILOVER_STORAGE_KEY, String(event.target.checked)); }} />
                    </label>
                    <p className="panel-note">子账号顺序：{fallbackProfiles.length ? fallbackProfiles.map((profile) => profile.account_name).join(' → ') : '暂无已登录子账号'}。子账号不需要 Token，也不需要配置或访问文档。</p>
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-heading"><div><strong>当前账号凭据：{accountName}</strong><small>完整 Cookie 与 Token 只保存在系统密钥库，不会返回 React、显示或复制。</small></div><KeyRound size={18} /></div>
                    <div className="actions">
                      <button className="button primary" disabled={loginBusy} onClick={() => void handleOpenYuqueLogin()}>{loginBusy ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}登录语雀</button>
                      <button className="button secondary" disabled={loginBusy} onClick={() => void handleCaptureYuqueLogin()}><ShieldCheck size={17} />完成登录并保存</button>
                      <button className="button danger" disabled={!credentialReady} onClick={() => void handleClearCredential()}><Trash2 size={17} />清除 Cookie</button>
                    </div>
                    <p className="panel-note">Cookie 状态：{credentialReady ? '已安全保存。需要更新时请重新登录或手动覆盖。' : '尚未配置。'}</p>
                    <details>
                      <summary>手动粘贴 Cookie</summary>
                      <label className="field"><span>完整 Cookie</span><textarea value={cookieInput} onChange={(event) => setCookieInput(event.target.value)} rows={5} placeholder="从语雀上传请求中复制 Cookie" /></label>
                      <button className="button secondary" disabled={loginBusy || !cookieInput.trim()} onClick={() => void handleManualCookieSave()}><Save size={17} />保存 Cookie</button>
                    </details>

                    {accountName === primaryAccountName ? (
                      <div className="credential-subsection">
                        <div className="settings-section-heading compact"><div><strong>主账号 OpenAPI Token</strong><small>用于创建和写入文档，并允许主账号上传 50 MB 图片。</small></div><span className={tokenReady ? 'status ready-status' : 'status'}>{tokenReady ? '已配置' : '未配置'}</span></div>
                        <label className="field"><span>更新 Token</span><input type="password" autoComplete="off" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder={tokenReady ? '输入新 Token 可覆盖' : '粘贴语雀 OpenAPI Token'} /></label>
                        <div className="actions">
                          <button className="button primary" disabled={tokenBusy || !tokenInput.trim()} onClick={() => void handleSaveToken()}>{tokenBusy ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}保存 Token</button>
                          <button className="button danger" disabled={tokenBusy || !tokenReady} onClick={() => void handleClearToken()}><Trash2 size={17} />清除 Token</button>
                        </div>
                        <p className="panel-note">Token 状态：{tokenReady ? '已安全保存。需要更新时请输入新 Token 覆盖。' : '尚未配置。'}</p>
                      </div>
                    ) : (
                      <div className="queue-auto-context-note">当前账号是子账号，只需保存 Cookie，不需要 Token，也不需要设置文档权限。</div>
                    )}
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-heading"><div><strong>主账号文档目标</strong><small>文件夹转文档只读取这里的配置，不再重复填写 URL。</small></div><ExternalLink size={18} /></div>
                    <YuqueDocumentManager
                      accountName={primaryAccountName}
                      tokenReady={primaryTokenReady}
                      disabled={!primaryTokenReady}
                      knowledgeBaseUrl={masterKnowledgeBaseUrl}
                      documentUrl={masterDocumentUrl}
                      onKnowledgeBaseUrlChange={(value) => { setMasterKnowledgeBaseUrl(value); if (value.trim()) localStorage.setItem('quepic-knowledge-base-url', value.trim()); else localStorage.removeItem('quepic-knowledge-base-url'); }}
                      onDocumentUrlChange={(value) => { setMasterDocumentUrl(value); if (value.trim()) localStorage.setItem('quepic-document-url', value.trim()); else localStorage.removeItem('quepic-document-url'); }}
                    />
                    {!primaryProfile?.credential_configured && <div className="warning">主账号尚未保存 Cookie。</div>}
                    {primaryProfile?.credential_configured && !primaryProfile.token_configured && <div className="warning">主账号必须配置 Token 后才能管理目标文档。</div>}
                  </section>

                  <section className="settings-section settings-summary-grid">
                    <div>
                      <div className="settings-section-heading compact"><div><strong>当前账号整点额度</strong><small>每个账号独立计算，整点自动重置。</small></div><Gauge size={18} /></div>
                      <div className="quota-metrics"><div><strong>{quota?.used ?? 0}</strong><small>本小时尝试</small></div><div><strong>{quota?.remaining ?? 140}</strong><small>剩余额度</small></div><div><strong>{accountName === primaryAccountName ? '50 MB' : '10 MB'}</strong><small>单图上限</small></div></div>
                    </div>
                    <div>
                      <div className="settings-section-heading compact"><div><strong>本地预览缓存</strong><small>只保留统一缓存清理功能。</small></div><HardDrive size={18} /></div>
                      <div className="cache-metrics"><div><Database size={17} /><strong>{cacheStats.cached_count}/{cacheStats.asset_count}</strong><small>已缓存图片</small></div><div><HardDrive size={17} /><strong>{formatBytes(cacheStats.cache_bytes)}</strong><small>缓存占用</small></div></div>
                      <button className="button danger" disabled={cacheBusy || cacheStats.cached_count === 0} onClick={() => void handleClearPreviewCache()}>{cacheBusy ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}清理共享缓存</button>
                    </div>
                  </section>
                </div>
              </div>
              <div className="guide"><ShieldCheck size={24} /><div><h3>简化后的工作方式</h3><ol><li>主账号只配置一次 Cookie、Token 和文档目标。</li><li>子账号只保存 Cookie，小图自动优先使用子账号额度。</li><li>大图始终使用主账号，所有图片链接统一写入主账号文档。</li><li>普通上传和文件夹转文档共享同一套整点配额与账号路由。</li><li>文件夹任务在页面切换后继续运行并保留状态。</li></ol></div></div>
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
    ? Math.max(parsed + 1_000, Date.now() + 1_000)
    : nextHourlyResetTimestamp();
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
