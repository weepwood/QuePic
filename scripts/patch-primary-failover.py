from pathlib import Path

COMPAT_QUEUE = r'''
text = replace_once(text, '  accountName: string;\n  category: string;', '  accountName: string;\n  uploadAccountName?: string;\n  category: string;', 'queue actual account')
'''

COMPAT_RESET = r'''
        assert_eq!(before_reset.reset_at.as_deref(), Some("2027-01-15T08:00:00+00:00"));
'''


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


app_path = Path('src/App.tsx')
app = app_path.read_text(encoding='utf-8')
app = replace_once(
    app,
    '''  const fallbackProfiles = accountProfiles.filter(
    (profile) => profile.account_name !== primaryAccountName && profile.credential_configured,
  );''',
    '''  const fallbackProfiles = accountProfiles.filter(
    (profile) => profile.account_name !== primaryAccountName
      && profile.credential_configured
      && Boolean(getStoredUploadContext(profile.account_name)),
  );''',
    'ready fallback profile filter',
)
app = replace_once(
    app,
    "${tokenReady ? '' : ' 保存 OpenAPI Token 后可上传 50 MB 图片。'}",
    "${primaryTokenReady ? '' : ' 主账号保存 OpenAPI Token 后可上传 50 MB 图片。'}",
    'primary token upload warning',
)
app = replace_once(
    app,
    '''    id: string,
    uploadAccountName: string,
    contextAccountName: string,
    deferRefresh = false,''',
    '''    id: string,
    uploadAccountName: string,
    deferRefresh = false,''',
    'uploadOne signature',
)
app = replace_once(
    app,
    '''        item.category,
        item.tags || [],
        contextAccountName,
      );''',
    '''        item.category,
        item.tags || [],
      );''',
    'uploadImage context argument',
)
app = replace_once(
    app,
    '''        ? profiles.filter((profile) => profile.account_name !== targetPrimary && profile.credential_configured)
        : []),''',
    '''        ? profiles.filter((profile) => profile.account_name !== targetPrimary
          && profile.credential_configured
          && Boolean(getStoredUploadContext(profile.account_name)))
        : []),''',
    'routing fallback context filter',
)
app = replace_once(
    app,
    '''      const result = await uploadOne(
        item.id,
        item.uploadAccountName || targetPrimary,
        targetPrimary,
        true,
      );''',
    '''      const result = await uploadOne(
        item.id,
        item.uploadAccountName || targetPrimary,
        true,
      );''',
    'stored result uploader call',
)
app = replace_once(
    app,
    'const result = await uploadOne(item.id, candidate.profile.account_name, targetPrimary, true);',
    'const result = await uploadOne(item.id, candidate.profile.account_name, true);',
    'candidate uploader call',
)
app = app.replace("<span>{tokenReady ? 'Token 增强模式' : '无 Token 基础模式'}</span>", "<span>{primaryTokenReady ? '主账号 Token 增强模式' : '主账号基础模式'}</span>")
app = replace_once(
    app,
    '主账号负责当天文档；主账号额度用满后，已登录从账号会自动接力上传，图片仍统一写入主账号当天文档。',
    '主账号负责当天文档；主账号额度用满后，已登录且已绑定上传上下文的从账号会自动接力，图片仍统一写入主账号当天文档。',
    'queue routing note',
)
app = replace_once(
    app,
    '从账号只要求登录语雀，可不配置 Token；无 Token 从账号只处理不超过 10 MB 的图片。',
    '从账号无需 Token，但必须登录并绑定一个自己有权限的上传文档；无 Token 从账号只处理不超过 10 MB 的图片。',
    'failover toggle note',
)
app = replace_once(
    app,
    '''<p className="panel-note">从账号顺序：{fallbackProfiles.length ? fallbackProfiles.map((profile) => profile.account_name).join(' → ') : '暂无其他已登录账号'}。从账号若单独配置上传上下文会优先使用；否则复用主账号当天文档上下文。</p>''',
    '''<p className="panel-note">可接力从账号顺序：{fallbackProfiles.length ? fallbackProfiles.map((profile) => profile.account_name).join(' → ') : '暂无已登录且已绑定上传上下文的从账号'}。从账号不需要 Token，但上传上下文必须是该账号有权限访问的文档。</p>''',
    'fallback profile settings note',
)
app = replace_once(
    app,
    '主账号自动使用当天文档；从账号可以留空并复用主账号上下文，也可以单独绑定有权限的文档。',
    '主账号自动使用当天文档；每个从账号需单独绑定一个自己有权限的文档作为上传上下文，但不要求配置 Token。',
    'upload context panel description',
)
app_path.write_text(app, encoding='utf-8')

bridge_path = Path('src/lib/tauri.ts')
bridge = bridge_path.read_text(encoding='utf-8')
bridge = replace_once(
    bridge,
    '''  category: string,
  tags: string[],
  contextAccountName = accountName,
): Promise<UploadResult> {
  const context = getStoredUploadContext(accountName) || getStoredUploadContext(contextAccountName);
  if (!context) {
    throw new Error(
      `账号“${accountName}”没有可用上传上下文；请先为主账号“${contextAccountName}”创建当天文档，或为该账号单独验证一个语雀文档 URL。`,
    );
  }''',
    '''  category: string,
  tags: string[],
): Promise<UploadResult> {
  const context = getStoredUploadContext(accountName);
  if (!context) {
    throw new Error(
      `账号“${accountName}”尚未绑定自己有权限的上传上下文文档；从账号可以不配置 Token，但必须先验证一个可访问的语雀文档 URL。`,
    );
  }''',
    'account-owned upload context',
)
bridge_path.write_text(bridge, encoding='utf-8')
