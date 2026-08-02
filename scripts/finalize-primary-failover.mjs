import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const databasePath = 'src-tauri/src/database.rs';
let database = readFileSync(databasePath, 'utf8');

const unsafeTimestampReset = /let expected_reset = Some\(&Utc\.timestamp_opt\(hour_start \+ 3_600, 0\)\.unwrap\(\)\.to_rfc3339\(\)\);\s*assert_eq!\(\s*before_reset\.reset_at\.as_deref\(\),\s*expected_reset\.map\(String::as_str\)\s*\);/s;
const unsafeDateTimeReset = /let expected_reset = Some\(&DateTime::<Utc>::from_timestamp\(hour_start \+ 3_600, 0\)\.unwrap\(\)\.to_rfc3339\(\)\);\s*assert_eq!\(\s*before_reset\.reset_at\.as_deref\(\),\s*expected_reset\.map\(String::as_str\)\s*\);/s;
const safeReset = `let expected_reset = DateTime::<Utc>::from_timestamp(hour_start + 3_600, 0)
            .unwrap()
            .to_rfc3339();
        assert_eq!(
            before_reset.reset_at.as_deref(),
            Some(expected_reset.as_str())
        );`;

if (unsafeTimestampReset.test(database)) {
  database = database.replace(unsafeTimestampReset, safeReset);
} else if (unsafeDateTimeReset.test(database)) {
  database = database.replace(unsafeDateTimeReset, safeReset);
} else if (database.includes('Some("2027-01-15T08:00:00+00:00")')) {
  database = database.replace(
    'assert_eq!(before_reset.reset_at.as_deref(), Some("2027-01-15T08:00:00+00:00"));',
    safeReset,
  );
} else if (!database.includes('Some(expected_reset.as_str())')) {
  throw new Error('未找到可识别的整点重置测试断言。');
}
writeFileSync(databasePath, database, 'utf8');

const appPath = 'src/App.tsx';
let app = readFileSync(appPath, 'utf8');
const failedAttemptBlock = `const result = await uploadOne(item.id, candidate.profile.account_name, targetPrimary, true);
        if (!result) {
          failedCount += 1;
          continue;
        }`;
const fixedFailedAttemptBlock = `const result = await uploadOne(item.id, candidate.profile.account_name, targetPrimary, true);
        if (!result) {
          // 语雀按请求尝试计数；失败也必须占用当前账号的本整点额度。
          available -= 1;
          failedCount += 1;
          continue;
        }`;
if (app.includes(failedAttemptBlock)) {
  app = app.replace(failedAttemptBlock, fixedFailedAttemptBlock);
} else if (!app.includes('失败也必须占用当前账号的本整点额度')) {
  throw new Error('未找到从账号失败尝试的额度扣减位置。');
}
writeFileSync(appPath, app, 'utf8');

execFileSync('rustfmt', [
  '--edition', '2021',
  'src-tauri/src/database.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/src/credentials.rs',
], { stdio: 'inherit' });

execFileSync('sudo', ['apt-get', 'update', '-qq'], { stdio: 'inherit' });
execFileSync('sudo', [
  'apt-get', 'install', '-y', '-qq',
  'libwebkit2gtk-4.1-dev',
  'libappindicator3-dev',
  'librsvg2-dev',
  'patchelf',
  'libdbus-1-dev',
  'pkg-config',
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

// The first build ran before the accounting correction above. Rebuild once with
// the restored package script so the exact committed frontend is type-checked.
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
