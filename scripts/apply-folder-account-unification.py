from pathlib import Path
import re

ROOT = Path('.')


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding='utf-8')


def replace_once(path: str, old: str, new: str, label: str) -> None:
    text = read(path)
    if old not in text:
        raise SystemExit(f'{label}: marker not found in {path}')
    write(path, text.replace(old, new, 1))


def replace_regex(path: str, pattern: str, replacement: str, label: str) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{label}: expected one match in {path}, got {count}')
    write(path, updated)


routing = r'''import type { AccountProfile } from '../types';

export const NO_TOKEN_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const TOKEN_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function uploadLimitForProfile(profile: AccountProfile): number {
  return profile.token_configured ? TOKEN_MAX_UPLOAD_BYTES : NO_TOKEN_MAX_UPLOAD_BYTES;
}

export function prioritizeUploadProfiles(
  profiles: AccountProfile[],
  primaryAccountName: string,
  failoverEnabled: boolean,
  fileSize: number,
): AccountProfile[] {
  const primary = profiles.find((profile) => profile.account_name === primaryAccountName);
  if (!primary) return [];
  if (!failoverEnabled || fileSize > NO_TOKEN_MAX_UPLOAD_BYTES) return [primary];

  const children = profiles.filter(
    (profile) => profile.account_name !== primaryAccountName && profile.credential_configured,
  );
  return [...children, primary];
}

export function nextHourlyResetTimestamp(now = Date.now()): number {
  const hour = 60 * 60 * 1000;
  return Math.floor(now / hour) * hour + hour + 1_000;
}
'''
write('src/lib/uploadRouting.ts', routing)

batch = r'''import {
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
'''
write('src/components/BatchDocumentUploader.tsx', batch)

# Secret reveal commands.
replace_once(
    'src-tauri/src/lib.rs',
    '''#[tauri::command]\nfn clear_cookie(account_name: String) -> Result<(), String> {''',
    '''#[tauri::command]\nfn reveal_cookie(account_name: String) -> Result<String, String> {\n    let account_name = normalize_account_name(&account_name)?;\n    credentials::load(&account_name)\n}\n\n#[tauri::command]\nfn clear_cookie(account_name: String) -> Result<(), String> {''',
    'insert reveal cookie command',
)
replace_once(
    'src-tauri/src/lib.rs',
    '''            credential_status,\n            clear_cookie,''',
    '''            credential_status,\n            reveal_cookie,\n            clear_cookie,''',
    'register reveal cookie command',
)
replace_once(
    'src-tauri/src/openapi_token.rs',
    '''#[tauri::command]\npub fn clear_openapi_token(account_name: String) -> Result<(), String> {''',
    '''#[tauri::command]\npub fn reveal_openapi_token(account_name: String) -> Result<String, String> {\n    load(&account_name)\n}\n\n#[tauri::command]\npub fn clear_openapi_token(account_name: String) -> Result<(), String> {''',
    'insert reveal token command',
)
replace_once(
    'src-tauri/src/lib.rs',
    '''            openapi_token::openapi_token_status,\n            openapi_token::clear_openapi_token,''',
    '''            openapi_token::openapi_token_status,\n            openapi_token::reveal_openapi_token,\n            openapi_token::clear_openapi_token,''',
    'register reveal token command',
)

# Frontend command wrappers and master-context fallback.
replace_once(
    'src/lib/tauri.ts',
    '''export async function getCredentialStatus(accountName: string): Promise<CredentialStatus> {\n  return invoke<CredentialStatus>('credential_status', { accountName });\n}\n''',
    '''export async function getCredentialStatus(accountName: string): Promise<CredentialStatus> {\n  return invoke<CredentialStatus>('credential_status', { accountName });\n}\n\nexport async function getCookieValue(accountName: string): Promise<string> {\n  return invoke<string>('reveal_cookie', { accountName });\n}\n''',
    'add cookie reveal wrapper',
)
replace_once(
    'src/lib/tauri.ts',
    '''export async function getOpenApiTokenStatus(accountName: string): Promise<SecretStatus> {\n  return invoke<SecretStatus>('openapi_token_status', { accountName });\n}\n''',
    '''export async function getOpenApiTokenStatus(accountName: string): Promise<SecretStatus> {\n  return invoke<SecretStatus>('openapi_token_status', { accountName });\n}\n\nexport async function getOpenApiTokenValue(accountName: string): Promise<string> {\n  return invoke<string>('reveal_openapi_token', { accountName });\n}\n''',
    'add token reveal wrapper',
)
replace_once(
    'src/lib/tauri.ts',
    '''  category: string,\n  tags: string[],\n): Promise<UploadResult> {\n  const context = getStoredUploadContext(accountName);\n  if (!context) {\n    throw new Error(\n      `账号“${accountName}”尚未绑定自己有权限的上传上下文文档；从账号可以不配置 Token，但必须先验证一个可访问的语雀文档 URL。`,\n    );\n  }''',
    '''  category: string,\n  tags: string[],\n  contextAccountName = accountName,\n): Promise<UploadResult> {\n  const context = getStoredUploadContext(accountName) || getStoredUploadContext(contextAccountName);\n  if (!context) {\n    throw new Error(\n      `主账号“${contextAccountName}”尚未准备上传上下文；请检查主账号 Token 和文档配置。`,\n    );\n  }''',
    'allow child account to reuse primary context',
)

