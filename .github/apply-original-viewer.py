from pathlib import Path

ROOT = Path('.')


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'未找到待替换内容: {path}: {old[:120]!r}')
    target.write_text(text.replace(old, new, 1), encoding='utf-8')


# AssetPreview: support original aspect ratio cards.
asset_preview = '''import { convertFileSrc } from '@tauri-apps/api/core';
import { ImageOff, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import { ensurePreview } from '../lib/tauri';
import type { AssetRecord } from '../types';

interface AssetPreviewProps {
  asset: AssetRecord;
  preferOriginal?: boolean;
  preserveAspectRatio?: boolean;
  allowWordpressFallback: boolean;
  cacheEpoch: number;
  className?: string;
  onCacheChanged?: () => void;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

export function AssetPreview({
  asset,
  preferOriginal = false,
  preserveAspectRatio = false,
  allowWordpressFallback,
  cacheEpoch,
  className = '',
  onCacheChanged,
}: AssetPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const [visible, setVisible] = useState(preferOriginal);
  const [state, setState] = useState<LoadState>('idle');
  const [src, setSrc] = useState<string | null>(null);
  const [source, setSource] = useState<string>(asset.preview_source || 'missing');
  const [retryNonce, setRetryNonce] = useState(0);

  const storedPath = useMemo(() => {
    if (preferOriginal) return asset.original_path || asset.thumbnail_path;
    return asset.thumbnail_path || asset.original_path;
  }, [asset.original_path, asset.thumbnail_path, preferOriginal]);
  const aspectRatio = preserveAspectRatio && asset.width && asset.height
    ? `${asset.width} / ${asset.height}`
    : undefined;

  useEffect(() => {
    if (preferOriginal) {
      setVisible(true);
      return;
    }
    const element = containerRef.current;
    if (!element || !('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '100px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [preferOriginal]);

  useEffect(() => {
    requestIdRef.current += 1;
    setSrc(null);
    setState('idle');
    setSource(asset.preview_source || 'missing');
  }, [asset.id, asset.preview_source, cacheEpoch, preferOriginal]);

  useEffect(() => {
    if (!visible) return undefined;
    const requestId = ++requestIdRef.current;
    let disposed = false;

    const commit = (callback: () => void) => {
      if (!disposed && requestId === requestIdRef.current) callback();
    };

    const load = async () => {
      if (storedPath) {
        commit(() => {
          setSrc(convertFileSrc(storedPath));
          setSource('local');
          setState('ready');
        });
        return;
      }

      commit(() => setState('loading'));
      try {
        const preview = await ensurePreview(
          asset.id,
          preferOriginal,
          allowWordpressFallback,
          retryNonce > 0,
        );
        commit(() => {
          setSrc(preview.local_path ? convertFileSrc(preview.local_path) : preview.proxy_url);
          setSource(preview.source);
          setState(preview.local_path || preview.proxy_url ? 'ready' : 'failed');
          if (preview.cached) onCacheChanged?.();
        });
      } catch {
        commit(() => {
          setSrc(null);
          setState('failed');
        });
      }
    };

    void load();
    return () => {
      disposed = true;
    };
  }, [allowWordpressFallback, asset.id, onCacheChanged, preferOriginal, retryNonce, storedPath, visible]);

  const retryAfterImageError = () => {
    setSrc(null);
    setState('idle');
    setRetryNonce((value) => value + 1);
  };

  return (
    <div
      ref={containerRef}
      className={`asset-preview ${preserveAspectRatio ? 'preserve-ratio' : ''} ${className}`.trim()}
      style={aspectRatio ? { aspectRatio } : undefined}
    >
      {src && <img src={src} alt={asset.file_name} onError={retryAfterImageError} />}
      {!src && state === 'loading' && <LoaderCircle className="spin preview-state-icon" size={24} />}
      {!src && state === 'failed' && (
        <button className="preview-retry" type="button" onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          retryAfterImageError();
        }}>
          <ImageOff size={22} />
          <span>加载失败</span>
          <RefreshCw size={14} />
        </button>
      )}
      {!src && state === 'idle' && <span className="preview-skeleton" />}
      {state === 'ready' && (
        <span className={`preview-source source-${source}`}>
          {source === 'local'
            ? '本地缓存'
            : source === 'remote_url'
              ? '远程缩略图'
              : source === 'yuque_session'
                ? '语雀回源'
                : source === 'wordpress_proxy'
                  ? '兼容代理'
                  : source}
        </span>
      )}
    </div>
  );
}
'''
(ROOT / 'src/components/AssetPreview.tsx').write_text(asset_preview, encoding='utf-8')

