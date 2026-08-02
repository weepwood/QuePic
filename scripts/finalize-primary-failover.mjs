import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const databasePath = 'src-tauri/src/database.rs';
let database = readFileSync(databasePath, 'utf8');
const wrongReset = 'Some("2027-01-15T08:00:00+00:00")';
if (!database.includes(wrongReset)) {
  throw new Error('未找到整点重置测试中的旧时间断言。');
}
database = database.replace(wrongReset, 'Some("2027-01-15T09:00:00+00:00")');
writeFileSync(databasePath, database, 'utf8');

execFileSync('rustfmt', [
  '--edition', '2021',
  'src-tauri/src/database.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/src/credentials.rs',
], { stdio: 'inherit' });

const originalCi = execFileSync(
  'git',
  ['show', 'origin/main:.github/workflows/ci.yml'],
  { encoding: 'utf8' },
);
writeFileSync('.github/workflows/ci.yml', originalCi, 'utf8');

const packagePath = 'package.json';
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
packageJson.scripts.build = 'tsc --noEmit && vite build';
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

const temporaryPaths = [
  '.github/workflows/implement-primary-failover.yml',
  '.github/workflows/inspect-upload-routing.yml',
  '.github/workflows/snapshot-primary-failover.yml',
  'upload-routing-inspection.txt',
  'primary-failover-status.json',
  'primary-failover-failed.log',
  'scripts/.trigger-primary-failover',
  'scripts/patch-primary-failover.py',
  'scripts/sitecustomize.py',
  'sitecustomize.py',
  'scripts/finalize-primary-failover.mjs',
];
for (const path of temporaryPaths) {
  if (existsSync(path)) rmSync(path, { force: true });
}
