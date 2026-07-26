import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceIcon = join(projectRoot, 'src-tauri', 'icons', 'icon.png');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quepic-icon-'));
const temporaryIcon = join(temporaryDirectory, 'icon.png');
const tauriBinary = join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
);

try {
  // Tauri 会把生成结果写回 src-tauri/icons。先复制到临时目录，避免输入文件与输出文件重合。
  await copyFile(sourceIcon, temporaryIcon);

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(tauriBinary, ['icon', temporaryIcon], {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`Tauri 图标生成失败，退出码：${code ?? 'unknown'}`));
      }
    });
  });
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
