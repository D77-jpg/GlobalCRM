import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { builtinBrandPackage } from '../services/playbook-import.service';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) throw new Error('Supply a private output directory.');
  const directory = resolve(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const key of ['genesis', 'ironhue', 'velaturo'] as const) {
    const contents = JSON.stringify(builtinBrandPackage(key), null, 2);
    await writeFile(join(directory, `${key}-brand-package.json`), `${contents}\n`, { flag: 'wx', mode: 0o600 });
  }
}

void main().catch(() => {
  console.error('Could not export brand packages. Verify the output directory and use a new destination.');
  process.exitCode = 1;
});
