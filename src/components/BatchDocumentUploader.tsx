import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileImage,
  FolderUp,
  Gauge,
  Link2,
  LoaderCircle,
  Users,
} from 'lucide-react';
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

import {
  ensureDailyImageDocument,
  getStoredUploadContext,
  getUploadQuotaStatus,
  listAccountProfiles,
  saveYuqueDocument,
  uploadImage,
} from '../lib/tauri';
import {
  nextHourlyResetTimestamp,
  prioritizeUploadProfiles,
  TOKEN_MAX_UPLOAD_BYTES,
  uploadLimitForProfile,
} from '../lib/uploadRouting';
import type { AccountProfile, UploadQuotaStatus, YuqueDocumentResult } from '../types';

const IMAGE_EXTENSION = /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;
const SAFE_YUQUE_SEGMENT = /^[a-zA-Z0-9._~-]+$/;
const FILE_NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

type UploadStage = 'idle' | 'preparing' | 'uploading' | 'waiting' | 'saving' | 'success';
type FileTaskStatus = 'waiting' | 'uploading' | 'success' | 'failed';

interface BatchDocumentUploaderProps {
  primaryAccountName: string;
  accountFailoverEnabled: boolean;
  knowledgeBaseUrl: string;
  documentUrl: string;
  onUploaded?: () => void;
}

interface ProgressState {
  stage: UploadStage;
  current: number;
  total: number;
  fileName: string;
  accountName: string;
  scheduledAt: number | null;
}

interface FileTaskState {
  status: FileTaskStatus;
  accountName?: string;
  error?: string;
}

interface UploadedImage {
  url: string;
  accountName: string;
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
  return '操作失败，请检查主账号配置、子账号 Cookie、网络连接和上传额度。';
}

function formatScheduleTime(value: number): string {
  return new Date(value).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function parseYuqueUrl(value: string, requireDocument: boolean): ParsedYuqueUrl {
  const raw = value.trim();
  if (!raw) throw new Error(requireDocument ? '目标文档尚未配置。' : '请先在设置中选择目标知识库。');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('设置中的语雀目标地址无效。');
  }
  if (parsed.protocol !== 'https:' || !['www.yuque.com', 'yuque.com'].includes(parsed.hostname)) {
    throw new Error('目标必须是 HTTPS 语雀地址。');
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || (requireDocument && segments.length < 3)) {
    throw new Error('设置中的语雀知识库或文档地址不完整。');
  }
  if (segments.slice(0, 3).some((segment) => !SAFE_YUQUE_SEGMENT.test(segment))) {
    throw new Error('语雀目标地址包含不支持的路径字符。');
  }
  return { namespace: `${segments[0]}/${segments[1]}`, documentSlug: segments[2] || null };
}

function waitUntil(timestamp: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(1_000, timestamp - Date.now())));
}

