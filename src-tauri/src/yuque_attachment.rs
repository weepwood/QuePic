use std::{fs::File as StdFile, io::Read, path::Path, time::Duration};

use reqwest::{header, multipart, redirect::Policy, Client, RequestBuilder, Response, StatusCode};
use serde_json::Value;
use tokio::{fs::File, io::AsyncWriteExt, time::sleep};
use url::Url;

const UPLOAD_ENDPOINT: &str = "https://www.yuque.com/api/upload/attach";
const DIGEST_ENDPOINT: &str = "https://www.yuque.com/api/upload/upload_by_digset";
const YUQUE_ORIGIN_REFERER: &str = "https://www.yuque.com/";
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const BROWSER_ACCEPT: &str = "text/javascript, text/html, application/xml, text/xml, */*";
const BROWSER_ACCEPT_LANGUAGE: &str = "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7";
const BROWSER_ACCEPT_ENCODING: &str = "gzip, deflate, br, zstd";
const BROWSER_CLIENT_HINT: &str =
    "\"Not;A=Brand\";v=\"8\", \"Chromium\";v=\"151\", \"Google Chrome\";v=\"151\"";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_UPLOAD_RETRIES: usize = 2;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const ALLOWED_ATTACHMENT_HOST_SUFFIXES: &[&str] = &["yuque.com", "nlark.com"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadKind {
    Image,
    Attachment,
}

pub async fn upload(
    cookie: &str,
    local_path: &Path,
    file_name: &str,
    mime_type: &str,
    attachable_id: Option<i64>,
    referer_url: Option<&str>,
) -> Result<String, String> {
    let attachable_id = require_attachable_id(attachable_id)?;
    let referer = resolve_upload_referer(referer_url)?;
    let ctoken = cookie_value(cookie, "yuque_ctoken")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "语雀 Cookie 中缺少 yuque_ctoken，请重新登录后再上传。".to_string())?;
    let upload_kind = classify_upload(mime_type);
    let client = secure_client(Duration::from_secs(600))?;

    if upload_kind == UploadKind::Attachment {
        let hash_path = local_path.to_path_buf();
        let (file_md5, file_size) = tokio::task::spawn_blocking(move || hash_file_md5(&hash_path))
            .await
            .map_err(|error| format!("附件 MD5 计算任务失败：{error}"))??;
        if let Some(remote_url) = try_digest_upload(
            &client,
            cookie,
            &referer,
            &ctoken,
            attachable_id,
            file_name,
            mime_type,
            &file_md5,
            file_size,
        )
        .await?
        {
            return Ok(remote_url);
        }
    }

    upload_file_body(
        &client,
        cookie,
        &referer,
        &ctoken,
        attachable_id,
        local_path,
        file_name,
        mime_type,
        upload_kind,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn try_digest_upload(
    client: &Client,
    cookie: &str,
    referer: &str,
    ctoken: &str,
    attachable_id: i64,
    file_name: &str,
    mime_type: &str,
    file_md5: &str,
    file_size: u64,
) -> Result<Option<String>, String> {
    let url = build_digest_url(ctoken, attachable_id)?;
    let file_size = file_size.to_string();
    let body = [
        ("md5", file_md5),
        ("filesize", file_size.as_str()),
        ("filename", file_name),
        ("filetype", mime_type),
        ("ctoken", ctoken),
    ];

    let mut last_error = None;
    for attempt in 0..=MAX_UPLOAD_RETRIES {
        let request = apply_browser_headers(client.post(url.clone()), cookie, referer).form(&body);
        match request.send().await {
            Ok(response) if response.status().is_server_error() && attempt < MAX_UPLOAD_RETRIES => {
                last_error = Some(format!("HTTP {}", response.status()));
            }
            Ok(response) => {
                let payload = parse_upload_response(response, "附件秒传检测").await?;
                let data = payload.get("data").unwrap_or(&Value::Null);
                if is_symlink_hit(data) {
                    let raw_url = find_attachment_url(&payload)
                        .ok_or_else(|| "语雀秒传命中，但未返回可下载地址。".to_string())?;
                    return normalize_remote_url(raw_url).map(Some);
                }
                return Ok(None);
            }
            Err(error) if attempt < MAX_UPLOAD_RETRIES => {
                last_error = Some(error.to_string());
            }
            Err(error) => {
                return Err(format!("连接语雀附件秒传接口失败：{error}"));
            }
        }
        sleep(retry_delay(attempt)).await;
    }

    Err(format!(
        "语雀附件秒传检测失败（已重试 {MAX_UPLOAD_RETRIES} 次）：{}",
        last_error.unwrap_or_else(|| "未知错误".into())
    ))
}

#[allow(clippy::too_many_arguments)]
async fn upload_file_body(
    client: &Client,
    cookie: &str,
    referer: &str,
    ctoken: &str,
    attachable_id: i64,
    local_path: &Path,
    file_name: &str,
    mime_type: &str,
    upload_kind: UploadKind,
) -> Result<String, String> {
    let url = build_upload_url(ctoken, attachable_id, upload_kind)?;
    let mut last_error = None;

    for attempt in 0..=MAX_UPLOAD_RETRIES {
        let part = multipart::Part::file(local_path)
            .await
            .map_err(|error| format!("读取待上传文件失败：{error}"))?
            .file_name(file_name.to_string())
            .mime_str(mime_type)
            .map_err(|_| "文件 MIME 类型无效。".to_string())?;
        let form = multipart::Form::new().part("file", part);
        let request =
            apply_browser_headers(client.post(url.clone()), cookie, referer).multipart(form);

        match request.send().await {
            Ok(response) if response.status().is_server_error() && attempt < MAX_UPLOAD_RETRIES => {
                last_error = Some(format!("HTTP {}", response.status()));
            }
            Ok(response) => {
                let operation = if upload_kind == UploadKind::Image {
                    "图片上传"
                } else {
                    "附件上传"
                };
                let payload = parse_upload_response(response, operation).await?;
                let raw_url = find_attachment_url(&payload)
                    .ok_or_else(|| format!("语雀{operation}接口未返回可下载地址。"))?;
                return normalize_remote_url(raw_url);
            }
            Err(error) if attempt < MAX_UPLOAD_RETRIES => {
                last_error = Some(error.to_string());
            }
            Err(error) => {
                return Err(format!("连接语雀上传接口失败：{error}"));
            }
        }
        sleep(retry_delay(attempt)).await;
    }

    Err(format!(
        "语雀上传请求失败（已重试 {MAX_UPLOAD_RETRIES} 次）：{}",
        last_error.unwrap_or_else(|| "未知错误".into())
    ))
}

async fn parse_upload_response(response: Response, operation: &str) -> Result<Value, String> {
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(
            "语雀 Cookie 已失效或当前账号没有目标文档权限，请重新登录并验证文档 URL。".into(),
        );
    }
    if status.is_redirection() {
        return Err(format!(
            "语雀{operation}接口返回了重定向。为避免 Cookie 泄露，QuePic 已拒绝继续请求。"
        ));
    }
    if response.content_length().unwrap_or(0) as usize > MAX_RESPONSE_BYTES {
        return Err(format!("语雀{operation}接口响应体异常过大。"));
    }

    let response_text = response
        .text()
        .await
        .map_err(|error| format!("读取语雀{operation}响应失败：{error}"))?;
    if response_text.len() > MAX_RESPONSE_BYTES {
        return Err(format!("语雀{operation}接口响应体异常过大。"));
    }

    let payload: Value = serde_json::from_str(&response_text).map_err(|_| {
        if response_text.contains("登录") || response_text.to_ascii_lowercase().contains("login")
        {
            "语雀返回了登录页面，Cookie 可能已经失效。".to_string()
        } else {
            format!("语雀{operation}接口返回格式已经变化，请更新 QuePic。")
        }
    })?;

    if !status.is_success() {
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| payload.get("msg").and_then(Value::as_str))
            .or_else(|| payload.get("code").and_then(Value::as_str));
        return Err(message
            .map(|value| format!("语雀拒绝{operation}：{value}"))
            .unwrap_or_else(|| format!("语雀拒绝{operation}（HTTP {status}）。")));
    }

    Ok(payload)
}

