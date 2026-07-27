from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"未找到待替换内容: {path}\n{old[:180]}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


app = Path("src/App.tsx")
text = app.read_text(encoding="utf-8")
text = text.replace(
    "import { useCallback, useEffect, useMemo, useRef, useState } from 'react';",
    "import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';",
    1,
)

anchor = "const EMPTY_CACHE_STATS: CacheStats = { asset_count: 0, cached_count: 0, cache_bytes: 0 };\n"
helpers = r'''
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const QUEUE_PREVIEW_EDGE = 160;
const QUEUE_PREVIEW_CONCURRENCY = 3;

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
        {item.status === 'success' && <b className="success-text"><Check size={13} />{item.result?.deduplicated ? '复用历史链接并补建缓存' : '上传并缓存成功'}</b>}
      </div>
      <div className="item-actions">
        {item.status === 'uploading' && <LoaderCircle className="spin" size={18} />}
        {item.status === 'failed' && <button onClick={() => onRetry(item.id)}>重试</button>}
        {item.status === 'success' && item.result && <button title="复制 Markdown" onClick={() => onCopy(`![${item.file.name}](${item.result.asset.remote_url})`)}><Copy size={15} /></button>}
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
'''
if helpers.strip() not in text:
    if anchor not in text:
        raise SystemExit("未找到 App 常量插入点")
    text = text.replace(anchor, anchor + helpers, 1)

old_add = r'''  const addFiles = async (files: File[]) => {
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
  };'''
new_add = r'''  const addFiles = async (files: File[]) => {
    const accepted = files.filter((file) => file.type.startsWith('image/') && file.size <= MAX_UPLOAD_BYTES);
    if (accepted.length !== files.length) {
      showToast('error', '已忽略非图片文件或超过 50 MB 的图片。');
    }
    const items = await mapWithConcurrency(accepted, QUEUE_PREVIEW_CONCURRENCY, createQueueItem);
    setQueue((current) => [...items, ...current]);
  };'''
if old_add not in text:
    raise SystemExit("未找到 addFiles 原实现")
text = text.replace(old_add, new_add, 1)

text = text.replace(
    "  const uploadOne = async (id: string) => {",
    "  const uploadOne = useCallback(async (id: string) => {",
    1,
)
text = text.replace(
    "    }\n  };\n\n  const uploadAll = async () => {",
    "    }\n  }, [accountName, refreshAssets, refreshCacheStats]);\n\n  const uploadAll = async () => {",
    1,
)
text = text.replace(
    "  const copyText = async (value: string) => {\n    await navigator.clipboard.writeText(value);\n    showToast('success', '已复制到剪贴板');\n  };",
    "  const copyText = useCallback(async (value: string) => {\n    await navigator.clipboard.writeText(value);\n    showToast('success', '已复制到剪贴板');\n  }, [showToast]);",
    1,
)
text = text.replace(
    "  const removeQueueItem = (id: string) => {",
    "  const removeQueueItem = useCallback((id: string) => {",
    1,
)
text = text.replace(
    "    });\n  };\n\n  const handleDeleteAsset",
    "    });\n  }, []);\n\n  const handleDeleteAsset",
    1,
)

old_rows = r'''                    {queue.map((item) => (
                      <article className="queue-item" key={item.id}>
                        <img src={item.previewUrl} alt="" />
                        <div><strong>{item.file.name}</strong><small>{formatBytes(item.file.size)}{item.width && item.height ? ` · ${item.width} × ${item.height}` : ''}</small>{item.status === 'failed' && <b className="error-text">{item.error}</b>}{item.status === 'success' && <b className="success-text"><Check size={13} />{item.result?.deduplicated ? '复用历史链接并补建缓存' : '上传并缓存成功'}</b>}</div>
                        <div className="item-actions">{item.status === 'uploading' && <LoaderCircle className="spin" size={18} />}{item.status === 'failed' && <button onClick={() => void uploadOne(item.id)}>重试</button>}{item.status === 'success' && item.result && <button title="复制 Markdown" onClick={() => void copyText(`![${item.file.name}](${item.result?.asset.remote_url})`)}><Copy size={15} /></button>}<button title="移除" onClick={() => removeQueueItem(item.id)}><X size={15} /></button></div>
                      </article>
                    ))}'''
new_rows = r'''                    {queue.map((item) => (
                      <QueueItemRow
                        key={item.id}
                        item={item}
                        onRetry={uploadOne}
                        onCopy={copyText}
                        onRemove={removeQueueItem}
                      />
                    ))}'''
if old_rows not in text:
    raise SystemExit("未找到上传队列行渲染")
text = text.replace(old_rows, new_rows, 1)
text = text.replace("<span>单张 25 MB</span>", "<span>单张 50 MB</span>", 1)
app.write_text(text, encoding="utf-8")

replace_once(
    "src/styles.css",
    ".queue-list { margin-top: 18px; display: grid; gap: 9px; max-height: 430px; overflow: auto; padding-right: 4px; }",
    ".queue-list { margin-top: 18px; display: grid; gap: 9px; max-height: 430px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding-right: 4px; }",
)
replace_once(
    "src/styles.css",
    ".queue-item { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 11px; align-items: center; padding: 9px; border: 1px solid var(--border); border-radius: 14px; background: rgba(255, 255, 255, .9); transition: .16s ease; }",
    ".queue-item { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 11px; align-items: center; min-height: 76px; padding: 9px; border: 1px solid var(--border); border-radius: 14px; background: rgba(255, 255, 255, .9); content-visibility: auto; contain: layout paint style; contain-intrinsic-size: auto 76px; transition: border-color .16s ease, background-color .16s ease; }",
)
replace_once(
    "src/styles.css",
    ".queue-item > img { width: 56px; height: 56px; object-fit: cover; border-radius: 10px; background: #eef1f6; }",
    ".queue-item > img { width: 56px; height: 56px; object-fit: cover; contain: paint; border-radius: 10px; background: #eef1f6; }",
)

replace_once(
    "src-tauri/src/lib.rs",
    "const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;",
    "const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;",
)
replace_once(
    "src-tauri/src/lib.rs",
    "return Err(\"图片超过 25 MB 限制。\".into());",
    "return Err(\"图片超过 50 MB 限制。\".into());",
)
replace_once(
    "src-tauri/src/yuque.rs",
    "const MAX_IMAGE_DOWNLOAD_BYTES: usize = 30 * 1024 * 1024;",
    "const MAX_IMAGE_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;",
)
yuque = Path("src-tauri/src/yuque.rs")
yuque.write_text(
    yuque.read_text(encoding="utf-8").replace("超过 30 MB 缓存限制", "超过 50 MB 缓存限制"),
    encoding="utf-8",
)
