import { invoke } from '@tauri-apps/api/core';

import type { BackupResult, ImportResult, PortableSettings } from '../types';

export async function exportBackup(
  settings: PortableSettings,
  includeLibrary: boolean,
  includeCache: boolean,
): Promise<BackupResult> {
  return invoke<BackupResult>('export_backup', {
    settings,
    includeLibrary,
    includeCache,
  });
}

export async function importBackup(
  restoreLibrary: boolean,
  restoreCache: boolean,
): Promise<ImportResult> {
  return invoke<ImportResult>('import_backup', {
    restoreLibrary,
    restoreCache,
  });
}