fn apply_browser_headers(request: RequestBuilder, cookie: &str, referer: &str) -> RequestBuilder {
    request
        .header(header::COOKIE, cookie)
        .header(header::REFERER, referer)
        .header(header::ORIGIN, "https://www.yuque.com")
        .header(header::ACCEPT, BROWSER_ACCEPT)
        .header(header::ACCEPT_LANGUAGE, BROWSER_ACCEPT_LANGUAGE)
        .header(header::ACCEPT_ENCODING, BROWSER_ACCEPT_ENCODING)
        .header(header::USER_AGENT, BROWSER_USER_AGENT)
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-origin")
        .header("sec-ch-ua", BROWSER_CLIENT_HINT)
        .header("sec-ch-ua-mobile", "?0")
        .header("sec-ch-ua-platform", "\"Windows\"")
}

fn build_digest_url(ctoken: &str, attachable_id: i64) -> Result<Url, String> {
    let mut url =
        Url::parse(DIGEST_ENDPOINT).map_err(|error| format!("语雀附件秒传地址无效：{error}"))?;
    url.query_pairs_mut()
        .append_pair("attachable_type", "Doc")
        .append_pair("attachable_id", &attachable_id.to_string())
        .append_pair("type", "attachment")
        .append_pair("ctoken", ctoken);
    Ok(url)
}

