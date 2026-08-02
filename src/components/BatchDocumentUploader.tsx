import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileImage,
  FolderUp,
  Gauge,
  Link2,
  LoaderCircle,
} from 'lucide-react';
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import { YuqueDocumentManager } from './YuqueDocumentManager';
import {
  getCredentialStatus,
  getOpenApiTokenStatus,
    getUploadQuotaStatus,
    getStoredUploadContext,
    saveYuqueDocument,

  uploadImage,
} from '../lib/tauri';
import type { UploadQuotaStatus, YuqueDocumentResult } from '../types';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSION = /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;
const SAFE_YUQUE_SEGMENT = /^[a-zA-Z0-9._~-]+$/;
const FILE_NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

type UploadStage = 'idle' | 'uploading' | 'saving';

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

interface ParsedYuqueUrl {
  namespace: string;
  documentSlug: string | null;
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
  return '操作失败，请检查语雀登录状态、Token、目标 URL 和上传额度。';
}

function formatResetTime(value: string | null): string {
  if (!value) return '暂无限制';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function parseYuqueUrl(value: string, requireDocument: boolean): ParsedYuqueUrl {
  const raw = value.trim();
  if (!raw) throw new Error(requireDocument ? '目标文档 URL 不能为空。' : '目标知识库 URL 不能为空。');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('请输入完整的语雀网页 URL。');
  }
  if (parsed.protocol !== 'https:') throw new Error('语雀 URL 必须使用 HTTPS。');
  if (parsed.hostname !== 'www.yuque.com' && parsed.hostname !== 'yuque.com') {
    throw new Error('只支持 yuque.com 的知识库或文档 URL。');
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) throw new Error('语雀 URL 中缺少知识库路径，例如 /weepwood/index。');
  if (requireDocument && segments.length < 3) throw new Error('目标文档 URL 中缺少文档标识。');
  if (segments.slice(0, 3).some((segment) => !SAFE_YUQUE_SEGMENT.test(segment))) {
    throw new Error('语雀 URL 包含不支持的路径字符。');
  }

  return {
    namespace: `${segments[0]}/${segments[1]}`,
    documentSlug: segments[2] || null,
  };
}

