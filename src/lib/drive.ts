import { invoke } from '@tauri-apps/api/core';

import type {
  DriveFileRecord,
  DriveLocalFile,
  DriveSaveResult,
  DriveUploadResult,
} from '../drive-types';
import { getStoredUploadContext } from './tauri';
import { recordUploadLog } from './uploadLogger';

export async function pickDriveFiles(): Promise<DriveLocalFile[]> {
  return invoke<DriveLocalFile[]>('pick_drive_files');
}

export async function listDriveFiles(): Promise<DriveFileRecord[]> {
  return invoke<DriveFileRecord[]>('list_drive_files');
}

export async function listDriveFolders(): Promise<string[]> {
  return invoke<string[]>('list_drive_folders');
}

export async function createDriveFolder(name: string): Promise<string> {
  return invoke<string>('create_drive_folder', { name });
}

export async function listDriveTags(): Promise<string[]> {
  return invoke<string[]>('list_drive_tags');
}

export async function updateDriveFileFolder(id: number, folder: string): Promise<DriveFileRecord> {
  return invoke<DriveFileRecord>('update_drive_file_folder', { id, folder });
}

export async function updateDriveFileTags(id: number, tags: string[]): Promise<DriveFileRecord> {
  return invoke<DriveFileRecord>('update_drive_file_tags', { id, tags });
}

export async function deleteDriveFile(id: number): Promise<void> {
  return invoke('delete_drive_file', { id });
}

export async function saveDriveFile(id: number): Promise<DriveSaveResult> {
  return invoke<DriveSaveResult>('save_drive_file', { id });
}

export async function uploadDriveFile(
  localFile: DriveLocalFile,
  accountName: string,
  folder: string,
  tags: string[],
): Promise<DriveUploadResult> {
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  const context = getStoredUploadContext(accountName);
  const request = {
    local_path: localFile.local_path,
    file_name: localFile.file_name,
    extension: localFile.extension,
    mime_type: localFile.mime_type,
    byte_count: localFile.file_size,
    account_name: accountName,
    folder,
    tags,
    attachable_id: context?.attachable_id ?? null,
    referer_url: context?.document_url ?? null,
    upload_mode: context ? 'document_context' : 'contextless_attachment',
  };

  recordUploadLog({
    requestId,
    phase: 'prepared',
    title: '准备上传云盘附件',
    accountName,
    fileName: localFile.file_name,
    fileSize: localFile.file_size,
    mimeType: localFile.mime_type,
    request,
  });

  try {
    recordUploadLog({
      requestId,
      phase: 'sent',
      title: '已发送流式附件上传命令',
      accountName,
      fileName: localFile.file_name,
      fileSize: localFile.file_size,
      mimeType: localFile.mime_type,
      durationMs: Math.round(performance.now() - startedAt),
      request,
    });
    const result = await invoke<DriveUploadResult>('upload_drive_file', {
      input: {
        local_path: localFile.local_path,
        account_name: accountName,
        folder,
        tags,
        attachable_id: context?.attachable_id ?? null,
        referer_url: context?.document_url ?? null,
      },
    });
    recordUploadLog({
      requestId,
      phase: 'success',
      title: result.deduplicated ? '复用历史附件地址' : '语雀附件上传成功',
      accountName,
      fileName: localFile.file_name,
      fileSize: localFile.file_size,
      mimeType: localFile.mime_type,
      durationMs: Math.round(performance.now() - startedAt),
      request,
      response: {
        command: 'upload_drive_file',
        status: 'success',
        deduplicated: result.deduplicated,
        file: result.file,
      },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordUploadLog({
      requestId,
      phase: 'error',
      title: '语雀附件上传失败',
      accountName,
      fileName: localFile.file_name,
      fileSize: localFile.file_size,
      mimeType: localFile.mime_type,
      durationMs: Math.round(performance.now() - startedAt),
      request,
      response: { command: 'upload_drive_file', status: 'error', message },
      error: message,
    });
    throw error;
  }
}
