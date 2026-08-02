import {
  Archive,
  DatabaseBackup,
  Download,
  HardDrive,
  LoaderCircle,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import { useState } from 'react';

import { exportBackup, importBackup } from '../lib/backup';
import { setMaintenanceState } from '../lib/maintenance';
import type { PortableSettings } from '../types';

interface BackupManagerProps {
  settings: PortableSettings;
  disabled?: boolean;
  onImported: (settings: PortableSettings) => Promise<void> | void;
  onMessage: (type: 'success' | 'error', message: string) => void;
}

type BusyOperation = 'export' | 'import' | null;

function normalizeError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '备份操作失败。';
}

export function BackupManager({
  settings,
  disabled = false,
  onImported,
  onMessage,
}: BackupManagerProps) {
  const [includeLibrary, setIncludeLibrary] = useState(true);
  const [includeCache, setIncludeCache] = useState(false);
  const [restoreLibrary, setRestoreLibrary] = useState(true);
  const [restoreCache, setRestoreCache] = useState(false);
  const [busy, setBusy] = useState<BusyOperation>(null);

  const runMaintenance = async <T,>(operation: Exclude<BusyOperation, null>, task: () => Promise<T>): Promise<T> => {
    const message = operation === 'export'
      ? '正在创建 QuePic 备份，图库和上传操作已暂停。'
      : '正在验证并恢复 QuePic 备份，所有数据操作已暂停。';
    setBusy(operation);
    setMaintenanceState(true, message);
    try {
      return await task();
    } finally {
      setMaintenanceState(false);
      setBusy(null);
    }
  };

  const handleExport = async () => {
    try {
      const result = await runMaintenance('export', () => exportBackup(
        settings,
        includeLibrary || includeCache,
        includeCache,
      ));
      if (result.cancelled) return;
      onMessage(
        'success',
        result.path
          ? `备份已保存到：${result.path}`
          : '备份已成功导出。',
      );
    } catch (error) {
      onMessage('error', normalizeError(error));
    }
  };

  const handleImport = async () => {
    if (restoreLibrary) {
      const confirmed = window.confirm(
        '完整恢复会替换当前图片索引，并根据选择替换本地缓存。QuePic 会在失败时自动回滚，是否继续？',
      );
      if (!confirmed) return;
    }

    try {
      const result = await runMaintenance('import', () => importBackup(
        restoreLibrary || restoreCache,
        restoreCache,
      ));
      if (result.cancelled) return;
      if (result.settings) await onImported(result.settings);
      const details = [
        result.restored_library ? '图片索引已恢复' : '设置已恢复',
        result.restored_cache ? `${result.restored_cache_files} 个缓存文件已恢复` : '',
      ].filter(Boolean).join('，');
      onMessage('success', details || '备份已成功导入。');
    } catch (error) {
      onMessage('error', normalizeError(error));
    }
  };

  return (
    <section className="settings-section backup-settings-section">
      <div className="settings-section-heading">
        <div>
          <strong>备份、恢复与数据安全</strong>
          <small>凭据永远不会进入备份；完整恢复会在全局维护态下原子替换数据库和缓存。</small>
        </div>
        <Archive size={18} />
      </div>

      <div className="backup-action-grid">
        <article className="backup-action-card">
          <div className="backup-action-heading">
            <DatabaseBackup size={20} />
            <div><strong>导出备份</strong><small>导出当前非敏感设置，可选图片索引与预览缓存。</small></div>
          </div>
          <label className="toggle-row compact-toggle-row">
            <span><DatabaseBackup size={16} /><span><strong>包含图片索引</strong><small>保存 SQLite 图库、文件夹、标签和账号名称。</small></span></span>
            <input
              className="switch-input"
              type="checkbox"
              checked={includeLibrary || includeCache}
              disabled={disabled || busy !== null || includeCache}
              onChange={(event) => setIncludeLibrary(event.target.checked)}
            />
          </label>
          <label className="toggle-row compact-toggle-row">
            <span><HardDrive size={16} /><span><strong>包含本地缓存</strong><small>备份体积可能很大；启用后自动包含图片索引。</small></span></span>
            <input
              className="switch-input"
              type="checkbox"
              checked={includeCache}
              disabled={disabled || busy !== null}
              onChange={(event) => {
                setIncludeCache(event.target.checked);
                if (event.target.checked) setIncludeLibrary(true);
              }}
            />
          </label>
          <button className="button primary" disabled={disabled || busy !== null} onClick={() => void handleExport()}>
            {busy === 'export' ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}
            导出 .quepic-backup
          </button>
        </article>

        <article className="backup-action-card danger-zone-card">
          <div className="backup-action-heading">
            <ShieldAlert size={20} />
            <div><strong>导入与恢复</strong><small>先完整验证备份；失败时保持当前数据或自动回滚。</small></div>
          </div>
          <label className="toggle-row compact-toggle-row">
            <span><DatabaseBackup size={16} /><span><strong>恢复图片索引</strong><small>替换当前 SQLite 图库；关闭时只恢复非敏感设置和账号名称。</small></span></span>
            <input
              className="switch-input"
              type="checkbox"
              checked={restoreLibrary || restoreCache}
              disabled={disabled || busy !== null || restoreCache}
              onChange={(event) => setRestoreLibrary(event.target.checked)}
            />
          </label>
          <label className="toggle-row compact-toggle-row">
            <span><HardDrive size={16} /><span><strong>恢复本地缓存</strong><small>启用后自动恢复图片索引，并替换当前预览缓存。</small></span></span>
            <input
              className="switch-input"
              type="checkbox"
              checked={restoreCache}
              disabled={disabled || busy !== null}
              onChange={(event) => {
                setRestoreCache(event.target.checked);
                if (event.target.checked) setRestoreLibrary(true);
              }}
            />
          </label>
          <button className="button danger" disabled={disabled || busy !== null} onClick={() => void handleImport()}>
            {busy === 'import' ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}
            选择备份并恢复
          </button>
        </article>
      </div>

      <p className="panel-note">
        Cookie 与 OpenAPI Token 只保存在系统密钥库，不会写入备份。恢复账号后需要在当前设备重新登录或重新保存 Token。
      </p>

      {busy && (
        <div className="maintenance-overlay" role="dialog" aria-modal="true" aria-live="assertive">
          <div className="maintenance-card">
            <LoaderCircle className="spin" size={30} />
            <strong>{busy === 'export' ? '正在导出 QuePic 备份' : '正在恢复 QuePic 备份'}</strong>
            <p>{busy === 'export'
              ? '正在创建一致的 SQLite 快照并打包所选数据。'
              : '正在验证备份、执行 WAL 安全切换并准备失败回滚。'}</p>
            <small>请勿关闭应用。维护完成后所有功能会自动恢复。</small>
          </div>
        </div>
      )}
    </section>
  );
}