viewer = '''import { convertFileSrc } from '@tauri-apps/api/core';
import {
  Download,
  ImageOff,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ensurePreview, saveOriginalImage } from '../lib/tauri';
import type { AssetRecord } from '../types';

interface OriginalImageViewerProps {
  asset: AssetRecord;
  cacheEpoch: number;
  onClose: () => void;
  onCacheChanged?: () => void;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function OriginalImageViewer({
  asset,
  cacheEpoch,
  onClose,
  onCacheChanged,
}: OriginalImageViewerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [naturalSize, setNaturalSize] = useState({ width: asset.width || 0, height: asset.height || 0 });
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [saving, setSaving] = useState(false);

  const fitToViewport = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || naturalSize.width <= 0 || naturalSize.height <= 0) return;
    const availableWidth = Math.max(120, viewport.clientWidth - 56);
    const availableHeight = Math.max(120, viewport.clientHeight - 56);
    setZoom(clampZoom(Math.min(
      availableWidth / naturalSize.width,
      availableHeight / naturalSize.height,
      1,
    )));
    setFitMode(true);
  }, [naturalSize.height, naturalSize.width]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    setMessage('');
    void ensurePreview(asset.id, true, false, false)
      .then((preview) => {
        if (disposed) return;
        if (!preview.local_path) throw new Error('无法在本地建立原图缓存。');
        setSrc(convertFileSrc(preview.local_path));
        if (preview.cached) onCacheChanged?.();
      })
      .catch((loadError) => {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [asset.id, cacheEpoch, onCacheChanged]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === '+' || event.key === '=') {
        setFitMode(false);
        setZoom((value) => clampZoom(value * 1.2));
      }
      if (event.key === '-') {
        setFitMode(false);
        setZoom((value) => clampZoom(value / 1.2));
      }
      if (event.key === '0') {
        setFitMode(false);
        setZoom(1);
      }
      if (event.key.toLowerCase() === 'f') fitToViewport();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fitToViewport, onClose]);

  useEffect(() => {
    if (!fitMode) return undefined;
    const handleResize = () => fitToViewport();
    window.addEventListener('resize', handleResize);
    const timer = window.setTimeout(fitToViewport, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', handleResize);
    };
  }, [fitMode, fitToViewport, src]);

  const changeZoom = (factor: number) => {
    setFitMode(false);
    setZoom((value) => clampZoom(value * factor));
  };

  const handleDownload = async () => {
    setSaving(true);
    setMessage('');
    try {
      const result = await saveOriginalImage(asset.id);
      setMessage(result.cancelled ? '已取消保存。' : `原图已保存到：${result.path || '所选位置'}`);
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="original-viewer" role="dialog" aria-modal="true" aria-label={`查看原图 ${asset.file_name}`}>
      <button className="original-viewer-backdrop" type="button" aria-label="关闭原图查看器" onClick={onClose} />
      <section className="original-viewer-shell">
        <header className="original-viewer-toolbar">
          <div className="original-viewer-title">
            <strong>{asset.file_name}</strong>
            <span>{naturalSize.width && naturalSize.height ? `${naturalSize.width} × ${naturalSize.height}` : '正在读取原始尺寸'} · {Math.round(zoom * 100)}%</span>
          </div>
          <div className="original-viewer-controls">
            <button type="button" title="适应窗口 (F)" onClick={fitToViewport}><Maximize2 size={17} />适应</button>
            <button type="button" title="恢复 100% (0)" onClick={() => { setFitMode(false); setZoom(1); }}><RotateCcw size={17} />100%</button>
            <button type="button" title="缩小 (-)" onClick={() => changeZoom(1 / 1.2)}><Minus size={17} /></button>
            <button type="button" title="放大 (+)" onClick={() => changeZoom(1.2)}><Plus size={17} /></button>
            <button className="original-download" type="button" disabled={loading || Boolean(error) || saving} onClick={() => void handleDownload()}>
              {saving ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}保存原图
            </button>
            <button className="original-viewer-close" type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
          </div>
        </header>
        <div
          ref={viewportRef}
          className="original-viewer-viewport"
          onWheel={(event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            changeZoom(event.deltaY < 0 ? 1.12 : 1 / 1.12);
          }}
        >
          {loading && <div className="original-viewer-state"><LoaderCircle className="spin" size={30} /><span>正在通过来源账号回源并缓存原图</span></div>}
          {!loading && error && <div className="original-viewer-state error"><ImageOff size={32} /><strong>原图加载失败</strong><span>{error}</span></div>}
          {src && (
            <img
              src={src}
              alt={asset.file_name}
              draggable={false}
              style={naturalSize.width > 0 ? { width: `${naturalSize.width * zoom}px` } : undefined}
              onLoad={(event) => {
                const image = event.currentTarget;
                const next = { width: image.naturalWidth, height: image.naturalHeight };
                setNaturalSize(next);
                window.setTimeout(fitToViewport, 0);
              }}
            />
          )}
        </div>
        <footer className="original-viewer-footer">
          <span>按住 Ctrl/⌘ 滚轮缩放；放大后使用滚动条查看细节。原图不会交给浏览器直接打开。</span>
          {message && <strong>{message}</strong>}
        </footer>
      </section>
    </div>
  );
}
'''
(ROOT / 'src/components/OriginalImageViewer.tsx').write_text(viewer, encoding='utf-8')

