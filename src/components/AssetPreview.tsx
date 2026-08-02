import { convertFileSrc } from '@tauri-apps/api/core';
import { ImageOff, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import { isMaintenanceActive } from '../lib/maintenance';
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
  const [naturalRatio, setNaturalRatio] = useState<string | null>(null);

  const storedPath = useMemo(() => {
    if (preferOriginal) return asset.original_path || asset.thumbnail_path;
    return asset.thumbnail_path || asset.original_path;
  }, [asset.original_path, asset.thumbnail_path, preferOriginal]);
  const recordedRatio = asset.width && asset.height ? `${asset.width} / ${asset.height}` : null;
  const aspectRatio = preserveAspectRatio ? recordedRatio || naturalRatio || undefined : undefined;

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
    setNaturalRatio(null);
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

      if (isMaintenanceActive()) {
        commit(() => setState('idle'));
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
          setState(isMaintenanceActive() ? 'idle' : 'failed');
        });
      }
    };

    void load();
    return () => {
      disposed = true;
    };
  }, [allowWordpressFallback, asset.id, onCacheChanged, preferOriginal, retryNonce, storedPath, visible]);

  const retryAfterImageError = () => {
    if (isMaintenanceActive()) return;
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
      {src && (
        <img
          src={src}
          alt={asset.file_name}
          onLoad={(event) => {
            if (!preserveAspectRatio || recordedRatio) return;
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              setNaturalRatio(`${image.naturalWidth} / ${image.naturalHeight}`);
            }
          }}
          onError={retryAfterImageError}
        />
      )}
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
