import { convertFileSrc } from '@tauri-apps/api/core';
import { ImageOff, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ensurePreview } from '../lib/tauri';
import type { AssetRecord } from '../types';

interface AssetPreviewProps {
  asset: AssetRecord;
  preferOriginal?: boolean;
  allowWordpressFallback: boolean;
  cacheEpoch: number;
  className?: string;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

export function AssetPreview({
  asset,
  preferOriginal = false,
  allowWordpressFallback,
  cacheEpoch,
  className = '',
}: AssetPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef(false);
  const [visible, setVisible] = useState(preferOriginal);
  const [state, setState] = useState<LoadState>('idle');
  const [src, setSrc] = useState<string | null>(null);
  const [source, setSource] = useState<string>(asset.preview_source || 'missing');

  const storedPath = useMemo(() => {
    if (preferOriginal) return asset.original_path || asset.thumbnail_path;
    return asset.thumbnail_path || asset.original_path;
  }, [asset.original_path, asset.thumbnail_path, preferOriginal]);

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
      { rootMargin: '260px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [preferOriginal]);

  useEffect(() => {
    retryRef.current = false;
    setSrc(null);
    setState('idle');
    setSource(asset.preview_source || 'missing');
  }, [asset.id, asset.preview_source, cacheEpoch, preferOriginal]);

  useEffect(() => {
    if (!visible || state !== 'idle') return;
    let cancelled = false;

    const load = async () => {
      if (storedPath) {
        setSrc(convertFileSrc(storedPath));
        setSource('local');
        setState('ready');
        return;
      }

      setState('loading');
      try {
        const preview = await ensurePreview(
          asset.id,
          preferOriginal,
          allowWordpressFallback,
        );
        if (cancelled) return;
        if (preview.local_path) setSrc(convertFileSrc(preview.local_path));
        else setSrc(preview.proxy_url);
        setSource(preview.source);
        setState(preview.local_path || preview.proxy_url ? 'ready' : 'failed');
      } catch {
        if (!cancelled) setState('failed');
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [allowWordpressFallback, asset.id, preferOriginal, state, storedPath, visible]);

  const retryAfterImageError = async () => {
    if (retryRef.current) {
      setState('failed');
      setSrc(null);
      return;
    }
    retryRef.current = true;
    setState('loading');
    try {
      const preview = await ensurePreview(
        asset.id,
        preferOriginal,
        allowWordpressFallback,
        true,
      );
      if (preview.local_path) setSrc(convertFileSrc(preview.local_path));
      else setSrc(preview.proxy_url);
      setSource(preview.source);
      setState(preview.local_path || preview.proxy_url ? 'ready' : 'failed');
    } catch {
      setSrc(null);
      setState('failed');
    }
  };

  return (
    <div ref={containerRef} className={`asset-preview ${className}`.trim()}>
      {src && <img src={src} alt={asset.file_name} onError={() => void retryAfterImageError()} />}
      {!src && state === 'loading' && <LoaderCircle className="spin preview-state-icon" size={24} />}
      {!src && state === 'failed' && <ImageOff className="preview-state-icon" size={24} />}
      {!src && state === 'idle' && <span className="preview-skeleton" />}
      {state === 'ready' && (
        <span className={`preview-source source-${source}`}>
          {source === 'local' ? '本地缓存' : source === 'wordpress_proxy' ? '兼容代理' : source}
        </span>
      )}
    </div>
  );
}