viewer_css = '''.library-heading-controls {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.library-view-switch {
  display: inline-flex;
  min-height: 38px;
  padding: 3px;
  border: 1px solid #d9d9d9;
  border-radius: 9px;
  background: #fff;
}

.library-view-switch button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  color: #8c8c8c;
  background: transparent;
  cursor: pointer;
}

.library-view-switch button.active {
  color: var(--primary-dark);
  background: var(--primary-soft);
  font-weight: 600;
}

.asset-grid {
  align-items: start;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}

.asset-card {
  align-self: start;
}

.original-ratio-view .asset-card > .asset-preview.preserve-ratio {
  min-height: 120px;
  background:
    linear-gradient(45deg, #f5f5f5 25%, transparent 25%),
    linear-gradient(-45deg, #f5f5f5 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #f5f5f5 75%),
    linear-gradient(-45deg, transparent 75%, #f5f5f5 75%),
    #fff;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-size: 16px 16px;
}

.original-ratio-view .asset-card > .asset-preview.preserve-ratio img {
  object-fit: contain;
}

.square-view .asset-card > .asset-preview {
  aspect-ratio: 1 / 1;
}

.asset-original-action {
  position: absolute;
  z-index: 4;
  top: 8px;
  right: 8px;
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 1px solid rgba(0, 0, 0, .08);
  border-radius: 8px;
  color: #595959;
  background: rgba(255, 255, 255, .94);
  box-shadow: 0 2px 8px rgba(0, 0, 0, .08);
  cursor: pointer;
  opacity: 0;
  transform: translateY(-3px);
  transition: opacity .16s ease, transform .16s ease, color .16s ease;
}

.asset-card:hover .asset-original-action,
.asset-original-action:focus-visible {
  opacity: 1;
  transform: translateY(0);
}

.asset-original-action:hover {
  color: var(--primary-dark);
}

.original-viewer {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 22px;
}

.original-viewer-backdrop {
  position: absolute;
  inset: 0;
  border: 0;
  background: rgba(10, 14, 22, .78);
  backdrop-filter: blur(12px);
}

.original-viewer-shell {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(1480px, 96vw);
  height: min(920px, 94vh);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .18);
  border-radius: 18px;
  background: #151922;
  box-shadow: 0 30px 100px rgba(0, 0, 0, .42);
}

.original-viewer-toolbar,
.original-viewer-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 14px;
  color: #f5f5f5;
  background: rgba(24, 29, 40, .96);
}

.original-viewer-toolbar {
  justify-content: space-between;
  border-bottom: 1px solid rgba(255, 255, 255, .09);
}

.original-viewer-title {
  min-width: 0;
}

.original-viewer-title strong,
.original-viewer-title span {
  display: block;
}

.original-viewer-title strong {
  overflow: hidden;
  max-width: 46vw;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.original-viewer-title span,
.original-viewer-footer {
  color: #aeb7c7;
  font-size: 11px;
}

.original-viewer-title span {
  margin-top: 3px;
}

.original-viewer-controls {
  display: flex;
  align-items: center;
  gap: 7px;
}

.original-viewer-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 11px;
  border: 1px solid rgba(255, 255, 255, .13);
  border-radius: 9px;
  color: #e8ebf1;
  background: rgba(255, 255, 255, .06);
  cursor: pointer;
}

.original-viewer-controls button:hover:not(:disabled) {
  background: rgba(255, 255, 255, .12);
}

.original-viewer-controls .original-download {
  border-color: rgba(37, 184, 100, .5);
  color: #fff;
  background: rgba(37, 184, 100, .75);
}

.original-viewer-controls button:disabled {
  cursor: not-allowed;
  opacity: .5;
}

.original-viewer-viewport {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  background:
    linear-gradient(45deg, #171b24 25%, transparent 25%),
    linear-gradient(-45deg, #171b24 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #171b24 75%),
    linear-gradient(-45deg, transparent 75%, #171b24 75%),
    #11151d;
  background-position: 0 0, 0 12px, 12px -12px, -12px 0;
  background-size: 24px 24px;
}

.original-viewer-viewport img {
  display: block;
  max-width: none;
  max-height: none;
  height: auto;
  flex: 0 0 auto;
  user-select: none;
}

.original-viewer-state {
  display: grid;
  place-items: center;
  gap: 10px;
  max-width: 520px;
  padding: 28px;
  color: #c9d0dd;
  text-align: center;
}

.original-viewer-state.error {
  color: #ffb3b3;
}

.original-viewer-footer {
  justify-content: space-between;
  min-height: 44px;
  border-top: 1px solid rgba(255, 255, 255, .09);
}

.original-viewer-footer strong {
  overflow: hidden;
  color: #8ee0b1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 980px) {
  .library-heading-controls {
    width: 100%;
    justify-content: flex-start;
  }

  .library-view-switch {
    order: -1;
  }

  .original-viewer {
    padding: 0;
  }

  .original-viewer-shell {
    width: 100vw;
    height: 100vh;
    border-radius: 0;
  }

  .original-viewer-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .original-viewer-title strong {
    max-width: 88vw;
  }

  .original-viewer-controls {
    width: 100%;
    overflow-x: auto;
  }

  .original-viewer-footer {
    align-items: flex-start;
    flex-direction: column;
  }
}
'''
(ROOT / 'src/original-viewer.css').write_text(viewer_css, encoding='utf-8')

