use keyring::{Entry, Error};

const SERVICE_NAME: &str = "com.weepwood.quepic.yuque-cookie";

pub fn save(account_name: &str, cookie: &str) -> Result<(), String> {
    validate_account_name(account_name)?;
    let cookie = cookie.trim();
    if cookie.len() < 16 || !cookie.contains('=') {
        return Err("Cookie 内容看起来不完整，请复制完整的 Request Headers Cookie 值。".into());
    }
    if cookie.len() > 64 * 1024 {
        return Err("Cookie 内容异常，长度超过允许范围。".into());
    }

    entry(account_name)?
        .set_password(cookie)
        .map_err(|error| format!("无法写入系统密钥库：{error}"))
}

pub fn load(account_name: &str) -> Result<String, String> {
    validate_account_name(account_name)?;
    entry(account_name)?
        .get_password()
        .map_err(|error| match error {
            Error::NoEntry => "尚未配置该账号的语雀 Cookie。".into(),
            other => format!("无法读取系统密钥库：{other}"),
        })
}

pub fn configured(account_name: &str) -> Result<bool, String> {
    validate_account_name(account_name)?;
    match entry(account_name)?.get_password() {
        Ok(value) => Ok(!value.trim().is_empty()),
        Err(Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("无法访问系统密钥库：{error}")),
    }
}

pub fn clear(account_name: &str) -> Result<(), String> {
    validate_account_name(account_name)?;
    match entry(account_name)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法从系统密钥库删除凭据：{error}")),
    }
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
    if value.len() > 80 {
        return Err("账号名称过长。".into());
    }
    Ok(())
}
