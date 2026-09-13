import { createStateProofSigner } from '../client/stateProof.js';
/** JSON CLI over the existing HTTP client. The server owns authorization and state rules. */
import type { Command } from 'commander';
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { createStateClient, StateClientError, type StateClient } from '../client/state.js';
import { ReadRequestSchema, WriteRequestSchema, SubscribeRequestSchema, RecordsRequestSchema, ScopeSchema, STATE_FIELD_PROVENANCE_VERSION, STATE_RECORD_VISIBILITY_VERSION } from '../core/stateContract.js';

const MAX_INPUT_BYTES = 1024 * 1024;
type CommonOptions = { url: string; tokenFile?: string; proofKeyFile?: string; timeout: string; pretty?: boolean };
type InputOptions = { input?: string; scope?: string; subject?: string; task?: string; ids?: string[]; after?: string };

function scopeFrom(value: string | undefined) {
  const match = /^([a-z]+):(.+)$/.exec(value ?? '');
  if (!match) throw new Error('pass --scope kind:id, or supply scope in --input JSON');
  return ScopeSchema.parse({ kind: match[1], id: match[2] });
}

async function inputObject(file: string): Promise<Record<string, unknown>> {
  let text: string;
  if (file !== '-') {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('input must be a regular JSON file of at most 1 MiB');
    text = readFileSync(file, 'utf8');
  } else {
    if (process.stdin.isTTY) throw new Error('pipe a JSON request or pass --input <file>');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > MAX_INPUT_BYTES) throw new Error('input exceeds 1 MiB');
      chunks.push(bytes);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) throw new Error('input exceeds 1 MiB');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('input must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input must be a JSON request object');
  return value as Record<string, unknown>;
}

function connection(options: CommonOptions): StateClient {
  const timeoutMs = Number(options.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('--timeout must be 1..300000 milliseconds');
  const url = new URL(options.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('--url must be an HTTP(S) base URL without credentials, query or fragment');
  let token = process.env.HUNCH_STATE_TOKEN?.trim();
  if (options.tokenFile) {
    const stat = statSync(options.tokenFile);
    if (!stat.isFile() || stat.size > 8192) throw new Error('token file must be a regular file of at most 8 KiB');
    token = readFileSync(options.tokenFile, 'utf8').trim();
  }
  if (!token) throw new Error('set HUNCH_STATE_TOKEN or pass --token-file; tokens are not accepted as command arguments');
  let proof;
  if (options.proofKeyFile) {
    const stat = statSync(options.proofKeyFile);
    if (!stat.isFile() || stat.size > 8192) throw new Error('proof key must be a regular private-key file of at most 8 KiB');
    proof = createStateProofSigner(readFileSync(options.proofKeyFile, 'utf8'));
  }
  return createStateClient({ baseUrl: options.url, token, timeoutMs, proof });
}

export function registerStateCommands(program: Command): void {
  const state = program.command('state').description('Read and write a served workspace using the state contract; JSON output')
    .option('--url <url>', 'server base URL (or HUNCH_STATE_URL)', process.env.HUNCH_STATE_URL || 'http://127.0.0.1:7474')
    .option('--token-file <file>', 'read a bearer token from a file; otherwise use HUNCH_STATE_TOKEN')
    .option('--proof-key-file <file>', 'Ed25519 private PEM or JWK file for a key-bound token')
    .option('--timeout <ms>', 'timeout for each HTTP request', '15000')
    .option('--pretty', 'indent JSON output');
  const run = (work: (client: StateClient) => Promise<unknown>) => async () => {
    try {
      const options = state.opts<CommonOptions>(), result = await work(connection(options));
      process.stdout.write(JSON.stringify(result, null, options.pretty ? 2 : undefined) + '\n');
    } catch (error) {
      const problem = error instanceof StateClientError ? error.problem : {
        type: 'about:blank', title: error instanceof z.ZodError ? 'malformed' : 'client-error', status: 0,
        detail: error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error instanceof Error ? error.message : 'state request failed',
      };
      process.stderr.write(JSON.stringify(problem) + '\n'); process.exitCode = 1;
    }
  };
  state.command('capabilities').description('Show the authenticated principal and supported contract capabilities')
    .option('--scope <kind:id>', 'partition to negotiate; defaults to the token’s first grant')
    .action((options: InputOptions) => run(client => client.capabilities(options.scope ? scopeFrom(options.scope) : undefined))());
  for (const verb of ['read', 'write', 'records', 'subscribe'] as const) {
    const command = state.command(verb).description(verb === 'subscribe' ? 'Poll changes once; use head_seq as the next after_seq and honor resync' : `${verb} using the authenticated state contract`)
      .option('--input <file>', 'complete request JSON; - reads stdin (default for write)');
    if (verb !== 'write') command.option('--scope <kind:id>', 'partition when using shortcut options');
    if (verb === 'read') command.option('--subject <subject>', 'exact subject or record key').option('--task <text>', 'task phrase for memory delivery');
    if (verb === 'records') command.option('--ids <id...>', 'exact record IDs');
    if (verb === 'subscribe') command.option('--after <seq>', 'last observed sequence; defaults to zero');
    command.action((options: InputOptions) => run(async client => {
      const shortcut = options.scope || options.subject || options.task || options.ids || options.after;
      if (options.input && shortcut) throw new Error('use either --input JSON or shortcut options, not both');
      const raw = options.input || verb === 'write' ? await inputObject(options.input ?? '-') : {
        scope: scopeFrom(options.scope),
        ...(options.subject !== undefined ? { subject: options.subject } : {}),
        ...(options.task !== undefined ? { task: options.task } : {}),
        ...(verb === 'records' ? { ids: options.ids } : {}),
        ...(verb === 'subscribe' ? { after_seq: Number(options.after ?? 0) } : {}),
      };
      const schemas = {
        read: ReadRequestSchema.omit({ schema: true, principal: true }),
        write: WriteRequestSchema.omit({ schema: true, principal: true }),
        records: RecordsRequestSchema.omit({ schema: true, principal: true }),
        subscribe: SubscribeRequestSchema.omit({ schema: true, principal: true }),
      };
      const request = schemas[verb].parse(raw);
      const caps = await client.capabilities(request.scope);
      const required = [`nuryel.state.${verb}/1`];
      if ('record' in request) {
        if (request.record.field_provenance !== undefined) required.push(STATE_FIELD_PROVENANCE_VERSION);
        if (request.record.visibility !== undefined) required.push(STATE_RECORD_VISIBILITY_VERSION);
        if (typeof request.record.schema === 'string') required.push(request.record.schema);
      }
      const missing = required.filter(capability => !caps.capabilities.includes(capability));
      if (missing.length) throw new StateClientError(400, 'unsupported', { type: 'about:blank', title: 'unsupported', status: 400, detail: 'server lacks required capabilities: ' + missing.join(', ') });
      // The chosen request schema matches the verb; state semantics remain server-owned.
      if (verb === 'read') return client.read(request as Parameters<StateClient['read']>[0]);
      if (verb === 'write') return client.write(request as Parameters<StateClient['write']>[0]);
      if (verb === 'records') return client.records(request as Parameters<StateClient['records']>[0]);
      return client.subscribe(request as Parameters<StateClient['subscribe']>[0]);
    })());
  }
}
