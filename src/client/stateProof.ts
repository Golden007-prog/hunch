/** Optional Node signer. The fetch-only client stays usable in other runtimes. */
import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { ProofPublicKeySchema, proofTarget, tokenProofHash } from '../core/stateProof.js';
import type { StateProofRequest } from './state.js';
export function createStateProofSigner(input: string | KeyObject): (request: StateProofRequest) => Promise<string> {
  const key = typeof input === 'string' ? (input.trimStart().startsWith('{') ? createPrivateKey({ key: JSON.parse(input), format: 'jwk' }) : createPrivateKey(input)) : input;
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('proof signing requires an Ed25519 private key');
  const jwk = ProofPublicKeySchema.parse(createPublicKey(key).export({ format: 'jwk' }));
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ typ: 'dpop+jwt', alg: 'EdDSA', jwk });
  return async ({ method, url, token, nonce }) => {
    const claims = encode({ jti: randomUUID(), htm: method, htu: proofTarget(url), iat: Math.floor(Date.now() / 1000), ath: tokenProofHash(token), ...(nonce ? { nonce } : {}) });
    const message = `${header}.${claims}`;
    return `${message}.${sign(null, Buffer.from(message), key).toString('base64url')}`;
  };
}
