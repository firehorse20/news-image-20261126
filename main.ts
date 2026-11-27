// The World Today — 26 November 2026 (Node 22+ stdlib only).
// Hands the pre-rendered entry.png to the grader: copies it into
// $MAKEFUN_OUTPUT_DIR (default /output) after verifying it is a
// 1024x1024 PNG of at most 1 MiB. No browser, no network, no writes
// into the repository: the image was rendered at build time and is
// committed in this repository, so grading only needs to copy it.
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const src = join(root, 'entry.png');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(message: string): never {
  console.error('main.ts: ' + message);
  process.exit(1);
}

function main(): void {
  if (!existsSync(src)) fail('entry.png is missing from the repository root');
  const size = statSync(src).size;
  if (size > 1024 * 1024) fail(`entry.png is ${size} bytes, over the 1 MiB cap`);
  const buf = readFileSync(src);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    fail('entry.png does not start with the PNG magic bytes');
  }
  if (buf.toString('latin1', 12, 16) !== 'IHDR') fail('entry.png has no IHDR chunk');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== 1024 || height !== 1024) {
    fail(`entry.png is ${width}x${height}, expected 1024x1024`);
  }
  if (buf.length < 12 || buf.toString('latin1', buf.length - 8, buf.length - 4) !== 'IEND') {
    fail('entry.png is truncated: missing the IEND chunk');
  }
  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, 'entry.png');
  copyFileSync(src, dest);
  const copied = readFileSync(dest);
  if (!copied.equals(buf)) fail('copied entry.png differs from the repository copy');
  const sha = createHash('sha256').update(buf).digest('hex');
  console.log(JSON.stringify({ size, sha256: sha, dimensions: `${width}x${height}`, output: dest }));
}

main();
