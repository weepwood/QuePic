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
