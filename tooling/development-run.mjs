/** Operator-invoked, one-task launcher. No scheduler, merge, publishing or authority changes. */
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DecisionSchema } from '../src/core/types.ts';
import { isGitRepoRoot, isLinkedWorktree } from '../src/extractors/git.ts';

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const readJson = file => {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('input must be an ordinary JSON file of at most 64 KiB');
  return JSON.parse(readFileSync(file, 'utf8'));
};
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 }).trim();

export function prepareDevelopmentRun({ worktree, proposal, argvFile, minutes = 40 }) {
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) throw new Error('minutes must be 1..120');
  const cwd = realpathSync(worktree);
  if (!isGitRepoRoot(cwd)) throw new Error('worktree must name its repository root');
  const gitDir = realpathSync(git(cwd, ['rev-parse', '--absolute-git-dir']));
  if (!isLinkedWorktree(cwd)) throw new Error('use a linked Git worktree, not the primary checkout');
  const branch = git(cwd, ['branch', '--show-current']);
  if (!branch.startsWith('agent/')) throw new Error('the isolated branch must start with agent/');
  if (git(cwd, ['status', '--porcelain'])) throw new Error('the isolated worktree must be clean before a run');
  const record = DecisionSchema.parse(readJson(proposal));
  if (record.status !== 'proposed' || record.valid_to != null || record.superseded_by != null) throw new Error('select an open proposed decision');
  // Require the same exact proposal in this checkout, so an unrelated/stale export cannot
  // silently choose work under a different base revision.
  const localFile = join(cwd, '.hunch', 'decisions', record.id + '.json');
  if (!existsSync(localFile) || JSON.stringify(DecisionSchema.parse(readJson(localFile))) !== JSON.stringify(record)) throw new Error('proposal must match the record in the selected worktree');
  const config = readJson(argvFile);
  if (config.provider !== 'subscription-cli' || !Array.isArray(config.argv) || !config.argv.length || config.argv.length > 32
      || config.argv.some(value => typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0'))) throw new Error('select a subscription CLI using {provider:"subscription-cli", argv:[executable, ...arguments]}');
  const prompt = readFileSync(new URL('./development-task.md', import.meta.url), 'utf8').replace('{{PROPOSAL}}', JSON.stringify({ id: record.id, title: record.title, topic: record.topic, decision: record.decision, related_files: record.related_files }, null, 2));
  return { cwd, gitDir, branch, base: git(cwd, ['rev-parse', 'HEAD']), proposal_id: record.id, proposal_hash: hash(JSON.stringify(record)),
    template_hash: hash(prompt), argv: config.argv, prompt, timeoutMs: minutes * 60_000 };
}

/** A runtime bound and receipt, not a security sandbox or proof the agent obeyed the template. */
export async function runDevelopmentProcess(plan, { maxOutputBytes = 1024 * 1024 } = {}) {
  if (!Number.isFinite(plan.timeoutMs) || plan.timeoutMs <= 0 || plan.timeoutMs > 120 * 60_000) throw new Error('invalid runtime budget');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('invalid output budget');
  const lock = join(plan.gitDir, 'hunch-development-run.lock');
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch { throw new Error('this worktree already has a run lock; inspect it before recovery'); }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })); }
  catch (error) { closeSync(fd); unlinkSync(lock); throw error; }
  closeSync(fd);
  const started = Date.now(), stdout = createHash('sha256'), stderr = createHash('sha256');
  let outputBytes = 0, outcome = 'process-exited', child, timer, forceTimer, stopped;
  const env = { ...process.env };
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CURSOR_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HUNCH_SYNTH_ALLOW_METERED']) delete env[key];
  const stop = reason => {
    if (outcome !== 'process-exited') return;
    outcome = reason;
    if (!child?.pid) return;
    const kill = signal => {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
        else process.kill(-child.pid, signal);
      } catch { try { child.kill(signal); } catch {} }
    };
    kill('SIGTERM');
    // A leader can exit before its descendants. Complete the group cleanup even
    // when the leader closes its pipes before the grace period ends.
    stopped = new Promise(done => { forceTimer = setTimeout(() => { kill('SIGKILL'); done(); }, 1000); });
  };
  const interrupted = () => stop('interrupted');
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    // shell:false keeps proposal/prompt/argv text out of shell evaluation. On Windows an
    // operator must select an executable (e.g. node + the CLI entry), not a .cmd shim.
    child = spawn(plan.argv[0], plan.argv.slice(1), { cwd: plan.cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    for (const [stream, digest] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', bytes => {
      outputBytes += bytes.length; digest.update(bytes); if (outputBytes > maxOutputBytes) stop('output-limit');
    });
    child.stdin.on('error', () => {}); child.stdin.end(plan.prompt);
    timer = setTimeout(() => stop('timeout'), plan.timeoutMs);
    const result = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); });
    if (stopped) await stopped;
    return { schema: 'hunch.development-run/1', proposal_id: plan.proposal_id, proposal_hash: plan.proposal_hash,
      base: plan.base, branch: plan.branch, template_hash: plan.template_hash, outcome, ...result,
      elapsed_ms: Date.now() - started, output_bytes: outputBytes,
      stdout_hash: 'sha256:' + stdout.digest('hex'), stderr_hash: 'sha256:' + stderr.digest('hex'),
      task_completion: 'unverified', authority_change: false };
  } finally {
    clearTimeout(timer); clearTimeout(forceTimer);
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    unlinkSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), value = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(name + ' is required'); return args[i + 1]; };
    for (const arg of args.filter(arg => arg.startsWith('--'))) if (!['--worktree', '--proposal', '--argv-file', '--minutes', '--run', '--output'].includes(arg)) throw new Error('unknown option: ' + arg);
    const plan = prepareDevelopmentRun({ worktree: value('--worktree'), proposal: value('--proposal'), argvFile: value('--argv-file'), minutes: args.includes('--minutes') ? Number(value('--minutes')) : 40 });
    let result;
    if (args.includes('--run')) {
      const output = resolve(value('--output'));
      // Reserve the private receipt before starting: an unwritable destination
      // must not launch an agent whose result we cannot retain.
      const outputFd = openSync(output, 'wx', 0o600);
      try {
        result = await runDevelopmentProcess(plan);
        writeFileSync(outputFd, JSON.stringify(result, null, 2) + '\n');
      } catch (error) {
        writeFileSync(outputFd, JSON.stringify({ schema: 'hunch.development-run-error/1', task_completion: 'unverified', error: error.message }) + '\n');
        throw error;
      } finally { closeSync(outputFd); }
      if (result.outcome !== 'process-exited' || result.code !== 0) process.exitCode = 1;
    } else result = { schema: 'hunch.development-run-plan/1', cwd: plan.cwd, branch: plan.branch, base: plan.base,
      proposal_id: plan.proposal_id, proposal_hash: plan.proposal_hash, template_hash: plan.template_hash,
      timeout_ms: plan.timeoutMs, execution: 'not-started', prompt: plan.prompt };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) { process.stderr.write('development-run: ' + error.message + '\n'); process.exitCode = 1; }
}