# main style import.
replace_once(
    'src/main.tsx',
    "import './ui-polish.css';\n",
    "import './ui-polish.css';\nimport './original-viewer.css';\n",
)

# Types.
replace_once(
    'src/types.ts',
    "export interface UploadResult {\n  asset: AssetRecord;\n  deduplicated: boolean;\n}\n",
    "export interface UploadResult {\n  asset: AssetRecord;\n  deduplicated: boolean;\n}\n\nexport interface SaveOriginalResult {\n  cancelled: boolean;\n  path: string | null;\n}\n\nexport interface DailyDocumentImage {\n  file_name: string;\n  remote_url: string;\n}\n",
)

# Frontend Tauri bridge: safe save and daily Markdown document orchestration.
replace_once(
    'src/lib/tauri.ts',
    "  PreviewResult,\n  SaveYuqueDocumentInput,\n",
    "  DailyDocumentImage,\n  PreviewResult,\n  SaveOriginalResult,\n  SaveYuqueDocumentInput,\n",
)
replace_once(
    'src/lib/tauri.ts',
    "export async function getCacheStats(): Promise<CacheStats> {\n",
    "export async function saveOriginalImage(assetId: number): Promise<SaveOriginalResult> {\n  return invoke<SaveOriginalResult>('save_original_image', { assetId });\n}\n\nexport async function getCacheStats(): Promise<CacheStats> {\n",
)
replace_once(
    'src/lib/tauri.ts',
    "export async function saveYuqueDocument(\n  input: SaveYuqueDocumentInput,\n): Promise<YuqueDocumentResult> {\n  return invoke<YuqueDocumentResult>('create_yuque_document', { input });\n}\n",
    "export async function saveYuqueDocument(\n  input: SaveYuqueDocumentInput,\n): Promise<YuqueDocumentResult> {\n  return invoke<YuqueDocumentResult>('create_yuque_document', { input });\n}\n\nfunction localDateKey(date = new Date()): string {\n  const year = date.getFullYear();\n  const month = String(date.getMonth() + 1).padStart(2, '0');\n  const day = String(date.getDate()).padStart(2, '0');\n  return `${year}-${month}-${day}`;\n}\n\nfunction escapeMarkdownAlt(value: string): string {\n  return value.replaceAll('\\\\', '\\\\\\\\').replaceAll('[', '\\\\[').replaceAll(']', '\\\\]');\n}\n\nexport async function appendImagesToDailyDocument(\n  accountName: string,\n  images: DailyDocumentImage[],\n): Promise<YuqueDocumentResult | null> {\n  if (images.length === 0) return null;\n  const token = await getOpenApiTokenStatus(accountName);\n  if (!token.configured) return null;\n\n  const repository = await ensureQuePicRepository(accountName);\n  const documents = await listYuqueDocuments(accountName, repository.namespace);\n  const title = localDateKey();\n  const existing = documents.find((document) => document.title.trim() === title);\n  const time = new Date().toLocaleTimeString('zh-CN', {\n    hour: '2-digit',\n    minute: '2-digit',\n    second: '2-digit',\n    hour12: false,\n  });\n  const body = [\n    `## ${time}`,\n    '',\n    ...images.flatMap((image) => [\n      `![${escapeMarkdownAlt(image.file_name)}](${image.remote_url})`,\n      '',\n    ]),\n  ].join('\\n').trim();\n\n  return saveYuqueDocument({\n    account_name: accountName,\n    knowledge_base_url: repository.url,\n    document_url: existing?.url || null,\n    title,\n    body,\n  });\n}\n",
)

