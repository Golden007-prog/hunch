import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
test('Python state types and structural schemas match the canonical contract', () => {
  execFileSync(process.execPath, ['--import', 'tsx', 'tooling/generate-state-contracts.mjs', '--check'], { stdio: 'pipe' });
});
