import { invoke } from '@tauri-apps/api/core';
import type { AssetRecord, CredentialStatus, UploadResult } from '../types';

export async function listAssets(): Promise<AssetRecord[]> {
  return invoke<AssetRecord[]>('list_assets');
}

export async function deleteAsset(id: number): Promise<void> {
  return invoke('delete_asset', { id });
}

export async function saveCookie(accountName: string, cookie: string): Promise<CredentialStatus> {
  return invoke<CredentialStatus>('save_cookie', { accountName, cookie });
}

export async function clearCookie(accountName: string): Promise<void> {
  return invoke('clear_cookie', { accountName });
}

export async function getCredentialStatus(accountName: string): Promise<CredentialStatus> {
  return invoke<CredentialStatus>('credential_status', { accountName });
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
      mime_type: file.type || 'application/octet-stream',
      bytes,
      width,
      height,
      account_name: accountName,
    },
  });
}