# App imports and state.
replace_once('src/App.tsx', "  ListChecks,\n  LoaderCircle,\n", "  ListChecks,\n  LoaderCircle,\n  Maximize2,\n")
replace_once(
    'src/App.tsx',
    "import { BatchDocumentUploader } from './components/BatchDocumentUploader';\n",
    "import { BatchDocumentUploader } from './components/BatchDocumentUploader';\nimport { OriginalImageViewer } from './components/OriginalImageViewer';\n",
)
replace_once(
    'src/App.tsx',
    "  captureYuqueLogin,\n",
    "  appendImagesToDailyDocument,\n  captureYuqueLogin,\n",
)
replace_once(
    'src/App.tsx',
    "type LibrarySort = 'newest' | 'oldest' | 'name' | 'size' | 'category';\n",
    "type LibrarySort = 'newest' | 'oldest' | 'name' | 'size' | 'category';\ntype LibraryViewMode = 'original' | 'square';\n",
)
replace_once(
    'src/App.tsx',
    "  const [selected, setSelected] = useState<AssetRecord | null>(null);\n",
    "  const [selected, setSelected] = useState<AssetRecord | null>(null);\n  const [originalViewerAsset, setOriginalViewerAsset] = useState<AssetRecord | null>(null);\n  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>(\n    () => localStorage.getItem('quepic-library-view') === 'square' ? 'square' : 'original',\n  );\n",
)