export function BatchDocumentUploader({
  primaryAccountName,
  accountFailoverEnabled,
  knowledgeBaseUrl,
  documentUrl,
  onUploaded,
}: BatchDocumentUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const uploadedRef = useRef(new Map<string, UploadedImage>());
  const [files, setFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState('');
  const [profiles, setProfiles] = useState<AccountProfile[]>([]);
  const [quotas, setQuotas] = useState<Record<string, UploadQuotaStatus>>({});
  const [fileStates, setFileStates] = useState<Record<string, FileTaskState>>({});
  const [progress, setProgress] = useState<ProgressState>({
    stage: 'idle',
    current: 0,
    total: 0,
    fileName: '',
    accountName: '',
    scheduledAt: null,
  });
  const [error, setError] = useState('');
  const [result, setResult] = useState<YuqueDocumentResult | null>(null);

  const running = ['preparing', 'uploading', 'waiting', 'saving'].includes(progress.stage);
  const primaryProfile = profiles.find((profile) => profile.account_name === primaryAccountName);
  const childProfiles = profiles.filter(
    (profile) => profile.account_name !== primaryAccountName && profile.credential_configured,
  );
  const totalRemaining = Object.values(quotas).reduce((sum, quota) => sum + quota.remaining, 0);
  const orderedNames = useMemo(() => files.map(pathInsideFolder), [files]);
  const completedCount = Object.values(fileStates).filter((item) => item.status === 'success').length;

  const parsedTarget = useMemo(() => {
    try {
      const repository = parseYuqueUrl(knowledgeBaseUrl, false);
      const document = documentUrl.trim() ? parseYuqueUrl(documentUrl, true) : null;
      if (document && document.namespace !== repository.namespace) {
        return { error: '设置中的目标文档与知识库不属于同一个知识库。', namespace: '', slug: null };
      }
      return { error: '', namespace: repository.namespace, slug: document?.documentSlug || null };
    } catch (targetError) {
      return { error: normalizeError(targetError), namespace: '', slug: null };
    }
  }, [documentUrl, knowledgeBaseUrl]);

  const refreshRoutingStatus = async () => {
    const nextProfiles = await listAccountProfiles();
    const eligible = nextProfiles.filter(
      (profile) => profile.account_name === primaryAccountName
        || (accountFailoverEnabled && profile.credential_configured),
    );
    const nextQuotas = await Promise.all(
      eligible.map(async (profile) => [profile.account_name, await getUploadQuotaStatus(profile.account_name)] as const),
    );
    setProfiles(nextProfiles);
    setQuotas(Object.fromEntries(nextQuotas));
    return { profiles: nextProfiles, quotas: new Map(nextQuotas) };
  };

  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
  }, []);

  useEffect(() => {
    void refreshRoutingStatus().catch((statusError) => setError(normalizeError(statusError)));
  }, [primaryAccountName, accountFailoverEnabled]);

  const selectFolder = () => inputRef.current?.click();

  const handleFolderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    const validImages = selected
      .filter((file) => isImage(file) && file.size > 0 && file.size <= TOKEN_MAX_UPLOAD_BYTES)
      .sort((left, right) => FILE_NAME_COLLATOR.compare(relativePath(left), relativePath(right)));

    uploadedRef.current.clear();
    setFiles(validImages);
    setFolderName(folderFromFiles(validImages));
    setFileStates(Object.fromEntries(validImages.map((file) => [relativePath(file), { status: 'waiting' }])));
    setProgress({ stage: 'idle', current: 0, total: validImages.length, fileName: '', accountName: '', scheduledAt: null });
    setResult(null);
    setError('');

    const ignoredCount = selected.length - validImages.length;
    if (validImages.length === 0) {
      setError('所选文件夹中没有可上传图片。支持常见图片格式，单张不能超过 50 MB。');
    } else if (ignoredCount > 0) {
      setError(`已忽略 ${ignoredCount} 个非图片、空文件或超过 50 MB 的文件。`);
    }
  };

  const resetSelection = () => {
    if (running) return;
    uploadedRef.current.clear();
    setFiles([]);
    setFolderName('');
    setFileStates({});
    setProgress({ stage: 'idle', current: 0, total: 0, fileName: '', accountName: '', scheduledAt: null });
    setError('');
    setResult(null);
  };

  const updateFileState = (file: File, next: FileTaskState) => {
    const key = relativePath(file);
    setFileStates((current) => ({ ...current, [key]: next }));
  };

  const startUpload = async () => {
    if (files.length === 0) return setError('请先选择一个包含图片的文件夹。');
    if (parsedTarget.error) return setError(parsedTarget.error);

    setError('');
    setResult(null);
    setProgress({ stage: 'preparing', current: completedCount, total: files.length, fileName: '正在准备主账号文档', accountName: primaryAccountName, scheduledAt: null });

    try {
      const dailyDocument = await ensureDailyImageDocument(primaryAccountName);
      if (!dailyDocument || !getStoredUploadContext(primaryAccountName)) {
        throw new Error('主账号无法创建上传上下文，请检查 Token 和登录状态。');
      }

      let snapshot = await refreshRoutingStatus();
      const primary = snapshot.profiles.find((profile) => profile.account_name === primaryAccountName);
      if (!primary?.credential_configured) throw new Error(`主账号“${primaryAccountName}”尚未登录语雀。`);
      if (!primary.token_configured) throw new Error(`主账号“${primaryAccountName}”必须配置 OpenAPI Token。`);

      const remainingByAccount = new Map(
        [...snapshot.quotas.entries()].map(([name, quota]) => [name, quota.remaining]),
      );
      let finished = uploadedRef.current.size;
      let failed = 0;

      for (const file of files) {
        const fileKey = relativePath(file);
        if (uploadedRef.current.has(fileKey)) continue;
        let uploaded = false;
        let lastError = '';

        while (!uploaded) {
          const orderedProfiles = prioritizeUploadProfiles(
            snapshot.profiles,
            primaryAccountName,
            accountFailoverEnabled,
            file.size,
          );
          let attempted = false;

          for (const profile of orderedProfiles) {
            const remaining = remainingByAccount.get(profile.account_name) ?? 0;
            if (remaining <= 0 || file.size > uploadLimitForProfile(profile)) continue;
            attempted = true;
            updateFileState(file, { status: 'uploading', accountName: profile.account_name });
            setProgress({
              stage: 'uploading',
              current: finished + 1,
              total: files.length,
              fileName: pathInsideFolder(file),
              accountName: profile.account_name,
              scheduledAt: null,
            });

            try {
              const upload = await uploadImage(
                file,
                profile.account_name,
                null,
                null,
                folderName,
                [],
                primaryAccountName,
              );
              if (!upload.deduplicated) remainingByAccount.set(profile.account_name, remaining - 1);
              uploadedRef.current.set(fileKey, {
                url: upload.asset.remote_url,
                accountName: profile.account_name,
              });
              updateFileState(file, { status: 'success', accountName: profile.account_name });
              finished += 1;
              uploaded = true;
              break;
            } catch (uploadError) {
              remainingByAccount.set(profile.account_name, remaining - 1);
              lastError = normalizeError(uploadError);
            }
          }

          if (uploaded) break;
          if (attempted) {
            updateFileState(file, { status: 'failed', error: lastError || '所有可用账号上传均失败。' });
            failed += 1;
            break;
          }

          const scheduledAt = nextHourlyResetTimestamp();
          setProgress({
            stage: 'waiting',
            current: finished,
            total: files.length,
            fileName: `等待 ${formatScheduleTime(scheduledAt)} 整点额度重置`,
            accountName: '',
            scheduledAt,
          });
          await waitUntil(scheduledAt);
          snapshot = await refreshRoutingStatus();
          remainingByAccount.clear();
          for (const [name, quota] of snapshot.quotas.entries()) {
            remainingByAccount.set(name, quota.remaining);
          }
        }
      }

      const uploaded = files
        .map((file) => ({ file, uploaded: uploadedRef.current.get(relativePath(file)) }))
        .filter((entry): entry is { file: File; uploaded: UploadedImage } => Boolean(entry.uploaded));
      if (uploaded.length === 0) throw new Error('本次没有图片上传成功，未创建语雀文档。');

      const markdown = uploaded
        .map(({ file, uploaded: item }) => `![${escapeMarkdownAlt(pathInsideFolder(file))}](${item.url})`)
        .join('\n\n');
      setProgress({ stage: 'saving', current: uploaded.length, total: files.length, fileName: documentUrl.trim() ? '正在更新主账号目标文档' : folderName, accountName: primaryAccountName, scheduledAt: null });
      const document = await saveYuqueDocument({
        account_name: primaryAccountName,
        knowledge_base_url: knowledgeBaseUrl.trim(),
        document_url: documentUrl.trim() || null,
        title: folderName,
        body: markdown,
        ensure_in_toc: true,
      });
      setResult(document);
      setProgress({ stage: 'success', current: uploaded.length, total: files.length, fileName: document.title, accountName: primaryAccountName, scheduledAt: null });
      if (failed > 0) setError(`${uploaded.length} 张已写入文档，${failed} 张上传失败，可再次点击开始重试失败项。`);
      onUploaded?.();
      await refreshRoutingStatus();
    } catch (operationError) {
      setError(normalizeError(operationError));
      setProgress((current) => ({ ...current, stage: 'idle', scheduledAt: null }));
    }
  };

  return (
    <div className="batch-doc-page">
      <input ref={inputRef} className="batch-doc-hidden-input" type="file" accept="image/*" multiple onChange={handleFolderChange} />

      <div className="panel batch-doc-panel">
        <div className="panel-heading">
          <div>
            <span>PERSISTENT FOLDER TASK</span>
            <h2>文件夹转语雀文档</h2>
            <p>任务常驻运行，切换到其他页面不会丢失文件、进度或结果；目标与账号规则统一从设置读取。</p>
          </div>
          <BookOpen size={22} />
        </div>

        <div className="batch-doc-status-grid">
          <div className={primaryProfile?.credential_configured && primaryProfile.token_configured ? 'status-card ready' : 'status-card'}>
            <strong>主账号</strong><small>{primaryAccountName} · {primaryProfile?.token_configured ? 'Token 已就绪' : '需要 Token'}</small>
          </div>
          <div className={childProfiles.length > 0 ? 'status-card ready' : 'status-card'}>
            <strong>子账号接力</strong><small>{accountFailoverEnabled ? `${childProfiles.length} 个已登录账号` : '已关闭'}</small>
          </div>
          <div className="status-card ready">
            <strong>整点总额度</strong><small>{totalRemaining} 次当前可用</small>
          </div>
          <div className={parsedTarget.error ? 'status-card' : 'status-card ready'}>
            <strong>主账号目标</strong><small>{parsedTarget.error || parsedTarget.namespace}</small>
          </div>
        </div>

        <div className={parsedTarget.error ? 'batch-doc-target-preview error' : 'batch-doc-target-preview'}>
          <Link2 size={17} />
          <div>
            <strong>{parsedTarget.error || `目标知识库：${parsedTarget.namespace}`}</strong>
            {!parsedTarget.error && <small>{parsedTarget.slug ? `上传完成后追加到文档：${parsedTarget.slug}` : `上传完成后创建文档：${folderName || '文件夹名称'}`}</small>}
          </div>
        </div>

        <div className="batch-doc-folder-card">
          <div className="batch-doc-folder-summary">
            <div>
              <FolderUp size={22} />
              <div>
                <strong>{folderName || '尚未选择文件夹'}</strong>
                <small>{files.length > 0 ? `${files.length} 张图片 · ${completedCount} 张已完成` : '小图优先子账号，大图由主账号上传'}</small>
              </div>
            </div>
            <div className="batch-doc-folder-actions">
              {files.length > 0 && <button type="button" disabled={running} onClick={resetSelection}>清空</button>}
              <button type="button" disabled={running} onClick={selectFolder}>{files.length > 0 ? '重新选择' : '选择文件夹'}</button>
            </div>
          </div>

          {orderedNames.length > 0 && (
            <ol className="batch-doc-file-list batch-doc-task-list">
              {files.map((file, index) => {
                const state = fileStates[relativePath(file)] || { status: 'waiting' as const };
                return (
                  <li key={`${relativePath(file)}-${index}`} className={`task-${state.status}`}>
                    <span>{index + 1}</span><FileImage size={15} /><b title={pathInsideFolder(file)}>{pathInsideFolder(file)}</b>
                    <em>{state.status === 'success' ? `${state.accountName} · 完成` : state.status === 'uploading' ? `${state.accountName} · 上传中` : state.status === 'failed' ? '失败' : '等待'}</em>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="quota-note">
          <Users size={18} />
          <div>
            <strong>统一主子账号路由</strong>
            <small>不超过 10 MB 的图片优先使用子账号 Cookie；超过 10 MB 的图片只使用带 Token 的主账号。所有链接最终由主账号写入目标文档，每个账号独立遵守整点小时额度。</small>
          </div>
        </div>

        {running && (
          <div className="batch-doc-progress" aria-live="polite">
            <LoaderCircle className="spin" size={18} />
            <div>
              <strong>{progress.stage === 'waiting' && progress.scheduledAt ? `等待下一整点 ${formatScheduleTime(progress.scheduledAt)}` : progress.stage === 'saving' ? '正在保存主账号文档' : `正在处理 ${progress.current}/${progress.total}`}</strong>
              <small>{progress.accountName ? `${progress.accountName} · ` : ''}{progress.fileName}</small>
            </div>
          </div>
        )}

        {error && <div className="batch-doc-message batch-doc-message-error" role="alert"><AlertTriangle size={18} /><span>{error}</span></div>}
        {result && (
          <div className="batch-doc-message batch-doc-message-success">
            <CheckCircle2 size={18} />
            <div><strong>主账号文档已保存：{result.title}</strong>{result.url && <a href={result.url} target="_blank" rel="noreferrer">打开语雀文档</a>}</div>
          </div>
        )}

        <div className="batch-doc-footer">
          <button className="button primary" disabled={running || files.length === 0 || Boolean(parsedTarget.error)} onClick={() => void startUpload()}>
            {running ? <LoaderCircle className="spin" size={17} /> : <Gauge size={17} />}
            {uploadedRef.current.size > 0 && uploadedRef.current.size < files.length ? '继续未完成任务' : '开始智能上传'}
          </button>
          <small>切换页面后任务仍继续运行；主账号或目标配置需要调整时请前往统一设置。</small>
        </div>
      </div>
    </div>
  );
}
