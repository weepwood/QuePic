import { invoke } from '@tauri-apps/api/core';

import type { AppSettings, PortableSettings } from '../types';

const STORAGE_KEYS = new Set([
  'quepic-account',
  'quepic-primary-account',
  'quepic-account-failover',
  'quepic-knowledge-base-url',
  'quepic-document-url',
  'quepic-upload-category',
  'quepic-upload-tags',
  'quepic-library-view',
  'quepic-wordpress-fallback',
]);

const DEFAULT_ACCOUNT = 'default';
const DEFAULT_CATEGORY = '未分类';

let cachedSettings: AppSettings | null = null;
let installed = false;
let suppressStorageSync = false;
let syncTimer: number | null = null;
let syncChain: Promise<AppSettings | null> = Promise.resolve(null);

export async function bootstrapAppSettings(): Promise<AppSettings> {
  const stored = await invoke<AppSettings>('get_app_settings');
  const settings = stored.initialized
    ? stored
    : await invoke<AppSettings>('save_app_settings', {
        settings: snapshotLegacySettings(),
      });
  cachedSettings = settings;
  applySettingsToLocalStorage(settings);
  installLocalStorageBridge();
  return settings;
}

export function getCachedAppSettings(): AppSettings | null {
  return cachedSettings;
}

export async function updateAppSettings(
  patch: Partial<Omit<AppSettings, 'initialized'>>,
): Promise<AppSettings> {
  const base = cachedSettings || snapshotLegacySettings();
  const next: AppSettings = {
    ...base,
    ...patch,
    initialized: true,
  };
  const saved = await invoke<AppSettings>('save_app_settings', { settings: next });
  cachedSettings = saved;
  applySettingsToLocalStorage(saved);
  return saved;
}

export async function replaceAppSettingsFromBackup(
  settings: PortableSettings,
): Promise<AppSettings> {
  return updateAppSettings({
    active_account: settings.active_account || DEFAULT_ACCOUNT,
    primary_account: settings.primary_account || settings.active_account || DEFAULT_ACCOUNT,
    account_failover_enabled: settings.account_failover_enabled !== false,
    knowledge_base_url: settings.knowledge_base_url || '',
    document_url: settings.document_url || '',
    upload_category: settings.upload_category || DEFAULT_CATEGORY,
    upload_tags: settings.upload_tags || '',
    library_view: settings.library_view === 'square' ? 'square' : 'original',
    allow_wordpress_fallback: settings.allow_wordpress_fallback,
  });
}

function snapshotLegacySettings(): AppSettings {
  const activeAccount = localStorage.getItem('quepic-account')?.trim() || DEFAULT_ACCOUNT;
  return {
    initialized: false,
    active_account: activeAccount,
    primary_account: localStorage.getItem('quepic-primary-account')?.trim() || activeAccount,
    account_failover_enabled: localStorage.getItem('quepic-account-failover') !== 'false',
    knowledge_base_url: localStorage.getItem('quepic-knowledge-base-url')?.trim() || '',
    document_url: localStorage.getItem('quepic-document-url')?.trim() || '',
    upload_category: localStorage.getItem('quepic-upload-category')?.trim() || DEFAULT_CATEGORY,
    upload_tags: localStorage.getItem('quepic-upload-tags')?.trim() || '',
    library_view: localStorage.getItem('quepic-library-view') === 'square' ? 'square' : 'original',
    allow_wordpress_fallback: localStorage.getItem('quepic-wordpress-fallback') === 'true',
  };
}

function applySettingsToLocalStorage(settings: AppSettings): void {
  suppressStorageSync = true;
  try {
    writeStorage('quepic-account', settings.active_account);
    writeStorage('quepic-primary-account', settings.primary_account);
    writeStorage('quepic-account-failover', String(settings.account_failover_enabled));
    writeStorage('quepic-knowledge-base-url', settings.knowledge_base_url);
    writeStorage('quepic-document-url', settings.document_url);
    writeStorage('quepic-upload-category', settings.upload_category);
    writeStorage('quepic-upload-tags', settings.upload_tags);
    writeStorage('quepic-library-view', settings.library_view === 'square' ? 'square' : 'original');
    writeStorage('quepic-wordpress-fallback', String(settings.allow_wordpress_fallback));
  } finally {
    suppressStorageSync = false;
  }
}

function writeStorage(key: string, value: string): void {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

function installLocalStorageBridge(): void {
  if (installed) return;
  installed = true;
  const originalSetItem = Storage.prototype.setItem;
  const originalRemoveItem = Storage.prototype.removeItem;

  Storage.prototype.setItem = function setItem(key: string, value: string): void {
    originalSetItem.call(this, key, value);
    if (this === window.localStorage && STORAGE_KEYS.has(key) && !suppressStorageSync) {
      scheduleStorageSync();
    }
  };

  Storage.prototype.removeItem = function removeItem(key: string): void {
    originalRemoveItem.call(this, key);
    if (this === window.localStorage && STORAGE_KEYS.has(key) && !suppressStorageSync) {
      scheduleStorageSync();
    }
  };
}

function scheduleStorageSync(): void {
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    const snapshot = snapshotLegacySettings();
    syncChain = syncChain
      .catch(() => null)
      .then(() => invoke<AppSettings>('save_app_settings', { settings: snapshot }))
      .then((saved) => {
        cachedSettings = saved;
        return saved;
      })
      .catch((error) => {
        window.dispatchEvent(new CustomEvent('quepic:settings-error', { detail: error }));
        return cachedSettings;
      });
  }, 120);
}
