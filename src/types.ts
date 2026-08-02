export type ViewKey = 'upload' | 'document' | 'library' | 'settings';

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
  category: string;
  original_path: string | null;
  thumbnail_path: string | null;
  preview_source: 'local' | 'remote_url' | 'yuque_session' | 'wordpress_proxy' | 'missing' | string;
  cache_status: 'ready' | 'missing' | 'error' | string;
  cache_bytes: number | null;
  cached_at: string | null;
  last_error: string | null;
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

export interface SecretStatus {
  configured: boolean;
  account_name: string;
}

export interface PreviewResult {
  asset_id: number;
  local_path: string | null;
  proxy_url: string | null;
  source: 'local' | 'remote_url' | 'yuque_session' | 'wordpress_proxy' | 'missing' | string;
  cached: boolean;
  last_error: string | null;
}

export interface CacheStats {
  asset_count: number;
  cached_count: number;
  cache_bytes: number;
}

export interface UploadQuotaStatus {
  account_name: string;
  used: number;
  limit: number;
  remaining: number;
  retry_after_seconds: number;
  reset_at: string | null;
  minimum_interval_seconds: number;
}

export interface SaveYuqueDocumentInput {
  account_name: string;
  knowledge_base_url: string;
  document_url: string | null;
  title: string;
  body: string;
}

export interface YuqueDocumentResult {
  id: number;
  title: string;
  slug: string;
  url: string | null;
  created: boolean;
  namespace: string;
}
