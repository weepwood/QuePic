use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct AssetRecord {
    pub id: i64,
    pub sha256: String,
    pub file_name: String,
    pub mime_type: String,
    pub file_size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub remote_url: String,
    pub account_name: String,
    pub uploaded_at: String,
    pub original_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub preview_source: String,
    pub cache_status: String,
    pub cache_bytes: Option<i64>,
    pub cached_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UploadInput {
    pub file_name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub account_name: String,
}

#[derive(Debug, Serialize)]
pub struct UploadResult {
    pub asset: AssetRecord,
    pub deduplicated: bool,
}

#[derive(Debug, Serialize)]
pub struct CredentialStatus {
    pub configured: bool,
    pub account_name: String,
}

#[derive(Debug, Serialize)]
pub struct PreviewResult {
    pub asset_id: i64,
    pub local_path: Option<String>,
    pub proxy_url: Option<String>,
    pub source: String,
    pub cached: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CacheStats {
    pub asset_count: i64,
    pub cached_count: i64,
    pub cache_bytes: i64,
}
