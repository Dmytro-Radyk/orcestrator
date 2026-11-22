import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyStorefrontEvidence } from '../src/storefront-quality.js';

test('storefront acceptance requires a browser check and evidence at both viewport sizes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'storefront-evidence-'));
  const directory = 'artifacts/storefront-acceptance';
  await mkdir(join(cwd, directory), { recursive: true });
  const files = [`${directory}/desktop.png`, `${directory}/mobile.png`];
  const check = { command: 'node scripts/check-storefront-browser.mjs', kind: 'exit_code',
    status: 'passed', required: true, expectedExitCode: 0, actualExitCode: 0 };
  const report = { files, checks: [check] };
  const pngHeader = width => {
    const data = Buffer.alloc(48);
    data.set(Buffer.from('89504e470d0a1a0a', 'hex'));
    data.write('IHDR', 12);
    data.writeUInt32BE(width, 16);
    data.writeUInt32BE(720, 20);
    return data;
  };
  assert.equal(await verifyStorefrontEvidence(report, cwd), false);
  await writeFile(join(cwd, files[0]), pngHeader(1280));
  await writeFile(join(cwd, files[1]), pngHeader(1280));
  assert.equal(await verifyStorefrontEvidence(report, cwd), false);
  await writeFile(join(cwd, files[1]), pngHeader(390));
  assert.equal(await verifyStorefrontEvidence({ ...report, checks: [{ ...check, actualExitCode: 1 }] }, cwd), false);
  assert.equal(await verifyStorefrontEvidence(report, cwd), true);
});
