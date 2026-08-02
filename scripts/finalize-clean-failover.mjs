import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

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

execFileSync('npm', ['run', 'icons'], { stdio: 'inherit' });
execFileSync('rustfmt', [
  '--edition', '2021',
  'src-tauri/src/database.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/src/credentials.rs',
], { stdio: 'inherit' });

mkdirSync('.git/hooks', { recursive: true });
const hookPath = '.git/hooks/pre-commit';
writeFileSync(hookPath, `#!/usr/bin/env bash
set -euo pipefail

git checkout origin/main -- .github/workflows/ci.yml package.json src-tauri/src/credentials.rs

git rm -r -f --ignore-unmatch \\
  package-lock.json \\
  src-tauri/Cargo.lock \\
  src-tauri/gen \\
  src-tauri/icons \\
  primary-failover-validation-error.txt \\
  upload-routing-inspection.txt \\
  primary-failover-status.json \\
  primary-failover-failed.log \\
  scripts/.trigger-primary-failover \\
  scripts/patch-primary-failover.py \\
  scripts/finalize-clean-failover.mjs \\
  scripts/finalize-primary-failover.mjs \\
  scripts/sitecustomize.py \\
  sitecustomize.py \\
  .github/workflows/implement-primary-failover.yml \\
  .github/workflows/inspect-upload-routing.yml \\
  .github/workflows/snapshot-primary-failover.yml

git add .github/workflows/ci.yml package.json src-tauri/src/credentials.rs
`, 'utf8');
chmodSync(hookPath, 0o755);
