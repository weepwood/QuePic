import { invoke } from '@tauri-apps/api/core';
import type {
  AccountProfile,
  AssetRecord,
  CacheStats,
  CredentialStatus,
  DailyDocumentImage,
  PreviewResult,
  SaveOriginalResult,
  SaveYuqueDocumentInput,
  SecretStatus,
  UploadContextResult,
  UploadQuotaStatus,
  UploadResult,
  YuqueDocumentResult,
  YuqueDocumentSummary,
  YuqueRepositorySummary,
} from '../types';

const UPLOAD_CONTEXT_PREFIX = 'quepic-upload-context:';
const dailyDocumentRequests = new Map<string, Promise<YuqueDocumentResult | null>>();

function uploadContextKey(accountName: string): string {
  return `${UPLOAD_CONTEXT_PREFIX}${encodeURIComponent(accountName.trim())}`;
}

export function getStoredUploadContext(accountName: string): UploadContextResult | null {
  try {
    const normalizedAccount = accountName.trim();
    const raw = localStorage.getItem(uploadContextKey(normalizedAccount));
    if (!raw) return null;

    const context = JSON.parse(raw) as UploadContextResult;
    if (
      context.account_name !== normalizedAccount
      || !Number.isSafeInteger(context.attachable_id)
      || context.attachable_id <= 0
      || !context.document_url.startsWith('https://www.yuque.com/')
    ) {
      return null;
    }
    return context;
  } catch {
    return null;
  }
}

export function saveStoredUploadContext(context: UploadContextResult): void {
  localStorage.setItem(uploadContextKey(context.account_name), JSON.stringify(context));
}

export function clearStoredUploadContext(accountName: string): void {
  localStorage.removeItem(uploadContextKey(accountName));
}

export async function resolveUploadContext(
  accountName: string,
  documentUrl: string,
): Promise<UploadContextResult> {
  return invoke<UploadContextResult>('resolve_upload_context', {
    input: {
      account_name: accountName,
      document_url: documentUrl,
    },
  });
}

export async function listYuqueRepositories(accountName: string): Promise<YuqueRepositorySummary[]> {
  return invoke<YuqueRepositorySummary[]>('list_yuque_repositories', { accountName });
}

export async function ensureQuePicRepository(accountName: string): Promise<YuqueRepositorySummary> {
  return invoke<YuqueRepositorySummary>('ensure_quepic_repository', { accountName });
}

export async function listYuqueDocuments(
  accountName: string,
  namespace: string,
): Promise<YuqueDocumentSummary[]> {
  return invoke<YuqueDocumentSummary[]>('list_yuque_documents', {
    input: {
      account_name: accountName,
      namespace,
    },
  });
}

export async function deleteYuqueDocument(
  accountName: string,
  repositoryId: number,
  documentId: number,
): Promise<void> {
  return invoke('delete_yuque_document', {
    input: {
      account_name: accountName,
      repository_id: repositoryId,
      document_id: documentId,
    },
  });
}

function resolveImageMimeType(file: File): string {
  if (file.type.startsWith('image/')) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    webp: 'image/webp',
  };
  return extension ? mimeTypes[extension] || 'application/octet-stream' : 'application/octet-stream';
}

export async function openExternalUrl(url: string): Promise<void> {
  return invoke('open_external_url', { url });
}

export async function listAssets(): Promise<AssetRecord[]> {
  return invoke<AssetRecord[]>('list_assets');
}

export async function listLibraryFolders(): Promise<string[]> {
  return invoke<string[]>('list_library_folders');
}

export async function createLibraryFolder(name: string): Promise<string> {
  return invoke<string>('create_library_folder', { name });
}

export async function listAssetTags(): Promise<string[]> {
  return invoke<string[]>('list_asset_tags');
}

export async function updateAssetTags(id: number, tags: string[]): Promise<AssetRecord> {
  return invoke<AssetRecord>('update_asset_tags', { id, tags });
}

export async function deleteAsset(id: number): Promise<void> {
  return invoke('delete_asset', { id });
}

export async function updateAssetCategory(id: number, category: string): Promise<AssetRecord> {
  return invoke<AssetRecord>('update_asset_category', { id, category });
}

export async function listAccountProfiles(): Promise<AccountProfile[]> {
  return invoke<AccountProfile[]>('list_account_profiles');
}

export async function saveAccountProfile(accountName: string): Promise<AccountProfile> {
  return invoke<AccountProfile>('save_account_profile', { accountName });
}

export async function saveCookie(accountName: string, cookie: string): Promise<CredentialStatus> {
  return invoke<CredentialStatus>('save_cookie', { accountName, cookie });
}

export async function openYuqueLogin(): Promise<void> {
  return invoke('open_yuque_login');
}

export async function captureYuqueLogin(accountName: string): Promise<CredentialStatus> {
  return invoke<CredentialStatus>('capture_yuque_login', { accountName });
}

export async function clearCookie(accountName: string): Promise<void> {
  return invoke('clear_cookie', { accountName });
}

export async function getCredentialStatus(accountName: string): Promise<CredentialStatus> {
  return invoke<CredentialStatus>('credential_status', { accountName });
}