# App imports and state.
replace_once(
    'src/App.tsx',
    '''import { BatchDocumentUploader } from './components/BatchDocumentUploader';\n''',
    '''import { BatchDocumentUploader } from './components/BatchDocumentUploader';\nimport { YuqueDocumentManager } from './components/YuqueDocumentManager';\n''',
    'import document manager in settings',
)
replace_once(
    'src/App.tsx',
    '''  getCredentialStatus,\n  getOpenApiTokenStatus,''',
    '''  getCredentialStatus,\n  getCookieValue,\n  getOpenApiTokenStatus,\n  getOpenApiTokenValue,''',
    'import secret reveal wrappers',
)
replace_once(
    'src/App.tsx',
    '''} from './lib/uploadQueueStore';\n''',
    '''} from './lib/uploadQueueStore';\nimport {\n  nextHourlyResetTimestamp,\n  prioritizeUploadProfiles,\n  uploadLimitForProfile,\n} from './lib/uploadRouting';\n''',
    'import shared upload routing',
)
replace_once(
    'src/App.tsx',
    '''  const [accountFailoverEnabled, setAccountFailoverEnabled] = useState(\n    () => localStorage.getItem(ACCOUNT_FAILOVER_STORAGE_KEY) !== 'false',\n  );''',
    '''  const [accountFailoverEnabled, setAccountFailoverEnabled] = useState(\n    () => localStorage.getItem(ACCOUNT_FAILOVER_STORAGE_KEY) !== 'false',\n  );\n  const [masterKnowledgeBaseUrl, setMasterKnowledgeBaseUrl] = useState(\n    () => localStorage.getItem('quepic-knowledge-base-url') || '',\n  );\n  const [masterDocumentUrl, setMasterDocumentUrl] = useState(\n    () => localStorage.getItem('quepic-document-url') || '',\n  );\n  const [revealedCookie, setRevealedCookie] = useState('');\n  const [revealedToken, setRevealedToken] = useState('');\n  const [secretBusy, setSecretBusy] = useState<'cookie' | 'token' | null>(null);''',
    'add unified settings state',
)
replace_once(
    'src/App.tsx',
    '''      setAccountName(nextAccount);\n      setAccountDraft(nextAccount);''',
    '''      setAccountName(nextAccount);\n      setAccountDraft(nextAccount);\n      setRevealedCookie('');\n      setRevealedToken('');''',
    'clear revealed secrets when switching account',
)
replace_once(
    'src/App.tsx',
    '''      await clearCookie(accountName);\n      await Promise.all([refreshAccountStatus(accountName), refreshProfiles()]);''',
    '''      await clearCookie(accountName);\n      setRevealedCookie('');\n      await Promise.all([refreshAccountStatus(accountName), refreshProfiles()]);''',
    'clear visible cookie after deletion',
)
replace_once(
    'src/App.tsx',
    '''      await saveOpenApiToken(account, tokenInput.trim());\n      setTokenInput('');''',
    '''      await saveOpenApiToken(account, tokenInput.trim());\n      setTokenInput('');\n      setRevealedToken('');''',
    'clear visible token after save',
)
replace_once(
    'src/App.tsx',
    '''      await clearOpenApiToken(accountName);\n      setTokenInput('');''',
    '''      await clearOpenApiToken(accountName);\n      setTokenInput('');\n      setRevealedToken('');''',
    'clear visible token after deletion',
)
replace_once(
    'src/App.tsx',
    '''  const handleSaveToken = async () => {''',
    '''  const toggleCookieVisibility = async () => {\n    if (revealedCookie) return setRevealedCookie('');\n    setSecretBusy('cookie');\n    try {\n      setRevealedCookie(await getCookieValue(accountName));\n    } catch (secretError) {\n      showToast('error', normalizeError(secretError));\n    } finally {\n      setSecretBusy(null);\n    }\n  };\n\n  const toggleTokenVisibility = async () => {\n    if (revealedToken) return setRevealedToken('');\n    setSecretBusy('token');\n    try {\n      setRevealedToken(await getOpenApiTokenValue(accountName));\n    } catch (secretError) {\n      showToast('error', normalizeError(secretError));\n    } finally {\n      setSecretBusy(null);\n    }\n  };\n\n  const handleSaveToken = async () => {''',
    'add secret visibility handlers',
)
replace_once(
    'src/App.tsx',
    '''  const fallbackProfiles = accountProfiles.filter(\n    (profile) => profile.account_name !== primaryAccountName\n      && profile.credential_configured\n      && Boolean(getStoredUploadContext(profile.account_name)),\n  );''',
    '''  const fallbackProfiles = accountProfiles.filter(\n    (profile) => profile.account_name !== primaryAccountName && profile.credential_configured,\n  );''',
    'children no longer require document context',
)

