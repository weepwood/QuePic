import { invoke } from '@tauri-apps/api/core';
import type {
  AccountProfile,
  AssetRecord,
  CacheStats,
  CredentialStatus,
  PreviewResult,
  SaveYuqueDocumentInput,
  SecretStatus,
  UploadQuotaStatus,
  UploadResult,
  YuqueDocumentResult,
} from '../types';

const DEFAULT_ACCOUNT = 'default';

function activeAccountName(): string {
  return localStorage.getItem('quepic-account')?.trim() || DEFAULT_ACCOUNT;
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

export async function listAssets(): Promise<AssetRecord[]> {
  return invoke<AssetRecord[]>('list_assets');
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
): Promise<UploadResult> {
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  return invoke<UploadResult>('upload_image', {
    input: {
      file_name: file.name,
      mime_type: resolveImageMimeType(file),
      bytes,
      width,
      height,
      account_name: accountName,
      category,
    },
  });
}

export async function saveYuqueDocument(
  input: SaveYuqueDocumentInput,
): Promise<YuqueDocumentResult> {
  return invoke<YuqueDocumentResult>('create_yuque_document', { input });
}
