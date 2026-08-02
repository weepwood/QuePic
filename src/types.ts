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

export interface SaveOriginalResult {
  cancelled: boolean;
  path: string | null;
}

export interface DailyDocumentImage {
  file_name: string;
  remote_url: string;
}

export type UploadStatus = 'waiting' | 'scheduled' | 'uploading' | 'success' | 'failed';

export interface UploadQueueItem {
  id: string;
  file: File;
  previewUrl: string;
  width: number | null;
  height: number | null;
  accountName: string;
  category: string;
  createdAt: number;
  scheduledAt: number | null;
  status: UploadStatus;
  result?: UploadResult;
  error?: string;
}

export interface StoredUploadQueueItem {
  id: string;
  file: File;
  width: number | null;
  height: number | null;
  accountName: string;
  category: string;
  createdAt: number;
  scheduledAt: number | null;
  status: 'waiting' | 'scheduled' | 'failed';
  error?: string;
}

export interface AccountProfile {
  account_name: string;
  credential_configured: boolean;
  token_configured: boolean;
  asset_count: number;
  cached_count: number;
  updated_at: string | null;
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
  /** 兼容旧客户端字段；连续上传模式下固定为 0。 */
  minimum_interval_seconds: number;
}

export interface UploadContextResult {
  account_name: string;
  attachable_id: number;
  document_url: string;
  title: string;
  source: 'openapi' | 'session' | string;
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

export interface YuqueRepositorySummary {
  id: number;
  name: string;
  slug: string;
  namespace: string;
  description: string | null;
  public: number;
  items_count: number;
  updated_at: string | null;
  url: string;
  managed: boolean;
}

export interface YuqueDocumentSummary {
  id: number;
  repository_id: number;
  title: string;
  slug: string;
  format: string | null;
  updated_at: string | null;
  word_count: number | null;
  url: string;
}