# Upload queue routing: small files use children first, large files use primary.
replace_once(
    'src/App.tsx',
    '''    uploadAccountName: string,\n    deferRefresh = false,''',
    '''    uploadAccountName: string,\n    contextAccountName: string,\n    deferRefresh = false,''',
    'add primary context to uploadOne',
)
replace_once(
    'src/App.tsx',
    '''        item.category,\n        item.tags || [],\n      );''',
    '''        item.category,\n        item.tags || [],\n        contextAccountName,\n      );''',
    'pass primary context to uploadImage',
)
new_routing = r'''  const resolveRoutingCandidates = useCallback(async (targetPrimary: string) => {
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

'''
replace_regex(
    'src/App.tsx',
    r"  const resolveRoutingCandidates = useCallback\(async \(targetPrimary: string\) => \{.*?\n  const retryUploadOne = useCallback",
    new_routing + '  const retryUploadOne = useCallback',
    'replace upload queue routing',
)

# Keep the folder task mounted while switching pages.
replace_once(
    'src/App.tsx',
    '''          {view === 'document' && (\n            <BatchDocumentUploader accountName={accountName} onUploaded={() => void Promise.all([refreshAssets(), refreshCacheStats(), refreshAccountStatus(), refreshProfiles()])} />\n          )}\n''',
    '''          <div style={{ display: view === 'document' ? 'block' : 'none' }}>\n            <BatchDocumentUploader\n              primaryAccountName={primaryAccountName}\n              accountFailoverEnabled={accountFailoverEnabled}\n              knowledgeBaseUrl={masterKnowledgeBaseUrl}\n              documentUrl={masterDocumentUrl}\n              onUploaded={() => void Promise.all([refreshAssets(), refreshCacheStats(), refreshAccountStatus(), refreshProfiles()])}\n            />\n          </div>\n''',
    'keep batch uploader mounted',
)

# Update copy and navigation language.
for old, new in [
    ("upload: { title: '上传图片', description: '主账号优先上传，额度用满后由已登录从账号自动接力。' }", "upload: { title: '上传图片', description: '小图优先使用子账号，大图由主账号上传，所有链接统一写入主账号文档。' }"),
    ('主账号优先 · 从账号接力', '小图子账号优先 · 大图主账号'),
    ('主账号优先上传', '开始智能上传'),
    ('主账号平时优先使用并负责当天文档；额度用满后，从账号按账号列表顺序接力。', '主账号负责文档与大图；小图优先使用子账号，所有账号按整点小时独立计数。'),
]:
    text = read('src/App.tsx')
    if old in text:
        write('src/App.tsx', text.replace(old, new))