export async function saveOpenApiToken(accountName: string, token: string): Promise<SecretStatus> {
  return invoke<SecretStatus>('save_openapi_token', { accountName, token });
}

export async function clearOpenApiToken(accountName: string): Promise<void> {
  return invoke('clear_openapi_token', { accountName });
}

export async function getOpenApiTokenStatus(accountName: string): Promise<SecretStatus> {
  return invoke<SecretStatus>('openapi_token_status', { accountName });
}

export async function ensurePreview(
  assetId: number,
  preferOriginal: boolean,
  allowWordpressFallback: boolean,
  forceRefresh = false,
): Promise<PreviewResult> {
  return invoke<PreviewResult>('ensure_preview', {
    assetId,
    preferOriginal,
    allowWordpressFallback,
    forceRefresh,
  });
}

export async function saveOriginalImage(assetId: number): Promise<SaveOriginalResult> {
  return invoke<SaveOriginalResult>('save_original_image', { assetId });
}

export async function getCacheStats(): Promise<CacheStats> {
  return invoke<CacheStats>('cache_stats');
}

export async function clearPreviewCache(): Promise<CacheStats> {
  return invoke<CacheStats>('clear_preview_cache');
}

export async function getUploadQuotaStatus(accountName: string): Promise<UploadQuotaStatus> {
  return invoke<UploadQuotaStatus>('upload_quota_status', { accountName });
}

export async function uploadImage(
  file: File,
  accountName: string,
  width: number | null,
  height: number | null,
  category: string,
  tags: string[],
  contextAccountName = accountName,
): Promise<UploadResult> {
  const normalizedAccountName = accountName.trim();
  const normalizedContextAccountName = contextAccountName.trim();
  const usesDocumentContext = normalizedAccountName === normalizedContextAccountName;
  const context = usesDocumentContext
    ? getStoredUploadContext(normalizedContextAccountName)
    : null;
  if (usesDocumentContext && !context) {
    throw new Error(
      `主账号“${normalizedContextAccountName}”尚未准备上传上下文；请检查主账号 Token 和文档配置。`,
    );
  }

  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  return invoke<UploadResult>('upload_image', {
    input: {
      file_name: file.name,
      mime_type: resolveImageMimeType(file),
      bytes,
      width,
      height,
      account_name: normalizedAccountName,
      category,
      tags,
      attachable_id: context?.attachable_id ?? null,
      referer_url: context?.document_url ?? null,
    },
  });
}

export async function saveYuqueDocument(
  input: SaveYuqueDocumentInput,
): Promise<YuqueDocumentResult> {
  return invoke<YuqueDocumentResult>('create_yuque_document', { input });
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function escapeMarkdownAlt(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

async function resolveDailyImageDocument(
  accountName: string,
): Promise<YuqueDocumentResult | null> {
  const token = await getOpenApiTokenStatus(accountName);
  if (!token.configured) return null;

  const repository = await ensureQuePicRepository(accountName);
  const documents = await listYuqueDocuments(accountName, repository.namespace);
  const title = localDateKey();
  const existing = documents.find((document) => document.title.trim() === title);
  const document: YuqueDocumentResult = existing
    ? {
        id: existing.id,
        title: existing.title,
        slug: existing.slug,
        url: existing.url,
        created: false,
        namespace: repository.namespace,
      }
    : await saveYuqueDocument({
        account_name: accountName,
        knowledge_base_url: repository.url,
        document_url: null,
        title,
        body: '> QuePic 每日图片记录',
        ensure_in_toc: true,
      });

  if (!document.url) throw new Error('当天语雀文档没有可用 URL。');
  const context = await resolveUploadContext(accountName, document.url);
  saveStoredUploadContext(context);
  return document;
}

export function ensureDailyImageDocument(
  accountName: string,
): Promise<YuqueDocumentResult | null> {
  const key = accountName.trim();
  const current = dailyDocumentRequests.get(key);
  if (current) return current;

  const request = resolveDailyImageDocument(key).finally(() => {
    if (dailyDocumentRequests.get(key) === request) dailyDocumentRequests.delete(key);
  });
  dailyDocumentRequests.set(key, request);
  return request;
}

export async function appendImagesToDailyDocument(
  accountName: string,
  images: DailyDocumentImage[],
): Promise<YuqueDocumentResult | null> {
  if (images.length === 0) return null;
  const document = await ensureDailyImageDocument(accountName);
  if (!document?.url) return null;
  const repositoryUrl = new URL(document.url);
  const segments = repositoryUrl.pathname.split('/').filter(Boolean);
  if (segments.length < 2) throw new Error('无法从当天文档解析知识库 URL。');
  const knowledgeBaseUrl = `${repositoryUrl.origin}/${segments[0]}/${segments[1]}`;
  const time = new Date().toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const body = [
    `## ${time}`,
    '',
    ...images.flatMap((image) => [
      `<!-- quepic-image:${image.asset_id} -->`,
      `![${escapeMarkdownAlt(image.file_name)}](${image.remote_url})`,
      '',
    ]),
  ].join('\n').trim();

  return saveYuqueDocument({
    account_name: accountName,
    knowledge_base_url: knowledgeBaseUrl,
    document_url: document.url,
    title: document.title,
    body,
    ensure_in_toc: true,
  });
}
