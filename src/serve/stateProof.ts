import { withWriteLock } from './writelock.js';
/** Shared-disk nonce/replay state survives restarts and serializes independent server processes. */
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomicIfAbsent } from '../core/io.js';
import { ProofPublicKeySchema, proofThumbprint, proofTarget, tokenProofHash, type ProofPublicKey } from '../core/stateProof.js';
const Header = z.object({ typ: z.literal('dpop+jwt'), alg: z.literal('EdDSA'), jwk: ProofPublicKeySchema }).strict();
const Claims = z.object({ jti: z.string().min(16).max(128), htm: z.string().max(16), htu: z.string().max(2048), iat: z.number().int().nonnegative(), ath: z.string().regex(/^[A-Za-z0-9_-]{43}$/), nonce: z.string().max(128).optional() }).strict();
export class StateProofError extends Error {
  constructor(readonly code: 'invalid_dpop_proof' | 'use_dpop_nonce', readonly nonce?: string) { super(code === 'use_dpop_nonce' ? 'a fresh server nonce is required' : 'request proof is invalid or already used'); }
}
function ordinaryDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('proof state must be an ordinary private directory');
  if ((stat.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}
function equal(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function decode(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || Buffer.from(segment, 'base64url').toString('base64url') !== segment) throw new StateProofError('invalid_dpop_proof');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}
const lastSweep = new Map<string, number>();
export async function verifyStateProof(input: { proof?: string; key: ProofPublicKey; method: string; url: string; token: string; stateDir: string; now?: number }): Promise<void> {
  const now = input.now ?? Math.floor(Date.now() / 1000), thumbprint = proofThumbprint(input.key);
  ordinaryDirectory(input.stateDir);
  const secretFile = join(input.stateDir, 'nonce-key');
  if (!existsSync(secretFile)) writeFileAtomicIfAbsent(secretFile, randomBytes(32).toString('hex'));
  const stat = lstatSync(secretFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64) throw new Error('proof nonce key is invalid');
  if ((stat.mode & 0o777) !== 0o600) chmodSync(secretFile, 0o600);
  const secret = readFileSync(secretFile, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('proof nonce key is invalid');
  const epoch = Math.floor(now / 60), tokenHash = tokenProofHash(input.token);
  const nonceAt = (period: number) => `${period}.${createHmac('sha256', Buffer.from(secret, 'hex')).update(`${period}:${thumbprint}:${tokenHash}`).digest('base64url')}`;
  const nonce = nonceAt(epoch);
  if (!input.proof) throw new StateProofError('use_dpop_nonce', nonce);
  let claims: z.infer<typeof Claims>;
  try {
    if (input.proof.length > 8192) throw new Error('oversized');
    const parts = input.proof.split('.'); if (parts.length !== 3) throw new Error('JWT');
    const header = Header.parse(decode(parts[0]!)); claims = Claims.parse(decode(parts[1]!));
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== parts[2]) throw new Error('signature');
    if (!equal(proofThumbprint(header.jwk), thumbprint)) throw new Error('key');
    if (!verify(null, Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key: header.jwk, format: 'jwk' }), signature)) throw new Error('signature');
    if (claims.htm !== input.method || claims.htu !== proofTarget(input.url) || !equal(claims.ath, tokenHash) || claims.iat < now - 60 || claims.iat > now + 5) throw new Error('binding');
  } catch { throw new StateProofError('invalid_dpop_proof'); }
  if (!claims.nonce || (!equal(claims.nonce, nonce) && !equal(claims.nonce, nonceAt(epoch - 1)))) throw new StateProofError('use_dpop_nonce', nonce);
  await withWriteLock(input.stateDir, () => {
  const replayRoot = join(input.stateDir, 'used'); ordinaryDirectory(replayRoot);
  // One atomic filename per key/jti, independent of iat: concurrent proofs with
  // different timestamps cannot each win in a separate bucket.
  if (lastSweep.get(replayRoot) !== epoch) {
    for (const entry of readdirSync(replayRoot, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
      const file = join(replayRoot, entry.name);
      try {
        const expires = Number(readFileSync(file, 'utf8'));
        if (Number.isFinite(expires) && expires < now) rmSync(file);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    lastSweep.set(replayRoot, epoch);
  }
  const id = createHash('sha256').update(thumbprint + '\0' + claims.jti).digest('hex');
  if (!writeFileAtomicIfAbsent(join(replayRoot, id), String(claims.iat + 60))) throw new StateProofError('invalid_dpop_proof');
  });
}