# Unified settings page.
settings = r'''          {view === 'settings' && (
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
                    <div className="settings-section-heading"><div><strong>当前账号凭据：{accountName}</strong><small>敏感内容默认隐藏，仅在点击显示时从系统密钥库读取。</small></div><KeyRound size={18} /></div>
                    <div className="actions">
                      <button className="button primary" disabled={loginBusy} onClick={() => void handleOpenYuqueLogin()}>{loginBusy ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}登录语雀</button>
                      <button className="button secondary" disabled={loginBusy} onClick={() => void handleCaptureYuqueLogin()}><ShieldCheck size={17} />完成登录并保存</button>
                      <button className="button danger" disabled={!credentialReady} onClick={() => void handleClearCredential()}><Trash2 size={17} />清除 Cookie</button>
                    </div>
                    <div className="secret-display-row">
                      <label className="field"><span>Cookie</span><input readOnly type={revealedCookie ? 'text' : 'password'} value={revealedCookie || (credentialReady ? '已保存在系统密钥库' : '')} placeholder="尚未配置 Cookie" /></label>
                      <button className="button secondary compact" disabled={!credentialReady || secretBusy === 'cookie'} onClick={() => void toggleCookieVisibility()}>{secretBusy === 'cookie' ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}{revealedCookie ? '隐藏' : '显示'}</button>
                      <button className="button secondary compact" disabled={!revealedCookie} onClick={() => void copyText(revealedCookie)}><Copy size={15} />复制</button>
                    </div>
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
                        <div className="secret-display-row">
                          <label className="field"><span>当前 Token</span><input readOnly type={revealedToken ? 'text' : 'password'} value={revealedToken || (tokenReady ? '已保存在系统密钥库' : '')} placeholder="尚未配置 Token" /></label>
                          <button className="button secondary compact" disabled={!tokenReady || secretBusy === 'token'} onClick={() => void toggleTokenVisibility()}>{secretBusy === 'token' ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}{revealedToken ? '隐藏' : '显示'}</button>
                          <button className="button secondary compact" disabled={!revealedToken} onClick={() => void copyText(revealedToken)}><Copy size={15} />复制</button>
                        </div>
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
'''
replace_regex(
    'src/App.tsx',
    r"          \{view === 'settings' && \(\n.*?\n          \)\}\n        </section>",
    settings + '        </section>',
    'replace settings with unified panel',
)

# Remove duplicate local hourly helper now shared by both upload flows.
replace_regex(
    'src/App.tsx',
    r"\nfunction nextHourlyResetTimestamp\(now = Date\.now\(\)\): number \{.*?\n\}\n",
    '\n',
    'remove duplicate hourly helper',
)

# Styling for the persistent folder task and unified settings.
css_path = 'src/batch-document.css'
css = read(css_path)
css += r'''

/* Persistent folder task + unified settings */
.batch-doc-task-list li {
  grid-template-columns: 34px 20px minmax(0, 1fr) auto;
}

.batch-doc-task-list em {
  color: #8c8c8c;
  font-size: 12px;
  font-style: normal;
  white-space: nowrap;
}

.batch-doc-task-list .task-success em { color: #168f4d; }
.batch-doc-task-list .task-failed em { color: #cf1322; }
.batch-doc-task-list .task-uploading { background: #e6f4ff; }

.unified-settings-panel {
  display: grid;
  gap: 0;
}

.settings-section {
  display: grid;
  gap: 16px;
  padding: 22px 0;
  border-top: 1px solid #f0f0f0;
}

.settings-section:first-of-type {
  border-top: 0;
}

.settings-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.settings-section-heading > div {
  display: grid;
  gap: 4px;
}

.settings-section-heading small {
  color: var(--muted);
  line-height: 1.5;
}

.settings-section-heading.compact {
  align-items: center;
}

.credential-subsection {
  display: grid;
  gap: 14px;
  padding: 18px;
  border: 1px solid #f0f0f0;
  border-radius: 14px;
  background: #fafafa;
}

.secret-display-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: end;
  gap: 8px;
}

.secret-display-row .field {
  min-width: 0;
}

.settings-summary-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.settings-summary-grid > div {
  display: grid;
  align-content: start;
  gap: 14px;
  padding: 18px;
  border: 1px solid #f0f0f0;
  border-radius: 14px;
  background: #fafafa;
}

@media (max-width: 900px) {
  .secret-display-row,
  .settings-summary-grid {
    grid-template-columns: 1fr;
  }
}
'''
write(css_path, css)

print('Applied folder persistence, unified account settings, secret reveal and shared routing.')
