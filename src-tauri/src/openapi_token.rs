use keyring::{Entry, Error};

use crate::models::CredentialStatus;

const SERVICE_NAME: &str = "com.weepwood.quepic.yuque-openapi-token";
const MAX_TOKEN_BYTES: usize = 8 * 1024;

#[tauri::command]
pub fn save_openapi_token(account_name: String, token: String) -> Result<CredentialStatus, String> {
    let account_name = normalize_account_name(&account_name)?;
    let token = validate_token(&token)?;
    entry(&account_name)?
        .set_password(token)
        .map_err(|error| format!("无法写入系统密钥库中的 OpenAPI Token：{error}"))?;
    Ok(CredentialStatus { configured: true, account_name })
}

#[tauri::command]
pub fn openapi_token_status(account_name: String) -> Result<CredentialStatus, String> {
    let account_name = normalize_account_name(&account_name)?;
    let configured = match entry(&account_name)?.get_password() {
        Ok(value) => validate_token(&value).is_ok(),
        Err(Error::NoEntry) => false,
        Err(error) => return Err(format!("无法读取系统密钥库中的 OpenAPI Token：{error}")),
    };
    Ok(CredentialStatus { configured, account_name })
}

#[tauri::command]
pub fn clear_openapi_token(account_name: String) -> Result<(), String> {
    let account_name = normalize_account_name(&account_name)?;
    match entry(&account_name)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法从系统密钥库删除 OpenAPI Token：{error}")),
    }
}

pub fn load(account_name: &str) -> Result<String, String> {
    let account_name = normalize_account_name(account_name)?;
    let token = entry(&account_name)?
        .get_password()
        .map_err(|error| match error {
            Error::NoEntry => "当前账号尚未配置语雀 OpenAPI Token。".to_string(),
            other => format!("无法读取系统密钥库中的 OpenAPI Token：{other}"),
        })?;
    Ok(validate_token(&token)?.to_string())
}

fn entry(account_name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, account_name)
        .map_err(|error| format!("无法初始化 OpenAPI Token 密钥库：{error}"))
}

fn validate_token(token: &str) -> Result<&str, String> {
    let token = token.trim();
    if token.len() < 8 {
        return Err("OpenAPI Token 内容过短。".into());
    }
    if token.len() > MAX_TOKEN_BYTES {
        return Err("OpenAPI Token 长度超过允许范围。".into());
    }
    if token.chars().any(char::is_control) {
        return Err("OpenAPI Token 包含无效控制字符。".into());
    }
    Ok(token)
}

fn normalize_account_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("账号名称不能为空。".into());
    }
    if value.len() > 80 {
        return Err("账号名称过长。".into());
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_token;

    #[test]
    fn validates_token_bounds() {
        assert!(validate_token("short").is_err());
        assert!(validate_token("12345678").is_ok());
    }
}