# uploadOne returns the result so batches can create daily documents.
replace_once('src/App.tsx', "if (!item || item.status === 'uploading' || item.status === 'success') return false;", "if (!item || item.status === 'uploading' || item.status === 'success') return null;")
replace_once('src/App.tsx', "      return false;\n    }\n\n    markQueueItem(id, { status: 'uploading'", "      return null;\n    }\n\n    markQueueItem(id, { status: 'uploading'")
replace_once('src/App.tsx', "      return true;\n    } catch (error) {", "      return result;\n    } catch (error) {")
replace_once('src/App.tsx', "      return false;\n    }\n  }, [markQueueItem", "      return null;\n    }\n  }, [markQueueItem")

# Add single retry daily sync.
replace_once(
    'src/App.tsx',
    "  const uploadAll = async () => {\n",
    "  const retryUploadOne = useCallback(async (id: string) => {\n    const item = queueRef.current.find((candidate) => candidate.id === id);\n    const result = await uploadOne(id);\n    if (!item || !result) return;\n    try {\n      const dailyDocument = await appendImagesToDailyDocument(item.accountName, [{\n        file_name: item.file.name,\n        remote_url: result.asset.remote_url,\n      }]);\n      if (dailyDocument) showToast('success', `图片已写入当天文档“${dailyDocument.title}”。`);\n    } catch (error) {\n      showToast('error', `图片上传成功，但当天文档同步失败：${normalizeError(error)}`);\n    }\n  }, [showToast, uploadOne]);\n\n  const uploadAll = async () => {\n",
)

# Batch daily document.
replace_once(
    'src/App.tsx',
    "      const immediateItems = pendingItems.slice(0, currentQuota.remaining);\n      const overflowItems = pendingItems.slice(currentQuota.remaining);\n      let successCount = 0;\n      for (const item of immediateItems) {\n        if (await uploadOne(item.id, true)) successCount += 1;\n      }\n",
    "      const immediateItems = pendingItems.slice(0, currentQuota.remaining);\n      const overflowItems = pendingItems.slice(currentQuota.remaining);\n      const dailyImages: Array<{ file_name: string; remote_url: string }> = [];\n      let successCount = 0;\n      for (const item of immediateItems) {\n        const result = await uploadOne(item.id, true);\n        if (result) {\n          successCount += 1;\n          dailyImages.push({ file_name: item.file.name, remote_url: result.asset.remote_url });\n        }\n      }\n",
)
replace_once(
    'src/App.tsx',
    "      await Promise.all([refreshAssets(), refreshCacheStats(), refreshProfiles(), refreshAccountStatus(accountName)]);\n      const summary = [`已立即上传 ${successCount} 张`];\n",
    "      await Promise.all([refreshAssets(), refreshCacheStats(), refreshProfiles(), refreshAccountStatus(accountName)]);\n      let dailyDocumentTitle = '';\n      let dailyDocumentError = '';\n      if (dailyImages.length > 0) {\n        try {\n          dailyDocumentTitle = (await appendImagesToDailyDocument(accountName, dailyImages))?.title || '';\n        } catch (error) {\n          dailyDocumentError = normalizeError(error);\n        }\n      }\n      const summary = [`已立即上传 ${successCount} 张`];\n",
)
replace_once(
    'src/App.tsx',
    "      showToast('success', summary.join('，'));\n",
    "      if (dailyDocumentTitle) summary.push(`已写入当天文档“${dailyDocumentTitle}”`);\n      if (dailyDocumentError) {\n        showToast('error', `${summary.join('，')}；当天文档同步失败：${dailyDocumentError}`);\n      } else {\n        showToast('success', summary.join('，'));\n      }\n",
)