fn build_upload_url(
    ctoken: &str,
    attachable_id: i64,
    upload_kind: UploadKind,
) -> Result<Url, String> {
    let mut url =
        Url::parse(UPLOAD_ENDPOINT).map_err(|error| format!("语雀上传地址无效：{error}"))?;
    let mut query = url.query_pairs_mut();
    query
        .append_pair("attachable_type", "Doc")
        .append_pair("attachable_id", &attachable_id.to_string());
    match upload_kind {
        UploadKind::Image => {
            query.append_pair("type", "image").append_pair("ocr", "off");
        }
        UploadKind::Attachment => {
            query.append_pair("type", "attachment");
        }
    }
    query.append_pair("ctoken", ctoken);
    drop(query);
    Ok(url)
}

fn require_attachable_id(attachable_id: Option<i64>) -> Result<i64, String> {
    match attachable_id {
        Some(value) if value > 0 => Ok(value),
        _ => Err(
            "语雀网页上传必须关联有效文档 ID；请先在设置中验证目标文档 URL，再上传图片或附件。"
                .into(),
        ),
    }
}

fn resolve_upload_referer(referer_url: Option<&str>) -> Result<String, String> {
    let referer_url = referer_url.ok_or_else(|| {
        "语雀网页上传必须携带目标文档 Referer；请先在设置中验证目标文档 URL。".to_string()
    })?;
    normalize_document_url(referer_url)
}

fn classify_upload(mime_type: &str) -> UploadKind {
    if mime_type.trim().to_ascii_lowercase().starts_with("image/") {
        UploadKind::Image
    } else {
        UploadKind::Attachment
    }
}

fn hash_file_md5(path: &Path) -> Result<(String, u64), String> {
    let mut file = StdFile::open(path).map_err(|error| format!("读取待上传附件失败：{error}"))?;
    let file_size = file
        .metadata()
        .map_err(|error| format!("读取附件大小失败：{error}"))?
        .len();
    let mut context = Md5Context::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("计算附件 MD5 失败：{error}"))?;
        if read == 0 {
            break;
        }
        context.update(&buffer[..read]);
    }
    Ok((hex_lower(&context.finalize()), file_size))
}

struct Md5Context {
    state: [u32; 4],
    length_bytes: u64,
    buffer: [u8; 64],
    buffer_len: usize,
}

impl Md5Context {
    fn new() -> Self {
        Self {
            state: [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476],
            length_bytes: 0,
            buffer: [0; 64],
            buffer_len: 0,
        }
    }

    fn update(&mut self, mut input: &[u8]) {
        self.length_bytes = self.length_bytes.wrapping_add(input.len() as u64);

        if self.buffer_len > 0 {
            let needed = 64 - self.buffer_len;
            let copied = needed.min(input.len());
            self.buffer[self.buffer_len..self.buffer_len + copied]
                .copy_from_slice(&input[..copied]);
            self.buffer_len += copied;
            input = &input[copied..];
            if self.buffer_len == 64 {
                let block = self.buffer;
                self.process_block(&block);
                self.buffer_len = 0;
            }
        }

        while input.len() >= 64 {
            let block: &[u8; 64] = input[..64].try_into().expect("MD5 block length is fixed");
            self.process_block(block);
            input = &input[64..];
        }

        if !input.is_empty() {
            self.buffer[..input.len()].copy_from_slice(input);
            self.buffer_len = input.len();
        }
    }