export function BatchDocumentUploader({ accountName, onUploaded }: BatchDocumentUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState('');
  const [knowledgeBaseUrl, setKnowledgeBaseUrl] = useState(
    () => localStorage.getItem('quepic-knowledge-base-url') || '',
  );
  const [documentUrl, setDocumentUrl] = useState(
    () => localStorage.getItem('quepic-document-url') || '',
  );
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
    const uploadContextReady = Boolean(getStoredUploadContext(accountName));
    const orderedNames = useMemo(() => files.map(pathInsideFolder), [files]);

  const parsedTarget = useMemo(() => {
    try {
      const knowledgeBase = parseYuqueUrl(knowledgeBaseUrl, false);
      const document = documentUrl.trim() ? parseYuqueUrl(documentUrl, true) : null;
      if (document && document.namespace !== knowledgeBase.namespace) {
        return { error: '目标文档与目标知识库不属于同一个知识库。', namespace: '', slug: null };
      }
      return {
        error: '',
        namespace: knowledgeBase.namespace,
        slug: document?.documentSlug || null,
      };
    } catch (targetError) {
      return { error: normalizeError(targetError), namespace: '', slug: null };
    }
  }, [documentUrl, knowledgeBaseUrl]);

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
    if (files.length === 0) return setError('请先选择一个包含图片的文件夹。');
    if (!credentialReady) return setError('当前账号尚未保存语雀登录会话，请先前往设置完成登录。');
    if (!tokenReady) return setError('当前账号尚未保存 OpenAPI Token，请先前往设置保存。');
    if (!uploadContextReady) return setError('当前账号尚未配置上传上下文文档，请先前往设置验证一个语雀文档 URL。');
    if (quota && quota.remaining <= 0) {
      return setError(`当前小时上传额度已用完，请在 ${formatResetTime(quota.reset_at)} 后继续。`);
    }

    try {
      const knowledgeBase = parseYuqueUrl(knowledgeBaseUrl, false);
      const document = documentUrl.trim() ? parseYuqueUrl(documentUrl, true) : null;
      if (document && document.namespace !== knowledgeBase.namespace) {
        return setError('目标文档与目标知识库不属于同一个知识库。');
      }
    } catch (targetError) {
      return setError(normalizeError(targetError));
    }

    setError('');
    setResult(null);
    localStorage.setItem('quepic-knowledge-base-url', knowledgeBaseUrl.trim());
    if (documentUrl.trim()) localStorage.setItem('quepic-document-url', documentUrl.trim());
    else localStorage.removeItem('quepic-document-url');

    let uploadedCount = 0;
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
        uploadedCount += 1;
        setQuota(await getUploadQuotaStatus(accountName));
      }

      const markdown = uploaded
        .map(({ file, url }) => `![${escapeMarkdownAlt(pathInsideFolder(file))}](${url})`)
        .join('\n\n');

      setProgress({
        stage: 'saving',
        current: files.length,
        total: files.length,
        fileName: documentUrl.trim() ? '正在追加到目标文档' : folderName,
      });
      const document = await saveYuqueDocument({
        account_name: accountName,
        knowledge_base_url: knowledgeBaseUrl.trim(),
        document_url: documentUrl.trim() || null,
        title: folderName,
        body: markdown,
      });
      setResult(document);
    } catch (operationError) {
      setError(normalizeError(operationError));
    } finally {
      if (uploadedCount > 0) onUploaded?.();
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
            <p>粘贴语雀网页 URL 自动识别知识库；可以新建同名文档，也可以追加到现有文档。</p>
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
          <div className={uploadContextReady ? 'status-card ready' : 'status-card'}>
            <strong>上传上下文</strong><small>{uploadContextReady ? '账号文档已绑定' : '前往设置配置'}</small>
          </div>
          <div className="status-card">
            <strong>小时额度</strong>
            <small>{quota ? `${quota.remaining}/${quota.limit} 可用` : '正在读取'}</small>
          </div>
        </div>

        <YuqueDocumentManager
          accountName={accountName}
          tokenReady={tokenReady}
          disabled={running}
          knowledgeBaseUrl={knowledgeBaseUrl}
          documentUrl={documentUrl}
          onKnowledgeBaseUrlChange={setKnowledgeBaseUrl}
          onDocumentUrlChange={setDocumentUrl}
        />

        <div className="batch-doc-target-grid">
          <label className="field">
            <span>目标知识库 URL</span>
            <input
              value={knowledgeBaseUrl}
              disabled={running}
              type="url"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                setKnowledgeBaseUrl(event.target.value);
                setResult(null);
              }}
              placeholder="https://www.yuque.com/weepwood/index/dvezaglsvggap7g5"
            />
            <small>有 Token 时可在上方直接选择；这里保留手动 URL 作为高级回退。</small>
          </label>

          <label className="field">
            <span>目标文档 URL（可选）</span>
            <input
              value={documentUrl}
              disabled={running}
              type="url"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                setDocumentUrl(event.target.value);
                setResult(null);
              }}
              placeholder="留空则自动创建文件夹同名文档"
            />
            <small>填写后会保留原正文和标题，并把本次图片追加到文档末尾。</small>
          </label>
        </div>

        {(knowledgeBaseUrl.trim() || documentUrl.trim()) && (
          <div className={parsedTarget.error ? 'batch-doc-target-preview error' : 'batch-doc-target-preview'}>
            <Link2 size={17} />
            <div>
              <strong>{parsedTarget.error || `已识别知识库：${parsedTarget.namespace}`}</strong>
              {!parsedTarget.error && (
                <small>{parsedTarget.slug ? `将追加到文档：${parsedTarget.slug}` : `将新建文档：${folderName || '选择文件夹后确定名称'}`}</small>
              )}
            </div>
          </div>
        )}

        <div className="batch-doc-folder-card">
          <div className="batch-doc-folder-summary">
            <div>
              <FolderUp size={22} />
              <div>
                <strong>{folderName || '尚未选择文件夹'}</strong>
                <small>{files.length > 0 ? `${files.length} 张图片 · 自动分类为“${folderName}”并保存到图片库` : '选择后显示排序结果'}</small>
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
            <strong>图片库与安全限速</strong>
            <small>每张图片上传成功后立即写入当前账号图片库，并按文件夹名分类；重复图片复用历史链接，不消耗远程上传额度。</small>
          </div>
        </div>

        {running && (
          <div className="batch-doc-progress" aria-live="polite">
            <LoaderCircle className="spin" size={18} />
            <div>
              <strong>{progress.stage === 'uploading' ? `正在处理 ${progress.current}/${progress.total}` : documentUrl.trim() ? '正在更新语雀文档' : '正在创建语雀文档'}</strong>
              <small>{progress.fileName}</small>
            </div>
          </div>
        )}

        {error && <div className="batch-doc-message batch-doc-message-error" role="alert"><AlertTriangle size={18} /><span>{error}</span></div>}
        {result && (
          <div className="batch-doc-message batch-doc-message-success">
            <CheckCircle2 size={18} />
            <div>
              <strong>文档“{result.title}”已{result.created ? '创建' : '更新'}</strong>
              <small>共写入 {files.length} 张图片，图片已保存到“{folderName}”分类。</small>
              {result.url && <a href={result.url} target="_blank" rel="noreferrer">打开语雀文档</a>}
            </div>
          </div>
        )}

        <div className="batch-doc-footer">
          <button
            className="button primary"
            type="button"
            disabled={running || files.length === 0 || !credentialReady || !tokenReady || !uploadContextReady || Boolean(parsedTarget.error)}
            onClick={() => void startUpload()}
          >
            {running ? <LoaderCircle className="spin" size={17} /> : <FolderUp size={17} />}
            {documentUrl.trim() ? '上传并追加到文档' : '上传并创建文档'}
          </button>
          <small>未填写目标文档 URL 时，文档名称自动使用文件夹名称。</small>
        </div>
      </div>
    </div>
  );
}