# Scheduled batches also append once per account.
replace_once(
    'src/App.tsx',
    "        for (const item of accountItems.slice(0, accountQuota.remaining)) await uploadOne(item.id, true);\n        const overflow = accountItems.slice(accountQuota.remaining);\n",
    "        const dailyImages: Array<{ file_name: string; remote_url: string }> = [];\n        for (const item of accountItems.slice(0, accountQuota.remaining)) {\n          const result = await uploadOne(item.id, true);\n          if (result) dailyImages.push({ file_name: item.file.name, remote_url: result.asset.remote_url });\n        }\n        if (dailyImages.length > 0) {\n          try {\n            await appendImagesToDailyDocument(account, dailyImages);\n          } catch (error) {\n            showToast('error', `账号“${account}”图片已上传，但当天文档同步失败：${normalizeError(error)}`);\n          }\n        }\n        const overflow = accountItems.slice(accountQuota.remaining);\n",
)

# Library UI.
replace_once(
    'src/App.tsx',
    "              <div className=\"library-main\">\n",
    "              <div className={libraryViewMode === 'original' ? 'library-main original-ratio-view' : 'library-main square-view'}>\n",
)
replace_once(
    'src/App.tsx',
    "                  <div className=\"library-heading-controls\">\n                    <label className=\"search\">",
    "                  <div className=\"library-heading-controls\">\n                    <div className=\"library-view-switch\" role=\"group\" aria-label=\"图库显示方式\">\n                      <button className={libraryViewMode === 'original' ? 'active' : ''} onClick={() => { setLibraryViewMode('original'); localStorage.setItem('quepic-library-view', 'original'); }}><Images size={15} />原始比例</button>\n                      <button className={libraryViewMode === 'square' ? 'active' : ''} onClick={() => { setLibraryViewMode('square'); localStorage.setItem('quepic-library-view', 'square'); }}><Square size={15} />统一方格</button>\n                    </div>\n                    <label className=\"search\">",
)
replace_once(
    'src/App.tsx',
    "                          <button className=\"asset-select\" aria-label={checked ? '取消选择' : '选择图片'} onClick={(event) => { event.stopPropagation(); toggleAssetSelection(asset.id); }}>{checked ? <CheckSquare size={18} /> : <Square size={18} />}</button>\n                          <AssetPreview asset={asset} allowWordpressFallback={allowWordpressFallback} cacheEpoch={cacheEpoch} onCacheChanged={handlePreviewCached} />",
    "                          <button className=\"asset-select\" aria-label={checked ? '取消选择' : '选择图片'} onClick={(event) => { event.stopPropagation(); toggleAssetSelection(asset.id); }}>{checked ? <CheckSquare size={18} /> : <Square size={18} />}</button>\n                          <button className=\"asset-original-action\" title=\"原图显示\" aria-label={`查看 ${asset.file_name} 原图`} onClick={(event) => { event.stopPropagation(); setOriginalViewerAsset(asset); }}><Maximize2 size={16} /></button>\n                          <AssetPreview asset={asset} preserveAspectRatio={libraryViewMode === 'original'} allowWordpressFallback={allowWordpressFallback} cacheEpoch={cacheEpoch} onCacheChanged={handlePreviewCached} />",
)
replace_once(
    'src/App.tsx',
    "                      <button className=\"button primary\" onClick={() => void handleSaveCategory()}><Save size={16} />保存分类</button>\n                      <button className=\"button secondary\" onClick={() => void copyText(selected.remote_url)}><Copy size={16} />复制 URL</button>",
    "                      <button className=\"button primary\" onClick={() => void handleSaveCategory()}><Save size={16} />保存分类</button>\n                      <button className=\"button secondary\" onClick={() => setOriginalViewerAsset(selected)}><Maximize2 size={16} />原图显示</button>\n                      <button className=\"button secondary\" onClick={() => void copyText(selected.remote_url)}><Copy size={16} />复制 URL</button>",
)
replace_once('src/App.tsx', "<QueueItemRow key={item.id} item={item} onRetry={uploadOne}", "<QueueItemRow key={item.id} item={item} onRetry={retryUploadOne}")
replace_once(
    'src/App.tsx',
    "      {toast && <div className={toast.type === 'success' ? 'toast success' : 'toast error'}>",
    "      {originalViewerAsset && <OriginalImageViewer asset={originalViewerAsset} cacheEpoch={cacheEpoch} onClose={() => setOriginalViewerAsset(null)} onCacheChanged={handlePreviewCached} />}\n\n      {toast && <div className={toast.type === 'success' ? 'toast success' : 'toast error'}>",
)