    fn finalize(mut self) -> [u8; 16] {
        let bit_length = self.length_bytes.wrapping_mul(8);
        let mut tail = Vec::with_capacity(128);
        tail.extend_from_slice(&self.buffer[..self.buffer_len]);
        tail.push(0x80);
        while tail.len() % 64 != 56 {
            tail.push(0);
        }
        tail.extend_from_slice(&bit_length.to_le_bytes());
        for chunk in tail.chunks_exact(64) {
            let block: &[u8; 64] = chunk.try_into().expect("MD5 tail block length is fixed");
            self.process_block(block);
        }

        let mut digest = [0_u8; 16];
        for (index, value) in self.state.iter().enumerate() {
            digest[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        digest
    }

    fn process_block(&mut self, block: &[u8; 64]) {
        const SHIFTS: [u32; 64] = [
            7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20,
            5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
            6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
        ];
        const CONSTANTS: [u32; 64] = [
            0xd76a_a478,
            0xe8c7_b756,
            0x2420_70db,
            0xc1bd_ceee,
            0xf57c_0faf,
            0x4787_c62a,
            0xa830_4613,
            0xfd46_9501,
            0x6980_98d8,
            0x8b44_f7af,
            0xffff_5bb1,
            0x895c_d7be,
            0x6b90_1122,
            0xfd98_7193,
            0xa679_438e,
            0x49b4_0821,
            0xf61e_2562,
            0xc040_b340,
            0x265e_5a51,
            0xe9b6_c7aa,
            0xd62f_105d,
            0x0244_1453,
            0xd8a1_e681,
            0xe7d3_fbc8,
            0x21e1_cde6,
            0xc337_07d6,
            0xf4d5_0d87,
            0x455a_14ed,
            0xa9e3_e905,
            0xfcef_a3f8,
            0x676f_02d9,
            0x8d2a_4c8a,
            0xfffa_3942,
            0x8771_f681,
            0x6d9d_6122,
            0xfde5_380c,
            0xa4be_ea44,
            0x4bde_cfa9,
            0xf6bb_4b60,
            0xbebf_bc70,
            0x289b_7ec6,
            0xeaa1_27fa,
            0xd4ef_3085,
            0x0488_1d05,
            0xd9d4_d039,
            0xe6db_99e5,
            0x1fa2_7cf8,
            0xc4ac_5665,
            0xf429_2244,
            0x432a_ff97,
            0xab94_23a7,
            0xfc93_a039,
            0x655b_59c3,
            0x8f0c_cc92,
            0xffef_f47d,
            0x8584_5dd1,
            0x6fa8_7e4f,
            0xfe2c_e6e0,
            0xa301_4314,
            0x4e08_11a1,
            0xf753_7e82,
            0xbd3a_f235,
            0x2ad7_d2bb,
            0xeb86_d391,
        ];

        let mut words = [0_u32; 16];
        for (index, chunk) in block.chunks_exact(4).enumerate() {
            words[index] = u32::from_le_bytes(chunk.try_into().expect("MD5 word length is fixed"));
        }

        let [mut a, mut b, mut c, mut d] = self.state;
        for index in 0..64 {
            let (function, word_index) = match index {
                0..=15 => ((b & c) | (!b & d), index),
                16..=31 => ((d & b) | (!d & c), (5 * index + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * index + 5) % 16),
                _ => (c ^ (b | !d), (7 * index) % 16),
            };
            let previous_d = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                a.wrapping_add(function)
                    .wrapping_add(CONSTANTS[index])
                    .wrapping_add(words[word_index])
                    .rotate_left(SHIFTS[index]),
            );
            a = previous_d;
        }

        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn is_symlink_hit(data: &Value) -> bool {
    data.get("symlink")
        .and_then(Value::as_i64)
        .is_some_and(|value| value != 0)
        || data
            .get("symlink")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn retry_delay(attempt: usize) -> Duration {
    Duration::from_millis(500 * (attempt as u64 + 1))
}

pub async fn download_to(cookie: &str, remote_url: &str, target: &Path) -> Result<(), String> {
    let client = secure_client(Duration::from_secs(600))?;
    let mut current_url = normalize_remote_url(remote_url)?;

    for _ in 0..4 {
        let parsed = Url::parse(&current_url).map_err(|_| "语雀附件下载地址无效。".to_string())?;
        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        let mut request = client
            .get(parsed.clone())
            .header(header::REFERER, YUQUE_ORIGIN_REFERER)
            .header(header::ACCEPT, "*/*")
            .header(header::ACCEPT_LANGUAGE, BROWSER_ACCEPT_LANGUAGE)
            .header(header::USER_AGENT, BROWSER_USER_AGENT);
        if host == "yuque.com" || host.ends_with(".yuque.com") {
            request = request.header(header::COOKIE, cookie);
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| format!("连接语雀附件下载地址失败：{error}"))?;

        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("语雀附件拒绝访问，请重新登录来源账号后重试。".into());
        }
        if status.is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "语雀附件下载重定向缺少 Location。".to_string())?;
            let next = parsed
                .join(location)
                .map_err(|_| "语雀附件下载重定向地址无效。".to_string())?;
            current_url = normalize_remote_url(next.as_str())?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("语雀附件下载失败（HTTP {status}）。"));
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .unwrap_or_default()
            .trim();
        if content_type.eq_ignore_ascii_case("text/html") {
            return Err(
                "语雀返回了网页而不是原始附件，下载地址可能已失效或来源账号需要重新登录。".into(),
            );
        }
        if response.content_length().unwrap_or(0) > MAX_DOWNLOAD_BYTES {
            return Err("远程附件超过 QuePic 当前 1 GB 下载保护上限。".into());
        }

        let mut file = File::create(target)
            .await
            .map_err(|error| format!("创建附件保存文件失败：{error}"))?;
        let mut written = 0_u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("读取语雀附件数据失败：{error}"))?
        {
            written = written.saturating_add(chunk.len() as u64);
            if written > MAX_DOWNLOAD_BYTES {
                let _ = tokio::fs::remove_file(target).await;
                return Err("远程附件超过 QuePic 当前 1 GB 下载保护上限。".into());
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("写入附件文件失败：{error}"))?;
        }
        file.flush()
            .await
            .map_err(|error| format!("刷新附件文件失败：{error}"))?;
        if written == 0 {
            let _ = tokio::fs::remove_file(target).await;
            return Err("语雀返回了空附件。".into());
        }
        return Ok(());
    }

