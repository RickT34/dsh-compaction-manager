// Link the DSH packages the tests need from a local DeepSeek Harness install.
// Usage: npm run link-dsh [-- /path/to/@deepseek-ai/dsh]
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const root = new URL('../', import.meta.url).pathname;
function findDsh() {
  if (process.argv[2]) return process.argv[2];
  // Follow the `dsh` executable on PATH back to its package directory.
  try {
    const bin = realpathSync(execSync('command -v dsh', { shell: '/bin/sh' }).toString().trim());
    let dir = dirname(bin);
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, 'node_modules/@deepseek-ai'))) return dir;
      dir = dirname(dir);
    }
  } catch { /* fall through */ }
  return join(execSync('npm root -g').toString().trim(), '@deepseek-ai/dsh');
}
const dsh = findDsh();
const scope = join(dsh, 'node_modules/@deepseek-ai');
if (!existsSync(scope)) throw new Error(`DSH installation not found at ${dsh}`);
const packages = ['schemastery', 'cosmokit', 'dsh-session', 'dsh-compaction-basic', 'dsh-compaction-tool-result-pruner'];
for (const name of packages) {
  const target = join(scope, name);
  const link = join(root, 'node_modules/@deepseek-ai', name);
  if (!existsSync(target)) throw new Error(`missing ${target}`);
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { force: true, recursive: true });
  symlinkSync(target, link);
}
// React for the client smoke test: take it from the Web profile when present.
const react = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/web/node_modules/react');
if (existsSync(react)) {
  const link = join(root, 'node_modules/react');
  rmSync(link, { force: true, recursive: true });
  symlinkSync(react, link);
}
console.log(`linked ${packages.length} packages from ${scope}`);
