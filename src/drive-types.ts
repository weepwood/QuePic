export interface DriveFileRecord {
  id: number;
  sha256: string;
  file_name: string;
  extension: string;
  mime_type: string;
  file_size: number;
  remote_url: string;
  account_name: string;
  folder: string;
  tags: string[];
  local_path: string | null;
  uploaded_at: string;
}

export interface DriveLocalFile {
  local_path: string;
  file_name: string;
  extension: string;
  mime_type: string;
  file_size: number;
  supported: boolean;
  validation_message: string | null;
}

export interface DriveUploadResult {
  file: DriveFileRecord;
  deduplicated: boolean;
}

export interface DriveSaveResult {
  cancelled: boolean;
  path: string | null;
}

export type DriveQueueStatus = 'waiting' | 'uploading' | 'success' | 'error';

export interface DriveQueueItem extends DriveLocalFile {
  id: string;
  status: DriveQueueStatus;
  result?: DriveUploadResult;
  error?: string;
}