    Err("语雀附件下载重定向次数过多。".into())
}

fn normalize_document_url(raw_url: &str) -> Result<String, String> {
    let parsed = Url::parse(raw_url.trim()).map_err(|_| "语雀文档 URL 无效。".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("www.yuque.com") {
        return Err("上传上下文必须是 https://www.yuque.com/ 下的文档地址。".into());
    }
    Ok(parsed.to_string())
}

fn find_attachment_url(payload: &Value) -> Option<&str> {
    const CANDIDATE_KEYS: &[&str] = &[
        "download_url",
        "downloadUrl",
        "original_url",
        "originalUrl",
        "source_url",
        "sourceUrl",
        "file_url",
        "fileUrl",
        "raw_url",
        "rawUrl",
        "url",
    ];
    for key in CANDIDATE_KEYS {
        if let Some(value) = payload
            .get("data")
            .and_then(|data| data.get(*key))
            .and_then(Value::as_str)
        {
            return Some(value);
        }
    }
    for key in CANDIDATE_KEYS {
        if let Some(value) = payload.get(*key).and_then(Value::as_str) {
            return Some(value);
        }
    }
    payload
        .get("data")
        .and_then(|data| data.get("attachment"))
        .and_then(|attachment| {
            CANDIDATE_KEYS
                .iter()
                .find_map(|key| attachment.get(*key).and_then(Value::as_str))
        })
}

fn cookie_value(cookie: &str, name: &str) -> Option<String> {
    cookie
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| key.trim() == name)
        .map(|(_, value)| value.trim().to_string())
}