# Rust: safe save dialog, no browser navigation.
replace_once('src-tauri/src/lib.rs', "use preview::CachedPreview;\n", "use preview::CachedPreview;\nuse serde::Serialize;\n")
replace_once('src-tauri/src/lib.rs', "use url::Url;\n", "use tauri_plugin_dialog::DialogExt;\nuse url::Url;\n")
replace_once(
    'src-tauri/src/lib.rs',
    "#[tauri::command]\nasync fn upload_image(\n",
    "#[derive(Debug, Serialize)]\nstruct SaveOriginalResult {\n    cancelled: bool,\n    path: Option<String>,\n}\n\n#[tauri::command]\nfn save_original_image(\n    app: AppHandle,\n    state: State<'_, AppState>,\n    asset_id: i64,\n) -> Result<SaveOriginalResult, String> {\n    let asset = database::find_by_id(&state.database_path, asset_id)?\n        .ok_or_else(|| \"图片记录不存在。\".to_string())?;\n    let source = asset\n        .original_path\n        .as_deref()\n        .filter(|path| Path::new(path).is_file())\n        .ok_or_else(|| \"原图尚未缓存，请先打开“原图显示”，等待加载完成后再保存。\".to_string())?;\n    let file_name = sanitize_file_name(&asset.file_name)?;\n    let extension = Path::new(source)\n        .extension()\n        .and_then(|value| value.to_str())\n        .map(str::to_string);\n    let dialog = app\n        .dialog()\n        .file()\n        .set_title(\"保存 QuePic 原图\")\n        .set_file_name(&file_name);\n    let selected = if let Some(extension) = extension.as_deref() {\n        dialog.add_filter(\"图片\", &[extension]).blocking_save_file()\n    } else {\n        dialog.blocking_save_file()\n    };\n    let Some(selected) = selected else {\n        return Ok(SaveOriginalResult { cancelled: true, path: None });\n    };\n    let mut target = selected\n        .into_path()\n        .map_err(|error| format!(\"无法读取原图保存路径：{error}\"))?;\n    if target.extension().is_none() {\n        if let Some(extension) = extension {\n            target.set_extension(extension);\n        }\n    }\n    if Path::new(source) != target {\n        fs::copy(source, &target)\n            .map_err(|error| format!(\"保存原图失败：{error}\"))?;\n    }\n    Ok(SaveOriginalResult {\n        cancelled: false,\n        path: Some(target.to_string_lossy().into_owned()),\n    })\n}\n\n#[tauri::command]\nasync fn upload_image(\n",
)
replace_once(
    'src-tauri/src/lib.rs',
    "            ensure_preview,\n            upload_image,\n",
    "            ensure_preview,\n            save_original_image,\n            upload_image,\n",
)

# Cleanup the temporary applicator and restore CI before committing.
for temporary in [ROOT / '.github/apply-original-viewer.py', ROOT / '.github/apply-original-viewer.trigger']:
    if temporary.exists():
        temporary.unlink()

ci = ROOT / '.github/workflows/ci.yml'
ci_text = ci.read_text(encoding='utf-8')
start = ci_text.find('  apply_original_viewer:\n')
end_marker = '  frontend:\n'
if start >= 0:
    end = ci_text.find(end_marker, start)
    if end < 0:
        raise SystemExit('无法恢复 CI：未找到 frontend job')
    ci_text = ci_text[:start] + ci_text[end:]
ci_text = ci_text.replace('permissions:\n  contents: write\n', 'permissions:\n  contents: read\n', 1)
ci.write_text(ci_text, encoding='utf-8')
