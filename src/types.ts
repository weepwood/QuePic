export type ViewKey = 'upload' | 'library' | 'settings';

export interface AssetRecord {
  id: number;
  sha256: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  width: number | null;
  height: number | null;
  remote_url: string;
  account_name: string;
  uploaded_at: string;
}

export interface UploadResult {
  asset: AssetRecord;
  deduplicated: boolean;
}

export type UploadStatus = 'waiting' | 'uploading' | 'success' | 'failed';

export interface UploadQueueItem {
  id: string;
  file: File;
  previewUrl: string;
  width: number | null;
  height: number | null;
  status: UploadStatus;
  result?: UploadResult;
  error?: string;
}

export interface CredentialStatus {
  configured: boolean;
  account_name: string;
}
