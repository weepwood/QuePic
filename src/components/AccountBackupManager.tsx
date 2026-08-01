import { invoke } from '@tauri-apps/api/core';
import {
  Archive,
  CheckCircle2,
  DatabaseBackup,
  Download,
  HardDrive,
  KeyRound,
  LoaderCircle,
  LogIn,
  Plus,
  RefreshCw,
  ShieldCheck,
  Upload,
  UserRoundCog,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

interface AccountProfile {
  account_name: string;
  credential_configured: boolean;
  token_configured: boolean;
  asset_count: number;
  cached_count: number;
  updated_at: string | null;
}

interface PortableSettings {
  active_account: string;
  allow_wordpress_fallback: boolean;
  upload_category: string;
  book_id: string;
  account_names: string[];
}

interface BackupResult {
  cancelled: boolean;
  path: string | null;
  includes_library: boolean;
  includes_cache: boolean;
}

interface ImportResult {
  cancelled: boolean;
  settings: PortableSettings | null;
  restored_library: boolean;
  restored_cache: boolean;
  restored_cache_files: number;
}

type BusyAction = 'accounts' | 'login' | 'export' | 'import' | null;

const DEFAULT_ACCOUNT = 'default';

export function AccountBackupManager() {
  const [navTarget, setNavTarget] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<AccountProfile[]>([]);
  const [newAccount, setNewAccount] = useState('');
  const [loginTarget, setLoginTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const activeAccount = localStorage.getItem('quepic-account') || DEFAULT_ACCOUNT;

  useEffect(() => {
    let disposed = false;
    let animationFrame = 0;
    const locate = () => {
      const target = document.querySelector<HTMLElement>('.sidebar nav');
      if (target) {
        if (!disposed) setNavTarget(target);
        return;
      }
      animationFrame = window.requestAnimationFrame(locate);
    };
    locate();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  const refreshAccounts = useCallback(async () => {
    setBusy('accounts');
    try {
      await invoke('save_account_profile', { accountName: activeAccount });
      setAccounts(await invoke<AccountProfile[]>('list_account_profiles'));
    } catch (error) {
      setMessage({ type: 'error', text: normalizeError(error) });
    } finally {
      setBusy(null);
    }
  }, [activeAccount]);

  useEffect(() => {
    if (open) void refreshAccounts();
  }, [open, refreshAccounts]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, open]);

  const orderedAccounts = useMemo(() => [...accounts].sort((left, right) => {
    if (left.account_name === activeAccount) return -1;
    if (right.account_name === activeAccount) return 1;
    return left.account_name.localeCompare(right.account_name, 'zh-CN');
  }), [accounts, activeAccount]);

  const createAccount = async () => {
    const accountName = newAccount.trim();
    if (!accountName) return;
    setBusy('accounts');
    setMessage(null);
    try {
      await invoke('save_account_profile', { accountName });
      setNewAccount('');
      setAccounts(await invoke<AccountProfile[]>('list_account_profiles'));
      setMessage({ type: 'success', text: `账号“${accountName}”已创建，可以单独登录并配置 Token。` });
    } catch (error) {
      setMessage({ type: 'error', text: normalizeError(error) });
    } finally {
      setBusy(null);
    }
  };

  const switchAccount = (accountName: string) => {
    if (accountName === activeAccount) return;
    localStorage.setItem('quepic-account', accountName);
    window.location.reload();
  };

  const openLogin = async (accountName: string) => {
    setBusy('login');
    setMessage(null);
    try {
      await invoke('save_account_profile', { accountName });
      await invoke('open_yuque_login');
      setLoginTarget(accountName);
      setMessage({ type: 'success', text: `已为“${accountName}”打开语雀登录窗口。完成登录后点击“保存会话”。` });
    } catch (error) {
      setMessage({ type: 'error', text: normalizeError(error) });
    } finally {
      setBusy(null);
    }
  };

  const captureLogin = async (accountName: string) => {
    setBusy('login');
    setMessage(null);
    try {
      await invoke('capture_yuque_login', { accountName });
      setLoginTarget(null);
      setAccounts(await invoke<AccountProfile[]>('list_account_profiles'));
      setMessage({ type: 'success', text: `账号“${accountName}”的语雀登录会话已安全保存。` });
    } catch (error) {
      setMessage({ type: 'error', text: normalizeError(error) });
    } finally {
      setBusy(null);
    }
  };

  const portableSettings = (): PortableSettings => ({
    active_account: activeAccount,
    allow_wordpress_fallback: localStorage.getItem('quepic-wordpress-fallback') === 'true',
    upload_category: localStorage.getItem('quepic-upload-category') || '未分类',
    book_id: localStorage.getItem('quepic-book-id') || '',
    account_names: accounts.map((account) => account.account_name),
  });

  const exportBackup = async (includeLibrary: boolean, includeCache: boolean) => {
    setBusy('export');
    setMessage(null);
    try {
      const result = await invoke<BackupResult>('export_backup', {
        settings: portableSettings(),
        includeLibrary,
        includeCache,
      });
      if (!result.cancelled) {
        setMessage({
          type: 'success',
          text: result.includes_cache
            ? `完整备份已导出：${result.path}`
            : result.includes_library
              ? `设置和图片索引已导出：${result.path}`
              : `设置备份已导出：${result.path}`,
        });
      }
    } catch (error) {
      setMessage({ type: 'error', text: normalizeError(error) });
    } finally {
      setBusy(null);
    }
  };

  const importBackup = async (fullRestore: boolean) => {
    if (fullRestore && !window.confirm('完整恢复会替换当前图片索引和本地缓存。系统密钥库中的 Cookie 与 Token 不会被覆盖。继续吗？')) {
      return;
    }
    setBusy('import');
    setMessage(null);
    try {
      const result = await invoke<ImportResult>('import_backup', {
        restoreLibrary: fullRestore,
        restoreCache: fullRestore,
      });
      if (result.cancelled || !result.settings) return;
      applyPortableSettings(result.settings);
      setMessage({
        type: 'success',
        text: fullRestore
          ? `完整备份已恢复，共导入 ${result.restored_cache_files} 个缓存文件。应用将重新加载。`
          : '设置和账号列表已导入，应用将重新加载。',
      });
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      setMessage({ type: 'error', text: normalizeError(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {navTarget && createPortal(
        <button className={open ? 'nav-item active' : 'nav-item'} type="button" onClick={() => setOpen(true)}>
          <UserRoundCog size={18} /><span>账号与备份</span><em>{accounts.length || ''}</em>
        </button>,
        navTarget,
      )}

      {open && createPortal(
        <div className="account-backup-backdrop" role="presentation">
          <section className="account-backup-dialog" role="dialog" aria-modal="true" aria-labelledby="account-backup-title">
            <header className="account-backup-header">
              <div><span>ACCOUNT & BACKUP</span><h2 id="account-backup-title">账号与备份</h2><p>切换多个语雀账号，并迁移非敏感设置、图片索引与缓存。</p></div>
              <button type="button" aria-label="关闭" disabled={Boolean(busy)} onClick={() => setOpen(false)}><X size={18} /></button>
            </header>

            <div className="account-backup-body">
              <section className="account-section">
                <div className="section-heading"><div><Users size={20} /><span><strong>语雀账号</strong><small>Cookie、Token 和上传额度按账号隔离</small></span></div><button type="button" onClick={() => void refreshAccounts()} disabled={Boolean(busy)}><RefreshCw className={busy === 'accounts' ? 'spin' : ''} size={15} />刷新</button></div>
                <div className="account-create-row">
                  <input value={newAccount} maxLength={80} onChange={(event) => setNewAccount(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createAccount(); }} placeholder="新账号名称，例如：工作账号" />
                  <button className="button primary compact" type="button" disabled={Boolean(busy) || !newAccount.trim()} onClick={() => void createAccount()}><Plus size={15} />新增账号</button>
                </div>

                <div className="account-list">
                  {orderedAccounts.map((account) => {
                    const active = account.account_name === activeAccount;
                    const completingLogin = loginTarget === account.account_name;
                    return (
                      <article className={active ? 'account-card active' : 'account-card'} key={account.account_name}>
                        <div className="account-card-main">
                          <div className="account-avatar">{account.account_name.slice(0, 1).toUpperCase()}</div>
                          <div><strong>{account.account_name}{active && <b>当前</b>}</strong><small>{account.asset_count} 张图片 · {account.cached_count} 张已缓存</small></div>
                        </div>
                        <div className="account-statuses">
                          <span className={account.credential_configured ? 'ready' : ''}>{account.credential_configured ? <CheckCircle2 size={13} /> : <LogIn size={13} />}登录</span>
                          <span className={account.token_configured ? 'ready' : ''}>{account.token_configured ? <ShieldCheck size={13} /> : <KeyRound size={13} />}Token</span>
                        </div>
                        <div className="account-actions">
                          {!active && <button type="button" disabled={Boolean(busy)} onClick={() => switchAccount(account.account_name)}>切换</button>}
                          <button type="button" disabled={Boolean(busy)} onClick={() => void openLogin(account.account_name)}>打开登录</button>
                          {completingLogin && <button className="primary" type="button" disabled={Boolean(busy)} onClick={() => void captureLogin(account.account_name)}>保存会话</button>}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="backup-section">
                <div className="section-heading"><div><Archive size={20} /><span><strong>导出备份</strong><small>凭据始终留在操作系统密钥库中</small></span></div></div>
                <div className="backup-options">
                  <button type="button" disabled={Boolean(busy)} onClick={() => void exportBackup(false, false)}><Download size={18} /><span><strong>导出设置</strong><small>账号名称、当前账号和界面选项</small></span></button>
                  <button type="button" disabled={Boolean(busy)} onClick={() => void exportBackup(true, false)}><DatabaseBackup size={18} /><span><strong>设置与图片索引</strong><small>增加图片记录、分类和上传额度</small></span></button>
                  <button type="button" disabled={Boolean(busy)} onClick={() => void exportBackup(true, true)}><HardDrive size={18} /><span><strong>完整备份</strong><small>同时打包本地预览与缩略图缓存</small></span></button>
                </div>
              </section>

              <section className="backup-section import-section">
                <div className="section-heading"><div><Upload size={20} /><span><strong>导入备份</strong><small>可只导入设置，也可完整替换本地图片库</small></span></div></div>
                <div className="import-actions">
                  <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => void importBackup(false)}>只导入设置</button>
                  <button className="button danger" type="button" disabled={Boolean(busy)} onClick={() => void importBackup(true)}>完整恢复索引与缓存</button>
                </div>
                <p>备份文件不包含 Cookie 或 OpenAPI Token。迁移到新设备后，需要重新登录语雀并重新保存 Token。</p>
              </section>

              {busy && <div className="account-backup-progress"><LoaderCircle className="spin" size={18} /><span>{busy === 'export' ? '正在生成备份包…' : busy === 'import' ? '正在校验并恢复备份…' : busy === 'login' ? '正在处理登录会话…' : '正在读取账号状态…'}</span></div>}
              {message && <div className={message.type === 'success' ? 'account-backup-message success' : 'account-backup-message error'}>{message.type === 'success' ? <CheckCircle2 size={17} /> : <X size={17} />}<span>{message.text}</span></div>}
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

function applyPortableSettings(settings: PortableSettings) {
  localStorage.setItem('quepic-account', settings.active_account || DEFAULT_ACCOUNT);
  localStorage.setItem('quepic-wordpress-fallback', String(settings.allow_wordpress_fallback));
  localStorage.setItem('quepic-upload-category', settings.upload_category || '未分类');
  if (settings.book_id) localStorage.setItem('quepic-book-id', settings.book_id);
  else localStorage.removeItem('quepic-book-id');
}

function normalizeError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '操作失败，请检查备份文件、系统密钥库和本地目录权限。';
}