fn normalize_remote_url(raw_url: &str) -> Result<String, String> {
    let normalized = if raw_url.starts_with("//") {
        format!("https:{raw_url}")
    } else if raw_url.starts_with('/') {
        format!("https://www.yuque.com{raw_url}")
    } else {
        raw_url.to_string()
    };
    let parsed = Url::parse(&normalized).map_err(|_| "语雀附件地址无效。".to_string())?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("语雀附件地址必须是无凭据的 HTTPS URL。".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "语雀附件地址缺少域名。".to_string())?
        .to_ascii_lowercase();
    if !ALLOWED_ATTACHMENT_HOST_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return Err(format!("拒绝访问非语雀附件域名：{host}"));
    }
    Ok(parsed.to_string())
}

fn secure_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|error| format!("创建语雀附件网络客户端失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        build_digest_url, build_upload_url, classify_upload, find_attachment_url, hex_lower,
        is_symlink_hit, normalize_remote_url, require_attachable_id, Md5Context, UploadKind,
    };
    use serde_json::json;

    #[test]
    fn builds_web_equivalent_upload_urls() {
        let digest = build_digest_url("token", 279855146).unwrap();
        let digest_query = digest
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            digest_query.get("type").map(|value| value.as_ref()),
            Some("attachment")
        );
        assert_eq!(
            digest_query
                .get("attachable_id")
                .map(|value| value.as_ref()),
            Some("279855146")
        );

        let attachment = build_upload_url("token", 279855146, UploadKind::Attachment).unwrap();
        let attachment_query = attachment
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            attachment_query.get("type").map(|value| value.as_ref()),
            Some("attachment")
        );
        assert!(!attachment_query.contains_key("ocr"));

        let image = build_upload_url("token", 279855146, UploadKind::Image).unwrap();
        let image_query = image
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            image_query.get("type").map(|value| value.as_ref()),
            Some("image")
        );
        assert_eq!(
            image_query.get("ocr").map(|value| value.as_ref()),
            Some("off")
        );
    }

    #[test]
    fn classifies_images_and_attachments() {
        assert_eq!(classify_upload("image/png"), UploadKind::Image);
        assert_eq!(classify_upload("application/zip"), UploadKind::Attachment);
        assert_eq!(
            classify_upload("application/x-zip-compressed"),
            UploadKind::Attachment
        );
    }

    #[test]
    fn requires_document_context_for_web_upload() {
        assert_eq!(require_attachable_id(Some(123)).unwrap(), 123);
        assert!(require_attachable_id(None).is_err());
        assert!(require_attachable_id(Some(0)).is_err());
    }

    #[test]
    fn computes_standard_md5_vectors() {
        let empty = Md5Context::new().finalize();
        assert_eq!(hex_lower(&empty), "d41d8cd98f00b204e9800998ecf8427e");

        let mut abc = Md5Context::new();
        abc.update(b"a");
        abc.update(b"bc");
        assert_eq!(
            hex_lower(&abc.finalize()),
            "900150983cd24fb0d6963f7d28e17f72"
        );
    }

    #[test]
    fn recognizes_digest_symlink_hits() {
        assert!(is_symlink_hit(&json!({"symlink": 1})));
        assert!(is_symlink_hit(&json!({"symlink": true})));
        assert!(!is_symlink_hit(&json!({"success": false})));
    }

    #[test]
    fn reads_common_attachment_url_shapes() {
        assert_eq!(
            find_attachment_url(&json!({"data": {"url": "https://cdn.nlark.com/a.pdf"}})),
            Some("https://cdn.nlark.com/a.pdf")
        );
        assert_eq!(
            find_attachment_url(&json!({
                "data": {
                    "url": "https://cdn.nlark.com/preview.pdf",
                    "download_url": "https://www.yuque.com/api/v2/attachments/original.pdf"
                }
            })),
            Some("https://www.yuque.com/api/v2/attachments/original.pdf")
        );
        assert_eq!(
            find_attachment_url(
                &json!({"data": {"attachment": {"download_url": "/api/attachments/a"}}})
            ),
            Some("/api/attachments/a")
        );
    }

    #[test]
    fn restricts_remote_attachment_hosts() {
        assert!(normalize_remote_url("https://cdn.nlark.com/a.pdf").is_ok());
        assert!(normalize_remote_url("/api/attachments/a").is_ok());
        assert!(normalize_remote_url("https://example.com/a.pdf").is_err());
    }
}
