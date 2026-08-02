use keyring::{Entry, Error};
use sha2::{Digest, Sha256};

const SERVICE_NAME: &str = "com.weepwood.quepic.yuque-cookie";
const MANIFEST_PREFIX: &str = "v2|";
const CHUNK_UTF16_LIMIT: usize = 1_800;
const MAX_COOKIE_BYTES: usize = 64 * 1024;
const MAX_CHUNKS: usize = 64;

pub fn save(account_name: &str, cookie: &str) -> Result<(), String> {
    validate_account_name(account_name)?;
    let cookie = validate_cookie(cookie)?;
    let old_manifest = read_manifest(account_name).ok().flatten();
    let generation = cookie_generation(cookie);
    let chunks = split_by_utf16_units(cookie, CHUNK_UTF16_LIMIT);

    if chunks.is_empty() || chunks.len() > MAX_CHUNKS {
        return Err("Cookie 内容异常，无法安全拆分保存。".into());
    }

    for (index, chunk) in chunks.iter().enumerate() {
        chunk_entry(account_name, &generation, index)?
            .set_password(chunk)
            .map_err(|error| format!("无法写入系统密钥库分片 {}/{}：{error}", index + 1, chunks.len()))?;
    }

    let manifest = format!("{MANIFEST_PREFIX}{generation}|{}", chunks.len());
    if let Err(error) = entry(account_name)?.set_password(&manifest) {
        clear_chunks(account_name, &generation, chunks.len());
        return Err(format!("无法写入系统密钥库索引：{error}"));
    }

    if let Some((old_generation, old_count)) = old_manifest {
        if old_generation != generation {
            clear_chunks(account_name, &old_generation, old_count);
        }
    }

    Ok(())
}

pub fn load(account_name: &str) -> Result<String, String> {
    validate_account_name(account_name)?;
    let stored = entry(account_name)?
        .get_password()
        .map_err(|error| match error {
            Error::NoEntry => "尚未配置该账号的语雀 Cookie。".into(),
            other => format!("无法读取系统密钥库：{other}"),
        })?;

    if let Some((generation, count)) = parse_manifest(&stored) {
        let mut cookie = String::new();
        for index in 0..count {
            let chunk = chunk_entry(account_name, &generation, index)?
                .get_password()
                .map_err(|error| format!("无法读取系统密钥库分片 {}/{}：{error}", index + 1, count))?;
            cookie.push_str(&chunk);
        }
        validate_cookie(&cookie)?;
        return Ok(cookie);
    }

    // 兼容 v0.1.0 直接保存单条 Cookie 的格式。
    validate_cookie(&stored)?;
    Ok(stored)
}

pub fn configured(account_name: &str) -> Result<bool, String> {
    validate_account_name(account_name)?;
    match entry(account_name)?.get_password() {
        Ok(value) if parse_manifest(&value).is_some() => Ok(true),
        Ok(value) => Ok(validate_cookie(&value).is_ok()),
        Err(Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("无法访问系统密钥库：{error}")),
    }
}

pub fn clear(account_name: &str) -> Result<(), String> {
    validate_account_name(account_name)?;
    if let Some((generation, count)) = read_manifest(account_name)? {
        clear_chunks(account_name, &generation, count);
    }

    match entry(account_name)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法从系统密钥库删除凭据：{error}")),
    }
}

fn validate_cookie(cookie: &str) -> Result<&str, String> {
    let cookie = cookie.trim();
    if cookie.len() < 16 || !cookie.contains('=') {
        return Err("Cookie 内容看起来不完整，请重新登录语雀后再保存。".into());
    }
    if cookie.len() > MAX_COOKIE_BYTES {
        return Err("Cookie 内容异常，长度超过允许范围。".into());
    }
    Ok(cookie)
}

fn read_manifest(account_name: &str) -> Result<Option<(String, usize)>, String> {
    match entry(account_name)?.get_password() {
        Ok(value) => Ok(parse_manifest(&value)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取系统密钥库索引：{error}")),
    }
}

fn parse_manifest(value: &str) -> Option<(String, usize)> {
    let remainder = value.strip_prefix(MANIFEST_PREFIX)?;
    let (generation, count) = remainder.split_once('|')?;
    if generation.len() != 16 || !generation.chars().all(|value| value.is_ascii_hexdigit()) {
        return None;
    }
    let count = count.parse::<usize>().ok()?;
    if count == 0 || count > MAX_CHUNKS {
        return None;
    }
    Some((generation.to_string(), count))
}

fn cookie_generation(cookie: &str) -> String {
    let digest = Sha256::digest(cookie.as_bytes());
    format!("{:x}", digest)[..16].to_string()
}

fn split_by_utf16_units(value: &str, limit: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut units = 0;

    for (index, character) in value.char_indices() {
        let character_units = character.len_utf16();
        if units + character_units > limit && index > start {
            chunks.push(value[start..index].to_string());
            start = index;
            units = 0;
        }
        units += character_units;
    }

    if start < value.len() {
        chunks.push(value[start..].to_string());
    }
    chunks
}

fn clear_chunks(account_name: &str, generation: &str, count: usize) {
    for index in 0..count.min(MAX_CHUNKS) {
        if let Ok(entry) = chunk_entry(account_name, generation, index) {
            let _ = entry.delete_credential();
        }
    }
}

fn chunk_entry(account_name: &str, generation: &str, index: usize) -> Result<Entry, String> {
    entry(&format!("{}::cookie-v2::{generation}::{index:03}", account_name.trim()))
}

fn entry(account_name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, account_name.trim())
        .map_err(|error| format!("无法初始化系统密钥库：{error}"))
}

fn validate_account_name(account_name: &str) -> Result<(), String> {
    let value = account_name.trim();
    if value.is_empty() {
        return Err("账号名称不能为空。".into());
    }
    if value.chars().count() > 80 {
        return Err("账号名称不能超过 80 个字符。".into());
    }
    if value.chars().any(char::is_control) {
        return Err("账号名称包含无效控制字符。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_long_cookie_below_windows_limit() {
        let cookie = format!("session={}; token={}", "a".repeat(4_000), "中".repeat(1_000));
        let chunks = split_by_utf16_units(&cookie, CHUNK_UTF16_LIMIT);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.encode_utf16().count() <= CHUNK_UTF16_LIMIT));
        assert_eq!(chunks.concat(), cookie);
    }

    #[test]
    fn parses_v2_manifest() {
        assert_eq!(parse_manifest("v2|0123456789abcdef|3"), Some(("0123456789abcdef".into(), 3)));
        assert_eq!(parse_manifest("session=value"), None);
        assert_eq!(parse_manifest("v2|bad|0"), None);
    }

    #[test]
    fn accepts_multibyte_account_names_by_character_count() {
        assert!(validate_account_name(&"账号".repeat(40)).is_ok());
        assert!(validate_account_name(&"账号".repeat(41)).is_err());
        assert!(validate_account_name("账号\n名称").is_err());
    }
}
