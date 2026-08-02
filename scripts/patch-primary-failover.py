from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected one regex match, found {count}")
    return next_text


# Rust quota: switch from rolling 60 minutes to fixed top-of-hour windows.
path = Path('src-tauri/src/database.rs')
text = path.read_text(encoding='utf-8')
text = regex_once(
    text,
    r"pub fn upload_quota_status\(path: &Path, account_name: &str\) -> Result<UploadQuotaStatus, String> \{.*?pub fn mark_upload_attempt_success",
    '''pub fn upload_quota_status(path: &Path, account_name: &str) -> Result<UploadQuotaStatus, String> {
    upload_quota_status_at(path, account_name, unix_timestamp())
}

fn upload_quota_status_at(
    path: &Path,
    account_name: &str,
    now: i64,
) -> Result<UploadQuotaStatus, String> {
    let connection = open_connection(path)?;
    let window_start = hourly_window_start(now);
    let next_reset = window_start + 3_600;
    connection
        .execute(
            "DELETE FROM upload_attempts WHERE attempted_at < ?1",
            [window_start - 86_400],
        )
        .map_err(|error| error.to_string())?;

    let used: i64 = connection
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM upload_attempts
            WHERE account_name = ?1
              AND attempted_at >= ?2
              AND attempted_at < ?3
            "#,
            params![account_name, window_start, next_reset],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    let remaining = (UPLOAD_HOURLY_LIMIT - used).max(0);
    let retry_after_seconds = if remaining <= 0 {
        (next_reset - now).max(1)
    } else {
        0
    };
    let reset_at = DateTime::<Utc>::from_timestamp(next_reset, 0)
        .map(|value| value.to_rfc3339());

    Ok(UploadQuotaStatus {
        account_name: account_name.to_string(),
        used,
        limit: UPLOAD_HOURLY_LIMIT,
        remaining,
        retry_after_seconds,
        reset_at,
        minimum_interval_seconds: UPLOAD_MINIMUM_INTERVAL_SECONDS,
    })
}

fn hourly_window_start(timestamp: i64) -> i64 {
    timestamp.div_euclid(3_600) * 3_600
}

pub fn record_upload_attempt(path: &Path, account_name: &str) -> Result<i64, String> {
    record_upload_attempt_at(path, account_name, unix_timestamp())
}

fn record_upload_attempt_at(
    path: &Path,
    account_name: &str,
    attempted_at: i64,
) -> Result<i64, String> {
    let connection = open_connection(path)?;
    connection
        .execute(
            "INSERT INTO upload_attempts (account_name, attempted_at, succeeded) VALUES (?1, ?2, 0)",
            params![account_name, attempted_at],
        )
        .map_err(|error| error.to_string())?;
    Ok(connection.last_insert_rowid())
}

pub fn mark_upload_attempt_success''',
    'fixed hourly quota implementation',
)
text = regex_once(
    text,
    r"    #\[test\]\n    fn reports_hourly_quota_without_per_image_spacing\(\) \{.*?\n    \}\n\}",
    '''    #[test]
    fn reports_hourly_quota_without_per_image_spacing() {
        let path = temporary_database();
        initialize(&path).unwrap();
        let now = 1_800_000_123;
        let before = upload_quota_status_at(&path, "default", now).unwrap();
        assert_eq!(before.used, 0);
        let id = record_upload_attempt_at(&path, "default", now).unwrap();
        mark_upload_attempt_success(&path, id).unwrap();
        let after = upload_quota_status_at(&path, "default", now).unwrap();
        assert_eq!(after.used, 1);
        assert_eq!(after.retry_after_seconds, 0);
        assert_eq!(after.minimum_interval_seconds, 0);
        cleanup_database(&path);
    }

    #[test]
    fn resets_quota_at_the_next_full_hour() {
        let path = temporary_database();
        initialize(&path).unwrap();
        let hour_start = 1_800_000_000;
        record_upload_attempt_at(&path, "default", hour_start + 3_599).unwrap();

        let before_reset = upload_quota_status_at(&path, "default", hour_start + 3_599).unwrap();
        assert_eq!(before_reset.used, 1);
        assert_eq!(before_reset.reset_at.as_deref(), Some("2027-01-15T08:00:00+00:00"));

        let after_reset = upload_quota_status_at(&path, "default", hour_start + 3_600).unwrap();
        assert_eq!(after_reset.used, 0);
        assert_eq!(after_reset.remaining, UPLOAD_HOURLY_LIMIT);
        cleanup_database(&path);
    }
}''',
    'quota tests',
)
path.write_text(text, encoding='utf-8')

