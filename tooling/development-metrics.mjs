/** Read-only bounded PR evidence. Unknowns are never treated as successful autonomy. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

export function summarizeDevelopmentPRs(prs, revertCommits = [], initialChecks = new Map()) {
  const explicit = new Set(revertCommits.flatMap(commit => [...commit.message.matchAll(/This reverts commit ([a-f0-9]{40})\b/g)].map(match => match[1])));
  const rows = prs.map(pr => {
    const elapsed = Date.parse(pr.mergedAt) - Date.parse(pr.createdAt);
    if (!Number.isInteger(pr.number) || !Number.isFinite(elapsed) || elapsed < 0) throw new Error('invalid merged PR timeline');
    const reviews = pr.reviews?.nodes ?? [];
    const changed = reviews.some(review => review.state === 'CHANGES_REQUESTED');
    return { number: pr.number, url: pr.url, merge_commit: pr.mergeCommit?.oid ?? null, time_to_merge_ms: elapsed,
      change_requested: changed ? true : !pr.reviews || pr.reviews.pageInfo?.hasNextPage !== false ? null : false,
      explicit_merge_revert_found: explicit.has(pr.mergeCommit?.oid),
      first_pr_head_ci: initialChecks.get(pr.number) ?? { result: 'unknown' } };
  });
  const durations = rows.map(row => row.time_to_merge_ms).sort((a, b) => a - b);
  const knownReviews = rows.filter(row => row.change_requested !== null);
  const knownCI = rows.filter(row => ['passed', 'failed'].includes(row.first_pr_head_ci.result));
  return { schema: 'hunch.development-metrics/1', sample_size: rows.length, rows,
    change_request_rate: knownReviews.length ? knownReviews.filter(row => row.change_requested).length / knownReviews.length : null,
    review_coverage: knownReviews.length, explicit_merge_reverts: rows.filter(row => row.explicit_merge_revert_found).length,
    first_pr_head_ci_coverage: knownCI.length,
    first_pr_head_ci_failure_rate: knownCI.length ? knownCI.filter(row => row.first_pr_head_ci.result === 'failed').length / knownCI.length : null,
    median_time_to_merge_ms: durations.length ?
      (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2 : null,
    limitations: ['A bounded GitHub sample is not every historical PR.', 'Review pagination can leave change-request status unknown.',
      'No explicit merge-commit revert found does not exclude partial, manual or cherry-picked reversions.',
      'Initial PR-head CI needs an original head receipt; current green checks do not reconstruct it. It is not the first push of a branch.',
      'These metrics do not grant a promotion or activation.'], promotion: 'not-evaluated' };
}

export function initialCheckResult(runs, total = runs.length) {
  const required = ['ci (22)', 'ci (24)', 'hunch-guard', 'platform-matrix-safety (macos-latest)', 'platform-matrix-safety (windows-latest)'];
  if (total > runs.length) return 'unknown';
  const first = required.map(name => runs.filter(run => run.name === name).sort((a, b) => a.id - b.id)[0]);
  if (first.some(run => ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(run?.conclusion))) return 'failed';
  return first.every(run => run?.conclusion === 'success') ? 'passed' : 'unknown';
}

export function developmentHistoryRef(repo, remote, branch) {
  const match = remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/);
  if (!match || match[1].replace(/\.git$/, '').toLowerCase() !== repo.toLowerCase()) throw new Error('origin must match the GitHub repository being measured');
  if (typeof branch !== 'string' || !branch || branch.includes('..') || /[\s~^:?*\[\\]/.test(branch)) throw new Error('invalid default branch');
  return 'refs/remotes/origin/' + branch;
}

export function collectDevelopmentMetrics(repo, limit = 100, initialHeads = []) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('repo must be owner/name');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100');
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!,$limit:Int!){repository(owner:$owner,name:$name){defaultBranchRef{name} pullRequests(first:$limit,states:MERGED,orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage} nodes{number url createdAt mergedAt mergeCommit{oid} reviews(first:100){pageInfo{hasNextPage} nodes{state}}}}}}';
  const raw = execFileSync('gh', ['api', 'graphql', '-f', 'query=' + query, '-f', 'owner=' + owner, '-f', 'name=' + name, '-F', 'limit=' + limit], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const parsed = JSON.parse(raw); if (parsed.errors) throw new Error('GitHub returned incomplete query data');
  const connection = parsed.data.repository.pullRequests;
  const historyRef = developmentHistoryRef(repo, execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 10_000 }), parsed.data.repository.defaultBranchRef?.name);
  const initialChecks = new Map();
  if (!Array.isArray(initialHeads) || initialHeads.length > 100) throw new Error('initial-head input must contain at most 100 receipts');
  for (const receipt of initialHeads) {
    if (receipt.schema !== 'hunch.initial-pr-head/1' || receipt.repository !== repo || !Number.isInteger(receipt.number) || receipt.number < 1
        || !/^[a-f0-9]{40}$/.test(receipt.head_sha) || !Number.isFinite(Date.parse(receipt.opened_at))) throw new Error('invalid initial PR-head receipt');
    if (initialChecks.has(receipt.number)) throw new Error('duplicate initial PR-head receipt');
    const pr = connection.nodes.find(pr => pr.number === receipt.number);
    if (!pr) continue;
    if (Date.parse(pr.createdAt) !== Date.parse(receipt.opened_at)) throw new Error('initial-head receipt does not match the PR creation time');
    const checks = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/commits/${receipt.head_sha}/check-runs?filter=all&per_page=100`], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }));
    initialChecks.set(receipt.number, { head_sha: receipt.head_sha, result: initialCheckResult(checks.check_runs, checks.total_count),
      receipt_run_id: receipt.run_id ?? null });
  }
  // Only explicit full-merge revert markers in the locally fetched default-branch history.
  const history = execFileSync('git', ['log', historyRef, '--format=%H%x00%B%x00', '--max-count=2000', '--'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  const parts = history.split('\0'), commits = [];
  for (let i = 0; i + 1 < parts.length; i += 2) commits.push({ sha: parts[i].trim(), message: parts[i + 1] });
  return { ...summarizeDevelopmentPRs(connection.nodes, commits, initialChecks), repository: repo, collected_at: new Date().toISOString(),
    sample_truncated: connection.pageInfo.hasNextPage, history_ref: historyRef,
    history_revision: execFileSync('git', ['rev-parse', '--verify', historyRef], { encoding: 'utf8' }).trim(), history_max_commits: 2000 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), get = name => args[args.indexOf(name) + 1];
    if (!args.includes('--repo')) throw new Error('--repo owner/name is required');
    let receipts = [];
    if (args.includes('--initial-heads')) {
      const file = get('--initial-heads'); if (!statSync(file).isFile() || statSync(file).size > 1024 * 1024) throw new Error('initial-head receipts must be a JSON file of at most 1 MiB');
      receipts = JSON.parse(readFileSync(file, 'utf8'));
    }
    const report = collectDevelopmentMetrics(get('--repo'), args.includes('--limit') ? Number(get('--limit')) : 100, receipts);
    const text = JSON.stringify(report, null, 2) + '\n';
    if (args.includes('--output')) writeFileSync(resolve(get('--output')), text, { mode: 0o600, flag: 'wx' });
    else process.stdout.write(text);
  } catch (error) { process.stderr.write('development-metrics: ' + error.message + '\n'); process.exitCode = 1; }
}
