import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileImage,
  FolderUp,
  LoaderCircle,
  X,
} from 'lucide-react';
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

import { createYuqueDocument, getCredentialStatus, uploadImage } from '../lib/tauri';
import type { YuqueDocumentResult } from '../types';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSION = /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;
const FILE_NAME_COLLATOR = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
});

type UploadStage = 'idle' | 'uploading' | 'creating';

interface ProgressState {
  stage: UploadStage;
  current: number;
  total: number;
  fileName: string;
}

function relativePath(file: File): string {
  return file.webkitRelativePath || file.name;
}

function pathInsideFolder(file: File): string {
  const parts = relativePath(file).split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : file.name;
}

function folderFromFiles(files: File[]): string {
  const firstPath = files[0] ? relativePath(files[0]) : '';
  const folderName = firstPath.split('/')[0]?.trim();
  return folderName || '图片文档';
}

function isImage(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSION.test(file.name);
}

function escapeMarkdownAlt(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '操作失败，请检查语雀登录状态、Token 和知识库 ID。';
}

export function BatchDocumentUploader() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState('');
  const [accountName, setAccountName] = useState(
    () => localStorage.getItem('quepic-account') || 'default',
  );
  const [bookId, setBookId] = useState(() => localStorage.getItem('quepic-book-id') || '');
  const [token, setToken] = useState('');
  const [progress, setProgress] = useState<ProgressState>({
    stage: 'idle',
    current: 0,
    total: 0,
    fileName: '',
  });
  const [error, setError] = useState('');
  const [result, setResult] = useState<YuqueDocumentResult | null>(null);

  const running = progress.stage !== 'idle';
  const orderedNames = useMemo(() => files.map(pathInsideFolder), [files]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) setOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, running]);

  const selectFolder = () => inputRef.current?.click();

  const handleFolderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';

    const validImages = selected
      .filter((file) => isImage(file) && file.size > 0 && file.size <= MAX_UPLOAD_BYTES)
      .sort((left, right) => FILE_NAME_COLLATOR.compare(relativePath(left), relativePath(right)));

    setFiles(validImages);
    setFolderName(folderFromFiles(validImages));
    setResult(null);
    setError('');

    const ignoredCount = selected.length - validImages.length;
    if (validImages.length === 0) {
      setError('所选文件夹中没有可上传的图片。支持常见图片格式，单张图片不能超过 50 MB。');
    } else if (ignoredCount > 0) {
      setError(`已忽略 ${ignoredCount} 个非图片、空文件或超过 50 MB 的文件。`);
    }
  };

  const resetSelection = () => {
    if (running) return;
    setFiles([]);
    setFolderName('');
    setError('');
    setResult(null);
    setProgress({ stage: 'idle', current: 0, total: 0, fileName: '' });
  };

  const startUpload = async () => {
    const account = accountName.trim();
    const parsedBookId = Number(bookId.trim());
    const openApiToken = token.trim();

    if (files.length === 0) {
      setError('请先选择一个包含图片的文件夹。');
      return;
    }
    if (!account) {
      setError('上传账号名称不能为空。');
      return;
    }
    if (!Number.isSafeInteger(parsedBookId) || parsedBookId <= 0) {
      setError('知识库 ID 必须是正整数。');
      return;
    }
    if (!openApiToken) {
      setError('请填写语雀 OpenAPI Token。');
      return;
    }

    setError('');
    setResult(null);
    localStorage.setItem('quepic-account', account);
    localStorage.setItem('quepic-book-id', String(parsedBookId));

    try {
      const credential = await getCredentialStatus(account);
      if (!credential.configured) {
        throw new Error(`账号“${account}”尚未保存语雀登录会话，请先在 QuePic 设置中完成登录。`);
      }

      const uploaded: Array<{ file: File; url: string }> = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setProgress({
          stage: 'uploading',
          current: index + 1,
          total: files.length,
          fileName: pathInsideFolder(file),
        });
        const upload = await uploadImage(file, account, null, null);
        uploaded.push({ file, url: upload.asset.remote_url });
      }

      const markdown = uploaded
        .map(({ file, url }) => `![${escapeMarkdownAlt(pathInsideFolder(file))}](${url})`)
        .join('\n\n');

      setProgress({
        stage: 'creating',
        current: files.length,
        total: files.length,
        fileName: folderName,
      });
      const document = await createYuqueDocument({
        token: openApiToken,
        book_id: parsedBookId,
        title: folderName,
        body: markdown,
      });
      setResult(document);
    } catch (operationError) {
      setError(normalizeError(operationError));
    } finally {
      setProgress({ stage: 'idle', current: 0, total: 0, fileName: '' });
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        className="batch-doc-hidden-input"
        type="file"
        accept="image/*"
        multiple
        onChange={handleFolderChange}
      />
      <button
        className="batch-doc-launcher"
        type="button"
        title="将本地文件夹上传为语雀文档"
        onClick={() => setOpen(true)}
      >
        <FolderUp size={19} />
        <span>文件夹转文档</span>
      </button>

      {open && (
        <div className="batch-doc-backdrop" role="presentation">
          <section className="batch-doc-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-doc-title">
            <header className="batch-doc-header">
              <div>
                <span className="batch-doc-icon"><BookOpen size={20} /></span>
                <div>
                  <h2 id="batch-doc-title">文件夹批量上传到语雀文档</h2>
                  <p>文件夹名作为文档名，图片按自然文件名顺序依次写入。</p>
                </div>
              </div>
              <button type="button" aria-label="关闭" disabled={running} onClick={() => setOpen(false)}>
                <X size={19} />
              </button>
            </header>

            <div className="batch-doc-body">
              <div className="batch-doc-fields">
                <label>
                  <span>上传账号</span>
                  <input
                    value={accountName}
                    disabled={running}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setAccountName(event.target.value)}
                    placeholder="与设置页中的账号名称一致"
                  />
                </label>
                <label>
                  <span>知识库 ID</span>
                  <input
                    value={bookId}
                    disabled={running}
                    inputMode="numeric"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setBookId(event.target.value)}
                    placeholder="例如 123456"
                  />
                </label>
                <label className="batch-doc-token-field">
                  <span>OpenAPI Token</span>
                  <input
                    value={token}
                    disabled={running}
                    type="password"
                    autoComplete="off"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setToken(event.target.value)}
                    placeholder="仅用于本次创建文档，不会保存到本地"
                  />
                </label>
              </div>

              <div className="batch-doc-folder-card">
                <div className="batch-doc-folder-summary">
                  <div>
                    <FolderUp size={22} />
                    <div>
                      <strong>{folderName || '尚未选择文件夹'}</strong>
                      <small>{files.length > 0 ? `${files.length} 张图片` : '选择后将显示排序结果'}</small>
                    </div>
                  </div>
                  <div className="batch-doc-folder-actions">
                    {files.length > 0 && (
                      <button type="button" disabled={running} onClick={resetSelection}>清空</button>
                    )}
                    <button type="button" disabled={running} onClick={selectFolder}>
                      {files.length > 0 ? '重新选择' : '选择文件夹'}
                    </button>
                  </div>
                </div>

                {orderedNames.length > 0 && (
                  <ol className="batch-doc-file-list">
                    {orderedNames.map((name, index) => (
                      <li key={`${name}-${index}`}>
                        <span>{index + 1}</span>
                        <FileImage size={15} />
                        <b title={name}>{name}</b>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <p className="batch-doc-note">
                图片上传复用 QuePic 已保存的语雀登录会话；Token 只用于 OpenAPI 创建 Markdown 文档。
                文档创建后不会自动加入知识库目录。
              </p>

              {running && (
                <div className="batch-doc-progress" aria-live="polite">
                  <LoaderCircle className="spin" size={18} />
                  <div>
                    <strong>{progress.stage === 'uploading' ? `正在上传 ${progress.current}/${progress.total}` : '正在创建语雀文档'}</strong>
                    <small>{progress.fileName}</small>
                  </div>
                </div>
              )}

              {error && (
                <div className="batch-doc-message batch-doc-message-error" role="alert">
                  <AlertTriangle size={18} />
                  <span>{error}</span>
                </div>
              )}

              {result && (
                <div className="batch-doc-message batch-doc-message-success">
                  <CheckCircle2 size={18} />
                  <div>
                    <strong>文档“{result.title}”已创建</strong>
                    <small>共写入 {files.length} 张图片，顺序与上方列表一致。</small>
                    {result.url && <a href={result.url} target="_blank" rel="noreferrer">打开语雀文档</a>}
                  </div>
                </div>
              )}
            </div>

            <footer className="batch-doc-footer">
              <button type="button" disabled={running} onClick={() => setOpen(false)}>取消</button>
              <button
                className="batch-doc-primary"
                type="button"
                disabled={running || files.length === 0}
                onClick={() => void startUpload()}
              >
                {running ? <LoaderCircle className="spin" size={17} /> : <FolderUp size={17} />}
                上传并创建文档
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
