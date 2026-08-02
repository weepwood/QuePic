import { convertFileSrc } from '@tauri-apps/api/core';
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
