/** DPoP resource-server profile: RFC 9449, RFC 7638 and RFC 8037. Ed25519 only. */
import { createHash, createPublicKey } from 'node:crypto';
import { z } from 'zod';
export const STATE_PROOF_CAPABILITY = 'nuryel.auth.dpop/1';
export const ProofPublicKeySchema = z.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().superRefine((key, ctx) => {
  if (Buffer.from(key.x, 'base64url').toString('base64url') !== key.x) ctx.addIssue({ code: 'custom', message: 'public key encoding must be canonical base64url' });
});
export type ProofPublicKey = z.infer<typeof ProofPublicKeySchema>;
export const PublicOriginSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
}, 'public_origin must be an HTTPS origin without a path, credentials, query or fragment');
export const tokenProofHash = (value: string): string => createHash('sha256').update(value, 'ascii').digest('base64url');
export function proofThumbprint(input: unknown): string {
  const key = ProofPublicKeySchema.parse(input);
  return createHash('sha256').update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x })).digest('base64url');
}
export function proofPublicKey(pem: string): ProofPublicKey {
  if (pem.trimStart().startsWith('{')) return ProofPublicKeySchema.parse(JSON.parse(pem));
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('proof keys must use Ed25519');
  return ProofPublicKeySchema.parse(key.export({ format: 'jwk' }));
}
export function proofTarget(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('key-bound requests require an HTTPS URL without credentials');
  url.search = ''; url.hash = ''; return url.href;
}
