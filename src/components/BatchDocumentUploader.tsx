import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileImage,
  FolderUp,
  Gauge,
  LoaderCircle,
} from 'lucide-react';
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import {
  createYuqueDocument,
  getCredentialStatus,
  getOpenApiTokenStatus,
  getUploadQuotaStatus,
  uploadImage,
} from '../lib/tauri';
import type { UploadQuotaStatus, YuqueDocumentResult } from '../types';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSION = /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;
const FILE_NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

type UploadStage = 'idle' | 'uploading' | 'creating';

interface BatchDocumentUploaderProps {
  accountName: string;
  onUploaded?: () => void;
}

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
  return firstPath.split('/')[0]?.trim() || '图片文档';
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
  return '操作失败，请检查语雀登录状态、Token、知识库 ID 和上传额度。';
}

function formatResetTime(value: string | null): string {
  if (!value) return '暂无限制';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function BatchDocumentUploader({ accountName, onUploaded }: BatchDocumentUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState('');
  const [bookId, setBookId] = useState(() => localStorage.getItem('quepic-book-id') || '');
  const [credentialReady, setCredentialReady] = useState(false);
  const [tokenReady, setTokenReady] = useState(false);
  const [quota, setQuota] = useState<UploadQuotaStatus | null>(null);
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
    let disposed = false;
    const refresh = async () => {
      try {
        const [credential, token, nextQuota] = await Promise.all([
          getCredentialStatus(accountName),
          getOpenApiTokenStatus(accountName),
          getUploadQuotaStatus(accountName),
        ]);
        if (disposed) return;
        setCredentialReady(credential.configured);
        setTokenReady(token.configured);
        setQuota(nextQuota);
      } catch (statusError) {
        if (!disposed) setError(normalizeError(statusError));
      }
    };
    void refresh();
    return () => {
      disposed = true;
    };
  }, [accountName]);

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
      setError('所选文件夹中没有可上传的图片。支持常见图片格式，单张不能超过 50 MB。');
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
  };

  const startUpload = async () => {
    const parsedBookId = Number(bookId.trim());
    if (files.length === 0) return setError('请先选择一个包含图片的文件夹。');
    if (!credentialReady) return setError('当前账号尚未保存语雀登录会话，请先前往设置完成登录。');
    if (!tokenReady) return setError('当前账号尚未保存 OpenAPI Token，请先前往设置保存。');
    if (!Number.isSafeInteger(parsedBookId) || parsedBookId <= 0) {
      return setError('知识库 ID 必须是正整数。');
    }
    if (quota && quota.remaining <= 0) {
      return setError(`当前小时上传额度已用完，请在 ${formatResetTime(quota.reset_at)} 后继续。`);
    }

    setError('');
    setResult(null);
    localStorage.setItem('quepic-book-id', String(parsedBookId));

    try {
      const uploaded: Array<{ file: File; url: string }> = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setProgress({
          stage: 'uploading',
          current: index + 1,
          total: files.length,
          fileName: pathInsideFolder(file),
        });
        const upload = await uploadImage(file, accountName, null, null, folderName);
        uploaded.push({ file, url: upload.asset.remote_url });
        setQuota(await getUploadQuotaStatus(accountName));
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
        account_name: accountName,
        book_id: parsedBookId,
        title: folderName,
        body: markdown,
      });
      setResult(document);
      onUploaded?.();
    } catch (operationError) {
      setError(normalizeError(operationError));
    } finally {
      setProgress({ stage: 'idle', current: 0, total: 0, fileName: '' });
    }
  };

  return (
    <div className="batch-doc-page">
      <input
        ref={inputRef}
        className="batch-doc-hidden-input"
        type="file"
        accept="image/*"
        multiple
        onChange={handleFolderChange}
      />

      <div className="panel batch-doc-panel">
        <div className="panel-heading">
          <div>
            <span>FOLDER TO YUQUE</span>
            <h2>文件夹转语雀文档</h2>
            <p>文件夹名作为文档名，图片按完整相对路径自然排序并依次写入。</p>
          </div>
          <BookOpen size={22} />
        </div>

        <div className="batch-doc-status-grid">
          <div className={credentialReady ? 'status-card ready' : 'status-card'}>
            <strong>语雀登录</strong><small>{credentialReady ? '已就绪' : '未配置'}</small>
          </div>
          <div className={tokenReady ? 'status-card ready' : 'status-card'}>
            <strong>OpenAPI Token</strong><small>{tokenReady ? '已安全保存' : '前往设置保存'}</small>
          </div>
          <div className="status-card">
            <strong>小时额度</strong>
            <small>{quota ? `${quota.remaining}/${quota.limit} 可用` : '正在读取'}</small>
          </div>
        </div>

        <label className="field batch-doc-book-field">
          <span>目标知识库 ID</span>
          <input
            value={bookId}
            disabled={running}
            inputMode="numeric"
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setBookId(event.target.value)}
            placeholder="例如 123456"
          />
          <small>OpenAPI Token 与当前账号绑定保存；知识库 ID 仅保存在本机应用设置中。</small>
        </label>

        <div className="batch-doc-folder-card">
          <div className="batch-doc-folder-summary">
            <div>
              <FolderUp size={22} />
              <div>
                <strong>{folderName || '尚未选择文件夹'}</strong>
                <small>{files.length > 0 ? `${files.length} 张图片 · 自动分类为“${folderName}”` : '选择后显示排序结果'}</small>
              </div>
            </div>
            <div className="batch-doc-folder-actions">
              {files.length > 0 && <button type="button" disabled={running} onClick={resetSelection}>清空</button>}
              <button type="button" disabled={running} onClick={selectFolder}>
                {files.length > 0 ? '重新选择' : '选择文件夹'}
              </button>
            </div>
          </div>

          {orderedNames.length > 0 && (
            <ol className="batch-doc-file-list">
              {orderedNames.map((name, index) => (
                <li key={`${name}-${index}`}>
                  <span>{index + 1}</span><FileImage size={15} /><b title={name}>{name}</b>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="quota-note">
          <Gauge size={18} />
          <div>
            <strong>安全限速已启用</strong>
            <small>远程上传最多按 140 次/小时计算，并至少间隔 25 秒；重复图片复用历史链接，不消耗上传额度。</small>
          </div>
        </div>

        {running && (
          <div className="batch-doc-progress" aria-live="polite">
            <LoaderCircle className="spin" size={18} />
            <div>
              <strong>{progress.stage === 'uploading' ? `正在处理 ${progress.current}/${progress.total}` : '正在创建语雀文档'}</strong>
              <small>{progress.fileName}</small>
            </div>
          </div>
        )}

        {error && <div className="batch-doc-message batch-doc-message-error" role="alert"><AlertTriangle size={18} /><span>{error}</span></div>}
        {result && (
          <div className="batch-doc-message batch-doc-message-success">
            <CheckCircle2 size={18} />
            <div>
              <strong>文档“{result.title}”已创建</strong>
              <small>共写入 {files.length} 张图片，图片已归类到“{folderName}”。</small>
              {result.url && <a href={result.url} target="_blank" rel="noreferrer">打开语雀文档</a>}
            </div>
          </div>
        )}

        <div className="batch-doc-footer">
          <button
            className="button primary"
            type="button"
            disabled={running || files.length === 0 || !credentialReady || !tokenReady}
            onClick={() => void startUpload()}
          >
            {running ? <LoaderCircle className="spin" size={17} /> : <FolderUp size={17} />}
            上传并创建文档
          </button>
          <small>新建文档不会自动加入语雀知识库目录。</small>
        </div>
      </div>
    </div>
  );
}