# Rust user-facing quota error.
path = Path('src-tauri/src/lib.rs')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    '"当前账号过去一小时已达到 {} 次上传尝试，请在 {reset} 后继续。",',
    '"当前账号本整点小时已达到 {} 次上传尝试；额度会在 {reset} 整点重置。",',
    'quota error wording',
)
path.write_text(text, encoding='utf-8')

# Frontend bridge: allow a fallback account to reuse the primary document context.
path = Path('src/lib/tauri.ts')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    '''  category: string,
  tags: string[],
): Promise<UploadResult> {
  const context = getStoredUploadContext(accountName);
  if (!context) {
    throw new Error(
      `账号“${accountName}”尚未配置上传上下文文档，请前往设置验证一个有权限的语雀文档 URL。`,
    );
  }
''',
    '''  category: string,
  tags: string[],
  contextAccountName = accountName,
): Promise<UploadResult> {
  const context = getStoredUploadContext(accountName) || getStoredUploadContext(contextAccountName);
  if (!context) {
    throw new Error(
      `账号“${accountName}”没有可用上传上下文；请先为主账号“${contextAccountName}”创建当天文档，或为该账号单独验证一个语雀文档 URL。`,
    );
  }
''',
    'upload context fallback',
)
path.write_text(text, encoding='utf-8')

# Persist actual uploader and successful result so document-sync retries do not re-upload through another account.
path = Path('src/types.ts')
text = path.read_text(encoding='utf-8')
text = replace_once(text, '  accountName: string;\n  category: string;', '  accountName: string;\n  uploadAccountName?: string;\n  category: string;', 'queue actual account')
text = replace_once(text, "  status: 'waiting' | 'scheduled' | 'failed';\n  error?: string;", "  status: 'waiting' | 'scheduled' | 'failed';\n  result?: UploadResult;\n  error?: string;", 'stored queue result')
path.write_text(text, encoding='utf-8')

path = Path('src/lib/uploadQueueStore.ts')
text = path.read_text(encoding='utf-8')
text = replace_once(text, '    accountName: item.accountName,\n    category: item.category,', '    accountName: item.accountName,\n    uploadAccountName: item.uploadAccountName,\n    category: item.category,', 'persist actual uploader')
text = replace_once(text, '    status,\n    error: item.error,', '    status,\n    result: item.result,\n    error: item.error,', 'persist result')
path.write_text(text, encoding='utf-8')

