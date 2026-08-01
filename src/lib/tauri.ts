import { invoke } from '@tauri-apps/api/core';
import type {
  AssetRecord,
  CacheStats,
  CreateYuqueDocumentInput,
  CredentialStatus,
  PreviewResult,
  UploadResult,
  YuqueDocumentResult,
} from '../types';

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/tiff',
  'image/avif',
]);

function resolveImageMimeType(file: File): string {
  const declaredType = file.type.trim().toLowerCase();
  if (SUPPORTED_IMAGE_MIME_TYPES.has(declaredType)) return declaredType;

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

export async function uploadImage(
  file: File,
  accountName: string,
  width: number | null,
  height: number | null,
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
    },
  });
}

export async function createYuqueDocument(
  input: CreateYuqueDocumentInput,
): Promise<YuqueDocumentResult> {
  return invoke<YuqueDocumentResult>('create_yuque_document', { input });
}
