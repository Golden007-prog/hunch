import base64
import importlib.util
import json
import unittest


@unittest.skipUnless(importlib.util.find_spec('cryptography'), 'optional proof extra is not installed')
class ProofTests(unittest.TestCase):
    def test_public_proof_signature_target_and_fresh_identifier(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from hunch_state.proof import create_proof_signer
        key = Ed25519PrivateKey.generate()
        signer = create_proof_signer(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                      serialization.NoEncryption()))
        request = {'method': 'GET', 'url': 'https://EXAMPLE.test:443/hello?scope=test#fragment', 'token': 'fixture', 'nonce': 'server-nonce'}
        first, second = signer(request), signer(request)
        header, body, signature = first.split('.')
        decode = lambda value: base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
        claims = json.loads(decode(body))
        self.assertEqual(claims['htu'], 'https://example.test/hello')
        self.assertEqual(claims['nonce'], 'server-nonce')
        self.assertNotEqual(claims['jti'], json.loads(decode(second.split('.')[1]))['jti'])
        self.assertNotIn('d', json.loads(decode(header))['jwk'])
        key.public_key().verify(decode(signature), (header + '.' + body).encode('ascii'))


if __name__ == '__main__':
    unittest.main()
