import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quepic-icon-'));
const temporaryIcon = join(temporaryDirectory, 'icon.png');
const tauriBinary = join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
);

const WIDTH = 512;
const HEIGHT = 512;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createIconPng() {
  const stride = WIDTH * 4 + 1;
  const pixels = Buffer.alloc(stride * HEIGHT);

  for (let y = 0; y < HEIGHT; y += 1) {
    const rowOffset = y * stride;
    pixels[rowOffset] = 0; // PNG filter: None
    for (let x = 0; x < WIDTH; x += 1) {
      const pixelOffset = rowOffset + 1 + x * 4;
      const dx = x - 252;
      const dy = y - 234;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const ring = distance >= 122 && distance <= 164;
      const tail = x >= 315 && x <= 425 && y >= 320 && y <= 382;
      const sparkle = Math.abs(x - 412) + Math.abs(y - 116) < 42;

      const foreground = ring || tail || sparkle;
      pixels[pixelOffset] = foreground ? 255 : 108;
      pixels[pixelOffset + 1] = foreground ? 255 : 92;
      pixels[pixelOffset + 2] = foreground ? 255 : 231;
      pixels[pixelOffset + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

try {
  await writeFile(temporaryIcon, createIconPng());

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