# Main frontend routing implementation.
path = Path('src/App.tsx')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    'const AUTO_UPLOAD_DELAY_MS = 60 * 60 * 1000;\n',
    "const PRIMARY_ACCOUNT_STORAGE_KEY = 'quepic-primary-account';\nconst ACCOUNT_FAILOVER_STORAGE_KEY = 'quepic-account-failover';\n",
    'routing constants',
)
text = replace_once(
    text,
    "          {` · ${item.category}`}\n        </small>",
    "          {` · ${item.category}`}\n        </small>\n        {item.uploadAccountName && <small>实际上传账号：{item.uploadAccountName}</small>}",
    'queue actual account display',
)
text = replace_once(
    text,
    '  const [accountProfiles, setAccountProfiles] = useState<AccountProfile[]>([]);\n  const [accountSwitching, setAccountSwitching] = useState(false);',
    '''  const [accountProfiles, setAccountProfiles] = useState<AccountProfile[]>([]);
  const [primaryAccountName, setPrimaryAccountName] = useState(
    () => localStorage.getItem(PRIMARY_ACCOUNT_STORAGE_KEY)?.trim() || initialAccount,
  );
  const [accountFailoverEnabled, setAccountFailoverEnabled] = useState(
    () => localStorage.getItem(ACCOUNT_FAILOVER_STORAGE_KEY) !== 'false',
  );
  const [accountSwitching, setAccountSwitching] = useState(false);''',
    'routing state',
)
text = replace_once(
    text,
    '''  useEffect(() => {
    void Promise.all([refreshProfiles(), loadAccountContext(initialAccount)]);
  }, [initialAccount, loadAccountContext, refreshProfiles]);
''',
    '''  useEffect(() => {
    void Promise.all([refreshProfiles(), loadAccountContext(initialAccount)]);
  }, [initialAccount, loadAccountContext, refreshProfiles]);

  useEffect(() => {
    if (accountProfiles.length === 0) return;
    if (accountProfiles.some((profile) => profile.account_name === primaryAccountName)) return;
    const nextPrimary = accountProfiles.find((profile) => profile.token_configured)?.account_name
      || accountProfiles.find((profile) => profile.credential_configured)?.account_name
      || accountProfiles[0].account_name;
    setPrimaryAccountName(nextPrimary);
    localStorage.setItem(PRIMARY_ACCOUNT_STORAGE_KEY, nextPrimary);
  }, [accountProfiles, primaryAccountName]);
''',
    'primary account normalization',
)
text = regex_once(
    text,
    r"  const activeQueue = useMemo\(.*?  const cachePercent = cacheStats\.asset_count > 0\n    \? Math\.round\(\(cacheStats\.cached_count / cacheStats\.asset_count\) \* 100\)\n    : 0;",
    '''  const activeQueue = queue;
  const pendingUploadCount = activeQueue.filter((item) => ['waiting', 'failed', 'scheduled'].includes(item.status)).length;
  const scheduledUploadCount = activeQueue.filter((item) => item.status === 'scheduled').length;
  const nextScheduledAt = activeQueue
    .filter((item) => item.status === 'scheduled' && item.scheduledAt)
    .reduce<number | null>((earliest, item) => earliest === null ? item.scheduledAt : Math.min(earliest, item.scheduledAt || earliest), null);
  const primaryProfile = accountProfiles.find((profile) => profile.account_name === primaryAccountName);
  const primaryCredentialReady = primaryProfile?.credential_configured
    ?? (primaryAccountName === accountName && credentialReady);
  const primaryTokenReady = primaryProfile?.token_configured
    ?? (primaryAccountName === accountName && tokenReady);
  const fallbackProfiles = accountProfiles.filter(
    (profile) => profile.account_name !== primaryAccountName && profile.credential_configured,
  );
  const maxUploadBytes = primaryTokenReady ? TOKEN_MAX_UPLOAD_BYTES : NO_TOKEN_MAX_UPLOAD_BYTES;
  const maxUploadMegabytes = maxUploadBytes / 1024 / 1024;
  const cachePercent = cacheStats.asset_count > 0
    ? Math.round((cacheStats.cached_count / cacheStats.asset_count) * 100)
    : 0;''',
    'queue and routing derived state',
)
text = replace_once(text, '    const account = activeAccountRef.current;\n', '    const account = primaryAccountName;\n', 'queue ownership')
text = regex_once(
    text,
    r"  const prepareUploadContextForAccount = useCallback\(async \(targetAccount: string\) => \{.*?\n  \}, \[\]\);",
    '''  const preparePrimaryUploadContext = useCallback(async (targetAccount: string) => {
    const token = await getOpenApiTokenStatus(targetAccount);
    if (!token.configured) return false;
    const document = await ensureDailyImageDocument(targetAccount);
    const context = getStoredUploadContext(targetAccount);
    if (!document || !context) return false;
    if (activeAccountRef.current === targetAccount) {
      setUploadContext(context);
      setUploadContextInput(context.document_url);
    }
    return true;
  }, []);''',
    'primary context preparation',
)
text = regex_once(
    text,
    r"  const uploadOne = useCallback\(async \(id: string, deferRefresh = false\) => \{.*?\n  \}, \[markQueueItem, refreshAccountStatus, refreshAssets, refreshCacheStats, refreshProfiles\]\);",
    '''  const uploadOne = useCallback(async (
    id: string,
    uploadAccountName: string,
    contextAccountName: string,
    deferRefresh = false,
  ) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item || item.status === 'uploading' || item.status === 'success') return null;
    if (item.result) {
      markQueueItem(id, {
        status: 'success',
        uploadAccountName: item.uploadAccountName || uploadAccountName,
        scheduledAt: null,
        error: undefined,
      });
      await removeStoredQueueItem(id);
      return item.result;
    }
    const credential = await getCredentialStatus(uploadAccountName);
    if (!credential.configured) {
      const failed = markQueueItem(id, {
        status: 'failed',
        uploadAccountName,
        scheduledAt: null,
        error: `账号“${uploadAccountName}”尚未保存有效语雀会话。`,
      });
      if (failed) await saveStoredQueueItem(toStoredQueueItem(failed));
      return null;
    }

    markQueueItem(id, { status: 'uploading', uploadAccountName, scheduledAt: null, error: undefined });
    try {
      const result = await uploadImage(
        item.file,
        uploadAccountName,
        item.width,
        item.height,
        item.category,
        item.tags || [],
        contextAccountName,
      );
      markQueueItem(id, {
        status: 'success',
        result,
        uploadAccountName,
        scheduledAt: null,
        error: undefined,
      });
      await removeStoredQueueItem(id);
      if (!deferRefresh) {
        await Promise.all([refreshAssets(), refreshCacheStats(), refreshProfiles()]);
        if (activeAccountRef.current === uploadAccountName) {
          await refreshAccountStatus(uploadAccountName);
        }
      }
      return result;
    } catch (error) {
      const failed = markQueueItem(id, {
        status: 'failed',
        uploadAccountName,
        scheduledAt: null,
        error: `账号“${uploadAccountName}”上传失败：${normalizeError(error)}`,
      });
      if (failed) await saveStoredQueueItem(toStoredQueueItem(failed));
      if (!deferRefresh && activeAccountRef.current === uploadAccountName) {
        await refreshAccountStatus(uploadAccountName);
      }
      return null;
    }
  }, [markQueueItem, refreshAccountStatus, refreshAssets, refreshCacheStats, refreshProfiles]);''',
    'routable upload one',
)
text = regex_once(
    text,
    r"  const retryUploadOne = useCallback\(async \(id: string\) => \{.*?\n  \}, \[markQueueItem, persistDailyDocumentSyncFailure, prepareUploadContextForAccount, refreshAccountStatus, refreshAssets, refreshCacheStats, refreshProfiles, rescheduleItems, showToast, uploadOne\]\);",
    '''  const scheduleRemaining = async () => {
    const scheduledAt = nextHourlyResetTimestamp();
    const updated: UploadQueueItem[] = [];
    commitQueue((current) => current.map((item) => {
      if (!['waiting', 'failed', 'scheduled'].includes(item.status)) return item;
      const next: UploadQueueItem = { ...item, status: 'scheduled', scheduledAt, error: undefined };
      updated.push(next);
      return next;
    }));
    if (updated.length === 0) return showToast('error', '当前队列没有可计划的剩余图片。');
    try {
      await saveStoredQueueItems(updated.map(toStoredQueueItem));
      showToast('success', `已将 ${updated.length} 张图片安排到下一整点 ${formatScheduleTime(scheduledAt)} 自动上传。`);
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  };

  const rescheduleItems = useCallback(async (items: UploadQueueItem[], scheduledAt: number, reason?: string) => {
    const ids = new Set(items.map((item) => item.id));
    const updated: UploadQueueItem[] = [];
    commitQueue((current) => current.map((item) => {
      if (!ids.has(item.id)) return item;
      const next: UploadQueueItem = { ...item, status: 'scheduled', scheduledAt, error: reason };
      updated.push(next);
      return next;
    }));
    await saveStoredQueueItems(updated.map(toStoredQueueItem));
  }, [commitQueue]);

  const resolveRoutingCandidates = useCallback(async (targetPrimary: string) => {
    const profiles = await listAccountProfiles();
    const primary = profiles.find((profile) => profile.account_name === targetPrimary);
    if (!primary?.credential_configured) {
      throw new Error(`主账号“${targetPrimary}”尚未登录语雀。`);
    }
    if (!primary.token_configured) {
      throw new Error(`主账号“${targetPrimary}”必须配置 OpenAPI Token。`);
    }
    const ordered = [
      primary,
      ...(accountFailoverEnabled
        ? profiles.filter((profile) => profile.account_name !== targetPrimary && profile.credential_configured)
        : []),
    ];
    const quotas = await Promise.all(ordered.map((profile) => getUploadQuotaStatus(profile.account_name)));
    return ordered.map((profile, index) => ({
      profile,
      quota: quotas[index],
      maxUploadBytes: profile.token_configured ? TOKEN_MAX_UPLOAD_BYTES : NO_TOKEN_MAX_UPLOAD_BYTES,
    }));
  }, [accountFailoverEnabled]);

  const processUploadBatch = useCallback(async (items: UploadQueueItem[], announce: boolean) => {
    const targetPrimary = primaryAccountName.trim() || DEFAULT_ACCOUNT;
    if (!(await preparePrimaryUploadContext(targetPrimary))) {
      throw new Error(`主账号“${targetPrimary}”必须配置 Token，才能创建当天文档并作为上传主账号。`);
    }
    const candidates = await resolveRoutingCandidates(targetPrimary);
    const remaining = [...items];
    const dailyImages: DailyDocumentImage[] = [];
    const dailyItems: UploadQueueItem[] = [];
    const routedCounts = new Map<string, number>();
    let successCount = 0;
    let deduplicatedCount = 0;
    let failedCount = 0;

    for (const item of [...remaining]) {
      if (!item.result) continue;
      remaining.splice(remaining.findIndex((candidate) => candidate.id === item.id), 1);
      const result = await uploadOne(
        item.id,
        item.uploadAccountName || targetPrimary,
        targetPrimary,
        true,
      );
      if (!result) {
        failedCount += 1;
        continue;
      }
      successCount += 1;
      deduplicatedCount += 1;
      dailyImages.push({ asset_id: result.asset.id, file_name: item.file.name, remote_url: result.asset.remote_url });
      dailyItems.push(item);
    }

    for (const candidate of candidates) {
      let available = candidate.quota.remaining;
      if (available <= 0) continue;
      let index = 0;
      while (index < remaining.length && available > 0) {
        const item = remaining[index];
        if (item.file.size > candidate.maxUploadBytes) {
          index += 1;
          continue;
        }
        remaining.splice(index, 1);
        const result = await uploadOne(item.id, candidate.profile.account_name, targetPrimary, true);
        if (!result) {
          failedCount += 1;
          continue;
        }
        successCount += 1;
        if (result.deduplicated) deduplicatedCount += 1;
        else available -= 1;
        routedCounts.set(
          candidate.profile.account_name,
          (routedCounts.get(candidate.profile.account_name) || 0) + 1,
        );
        dailyImages.push({ asset_id: result.asset.id, file_name: item.file.name, remote_url: result.asset.remote_url });
        dailyItems.push(item);
      }
    }

    let scheduledAt: number | null = null;
    if (remaining.length > 0) {
      scheduledAt = nextHourlyResetTimestamp();
      await rescheduleItems(
        remaining,
        scheduledAt,
        '所有可用账号的本整点额度已用完，等待下一整点重置',
      );
    }

    await Promise.all([refreshAssets(), refreshCacheStats(), refreshProfiles()]);
    if (activeAccountRef.current) await refreshAccountStatus(activeAccountRef.current);

    let dailyDocumentTitle = '';
    let dailyDocumentError = '';
    if (dailyImages.length > 0) {
      try {
        dailyDocumentTitle = (await appendImagesToDailyDocument(targetPrimary, dailyImages))?.title || '';
      } catch (error) {
        dailyDocumentError = await persistDailyDocumentSyncFailure(dailyItems, error);
      }
    }

    const summary: string[] = [];
    if (successCount > 0) summary.push(`成功处理 ${successCount} 张`);
    if (routedCounts.size > 0) {
      summary.push(Array.from(routedCounts.entries()).map(([name, count]) => `${name} ${count} 张`).join('、'));
    }
    if (deduplicatedCount > 0) summary.push(`${deduplicatedCount} 张复用历史链接`);
    if (failedCount > 0) summary.push(`${failedCount} 张上传失败`);
    if (remaining.length > 0 && scheduledAt) summary.push(`${remaining.length} 张将在 ${formatScheduleTime(scheduledAt)} 继续`);
    if (dailyDocumentTitle) summary.push(`已写入主账号当天文档“${dailyDocumentTitle}”`);
    const message = summary.join('，') || '没有需要处理的图片。';
    if (dailyDocumentError) {
      showToast('error', `${message}；当天文档同步失败：${dailyDocumentError}`);
    } else if (announce) {
      showToast(failedCount > 0 ? 'error' : 'success', message);
    }
  }, [
    persistDailyDocumentSyncFailure,
    preparePrimaryUploadContext,
    primaryAccountName,
    refreshAccountStatus,
    refreshAssets,
    refreshCacheStats,
    refreshProfiles,
    rescheduleItems,
    resolveRoutingCandidates,
    showToast,
    uploadOne,
  ]);

  const retryUploadOne = useCallback(async (id: string) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    try {
      await processUploadBatch([item], true);
    } catch (error) {
      setView('settings');
      showToast('error', normalizeError(error));
    }
  }, [processUploadBatch, showToast]);

  const uploadAll = async () => {
    const pendingItems = queueRef.current.filter((item) => ['waiting', 'failed', 'scheduled'].includes(item.status));
    if (pendingItems.length === 0) return showToast('error', '当前队列没有等待上传的图片。');
    try {
      await processUploadBatch(pendingItems, true);
    } catch (error) {
      setView('settings');
      showToast('error', normalizeError(error));
    }
  };

  const runDueUploads = useCallback(async () => {
    if (autoUploadRunningRef.current) return;
    const due = queueRef.current.filter((item) => item.status === 'scheduled' && (item.scheduledAt || 0) <= Date.now());
    if (due.length === 0) return;
    autoUploadRunningRef.current = true;
    try {
      await processUploadBatch(due, false);
    } catch (error) {
      const retryAt = Date.now() + 5 * 60 * 1000;
      try {
        await rescheduleItems(due, retryAt, '自动检查失败，五分钟后重试');
      } catch {
        // 保留原错误；持久队列写入失败会在下一次状态变化时再次暴露。
      }
      showToast('error', `自动上传失败：${normalizeError(error)}`);
    } finally {
      autoUploadRunningRef.current = false;
    }
  }, [processUploadBatch, rescheduleItems, showToast]);''',
    'replace queue routing flow',
)
text = replace_once(
    text,
    "    const completed = queueRef.current.filter((item) => item.accountName === accountName && item.status === 'success');",
    "    const completed = queueRef.current.filter((item) => item.status === 'success');",
    'clear global completed queue',
)
text = replace_once(
    text,
    "    upload: { title: '上传图片', description: '选择上传账号，所有上传结果统一进入共享图库。' },",
    "    upload: { title: '上传图片', description: '主账号优先上传，额度用满后由已登录从账号自动接力。' },",
    'upload page description',
)
text = replace_once(text, '<span>140 张/小时</span><span>额度内连续上传</span>', '<span>每账号 140 张/整点小时</span><span>主账号优先 · 从账号接力</span>', 'drop hints')
text = replace_once(
    text,
    '''                  <div><span>UPLOAD QUEUE · {accountName}</span><h2>上传图片队列</h2><p>{pendingUploadCount ? `${pendingUploadCount} 项等待处理` : '没有待处理任务'}</p></div>
                  <div className="queue-heading-actions">
                    <button className="button secondary compact" disabled={pendingUploadCount === 0} onClick={() => void scheduleRemaining()}><CalendarClock size={16} />全部延后 1 小时</button>
                    <button className="button primary compact" disabled={!credentialReady || (!uploadContext && !tokenReady) || pendingUploadCount === 0} onClick={() => void uploadAll()}><UploadCloud size={16} />立即上传本批</button>
                  </div>''',
    '''                  <div><span>UPLOAD ROUTER · 主账号 {primaryAccountName}</span><h2>上传图片队列</h2><p>{pendingUploadCount ? `${pendingUploadCount} 项等待处理` : '没有待处理任务'}</p></div>
                  <div className="queue-heading-actions">
                    <button className="button secondary compact" disabled={pendingUploadCount === 0} onClick={() => void scheduleRemaining()}><CalendarClock size={16} />延后到下一整点</button>
                    <button className="button primary compact" disabled={!primaryCredentialReady || !primaryTokenReady || pendingUploadCount === 0} onClick={() => void uploadAll()}><UploadCloud size={16} />主账号优先上传</button>
                  </div>''',
    'queue heading routing',
)
text = replace_once(
    text,
    '''                  <span>{quota ? `过去一小时已使用 ${quota.used}/${quota.limit}，剩余 ${quota.remaining}` : '正在读取上传额度'}</span>
                  {quota?.retry_after_seconds ? <b>{formatDuration(quota.retry_after_seconds)} 后进入下一批</b> : <b>额度内连续上传</b>}''',
    '''                  <span>{accountName === primaryAccountName && quota ? `主账号本整点已使用 ${quota.used}/${quota.limit}，剩余 ${quota.remaining}` : `主账号 ${primaryAccountName}，从账号 ${accountFailoverEnabled ? '自动接力' : '未启用'}`}</span>
                  <b>每小时整点重置</b>''',
    'quota strip',
)
text = replace_once(
    text,
    '<div className="queue-schedule-banner"><CalendarClock size={16} /><span>下一批自动上传：{formatScheduleTime(nextScheduledAt)}</span><small>本小时额度内会连续处理；超出部分保留到下一额度窗口。应用关闭后会在下次启动补传。</small></div>',
    '<div className="queue-schedule-banner"><CalendarClock size={16} /><span>下一批自动上传：{formatScheduleTime(nextScheduledAt)}</span><small>所有账号在整点统一进入新额度窗口；应用关闭后会在下次启动补传。</small></div>',
    'schedule banner',
)
text = replace_once(
    text,
    '''                {!credentialReady && <div className="warning">当前账号尚未保存语雀会话；队列可继续添加，但到点后会暂停并提示登录。</div>}
                {credentialReady && !uploadContext && !tokenReady && <div className="warning">当前账号没有 Token，请在设置中手动验证一个有权限访问的语雀文档 URL。</div>}
                {credentialReady && !uploadContext && tokenReady && <div className="queue-auto-context-note">首次上传时会自动创建今天日期的 Markdown 文档，并将其绑定为上传上下文。</div>}''',
    '''                {!primaryCredentialReady && <div className="warning">主账号“{primaryAccountName}”尚未保存语雀会话。</div>}
                {primaryCredentialReady && !primaryTokenReady && <div className="warning">主账号“{primaryAccountName}”必须配置 OpenAPI Token；从账号可以不配置 Token。</div>}
                {primaryCredentialReady && primaryTokenReady && <div className="queue-auto-context-note">主账号负责当天文档；主账号额度用满后，已登录从账号会自动接力上传，图片仍统一写入主账号当天文档。</div>}''',
    'routing warnings',
)
text = replace_once(text, '<p>当前账号的待上传图片会显示在这里。</p>', '<p>主账号与从账号共同处理的全局上传队列会显示在这里。</p>', 'global queue empty')
text = replace_once(text, '<div><strong>{quota ? `${quota.remaining}/${quota.limit}` : \'--\'} 张可用</strong><small>滚动一小时上传额度</small></div>', '<div><strong>{quota ? `${quota.remaining}/${quota.limit}` : \'--\'} 张可用</strong><small>当前账号 · 整点重置额度</small></div>', 'sidebar quota wording')
text = replace_once(
    text,
    '''                <div className="panel settings-panel">
                  <div className="panel-heading"><div><span>YUQUE ACCOUNT</span><h2>语雀登录</h2><p>当前账号：{accountName}。登录会话用于上传图片和私有图片回源。</p></div><div className={credentialReady ? 'status ready-status' : 'status'}>{credentialReady ? <CheckCircle2 size={15} /> : <KeyRound size={15} />}{credentialReady ? '已连接' : '未连接'}</div></div>''',
    '''                <div className="panel settings-panel">
                  <div className="panel-heading"><div><span>UPLOAD ROUTING</span><h2>主账号与自动接力</h2><p>主账号平时优先使用并负责当天文档；额度用满后，从账号按账号列表顺序接力。</p></div><Gauge size={20} /></div>
                  <label className="field"><span>主账号</span><select value={primaryAccountName} onChange={(event) => { const value = event.target.value; setPrimaryAccountName(value); localStorage.setItem(PRIMARY_ACCOUNT_STORAGE_KEY, value); }}>{accountProfiles.map((profile) => <option key={profile.account_name} value={profile.account_name}>{profile.account_name}{profile.token_configured ? ' · Token' : ''}</option>)}</select><small>主账号必须同时保存登录会话和 OpenAPI Token。</small></label>
                  <label className="toggle-row">
                    <span><UserRound size={17} /><span><strong>主账号用满后自动使用从账号</strong><small>从账号只要求登录语雀，可不配置 Token；无 Token 从账号只处理不超过 10 MB 的图片。</small></span></span>
                    <input className="switch-input" type="checkbox" checked={accountFailoverEnabled} onChange={(event) => { setAccountFailoverEnabled(event.target.checked); localStorage.setItem(ACCOUNT_FAILOVER_STORAGE_KEY, String(event.target.checked)); }} />
                  </label>
                  {!primaryProfile?.credential_configured && <div className="warning">所选主账号尚未登录语雀。</div>}
                  {primaryProfile?.credential_configured && !primaryProfile.token_configured && <div className="warning">所选主账号没有 Token，自动路由不会启动。</div>}
                  <p className="panel-note">从账号顺序：{fallbackProfiles.length ? fallbackProfiles.map((profile) => profile.account_name).join(' → ') : '暂无其他已登录账号'}。从账号若单独配置上传上下文会优先使用；否则复用主账号当天文档上下文。</p>
                </div>

                <div className="panel settings-panel">
                  <div className="panel-heading"><div><span>YUQUE ACCOUNT</span><h2>语雀登录</h2><p>当前账号：{accountName}。登录会话用于上传图片和私有图片回源。</p></div><div className={credentialReady ? 'status ready-status' : 'status'}>{credentialReady ? <CheckCircle2 size={15} /> : <KeyRound size={15} />}{credentialReady ? '已连接' : '未连接'}</div></div>''',
    'routing settings panel',
)
text = replace_once(text, '<p>每个账号绑定自己有权限的语雀文档，作为图片上传的文档上下文。</p>', '<p>主账号自动使用当天文档；从账号可以留空并复用主账号上下文，也可以单独绑定有权限的文档。</p>', 'upload context explanation')
text = replace_once(text, '<p>当前小时额度内连续上传；额度用完后，剩余任务自动进入下一批。</p>', '<p>每个账号的额度在整点重置；主账号用满后立即切换到从账号。</p>', 'quota panel heading')
text = replace_once(text, '<div><strong>{quota?.used ?? 0}</strong><small>过去一小时尝试</small></div>', '<div><strong>{quota?.used ?? 0}</strong><small>本整点小时尝试</small></div>', 'quota metric label')
text = replace_once(
    text,
    '不再对每张图片设置固定秒级等待。失败请求仍计入本地小时额度；无 Token 单图上限 10 MB，保存 Token 后为 50 MB。超出当前额度的队列任务会自动安排到下一窗口。',
    '不再对每张图片设置固定秒级等待。失败请求仍计入当前整点小时额度；无 Token 单图上限 10 MB，保存 Token 后为 50 MB。主账号和从账号都用满后，剩余任务安排到下一整点。',
    'quota note',
)
text = replace_once(text, '<li>上传队列、Cookie、Token 和小时额度仍按账号隔离。</li>', '<li>Cookie、Token 和整点小时额度按账号隔离；上传队列由主账号统一调度。</li>', 'guide routing')
text = regex_once(
    text,
    r"function resolveRetryTimestamp\(value: string \| null\): number \{.*?\n\}",
    '''function nextHourlyResetTimestamp(now = Date.now()): number {
  const hour = 60 * 60 * 1000;
  return Math.floor(now / hour) * hour + hour + 1_000;
}

function resolveRetryTimestamp(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.max(parsed + 1_000, Date.now() + 1_000)
    : nextHourlyResetTimestamp();
}''',
    'hourly timestamp helpers',
)
path.write_text(text, encoding='utf-8')

# Remove temporary inspection artifacts from the final tree.
for temporary in [
    Path('.github/workflows/inspect-upload-routing.yml'),
    Path('upload-routing-inspection.txt'),
    Path('scripts/patch-primary-failover.py'),
]:
    if temporary.exists():
        temporary.unlink()
