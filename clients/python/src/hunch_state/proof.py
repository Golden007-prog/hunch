"""Optional Ed25519 DPoP signer. Install the `proof` extra; keys never leave this process."""
from __future__ import annotations

import base64
import hashlib
import json
import time
import uuid
from collections.abc import Callable
from urllib.parse import quote, urlsplit, urlunsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .client import ProofRequest


def _encoded(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def create_proof_signer(private_key: bytes | str) -> Callable[[ProofRequest], str]:
    """Load an unencrypted Ed25519 private PEM or private JWK; return a request signer."""
    material = private_key.encode("utf-8") if isinstance(private_key, str) else private_key
    if len(material) > 8192:
        raise ValueError("private key exceeds 8 KiB")
    if material.lstrip().startswith(b"{"):
        jwk = json.loads(material)
        if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519":
            raise ValueError("an Ed25519 private JWK is required")
        try:
            raw = base64.urlsafe_b64decode(jwk["d"] + "=")
            if len(raw) != 32 or _encoded(raw) != jwk["d"]:
                raise ValueError("invalid private key")
            key = Ed25519PrivateKey.from_private_bytes(raw)
        except (KeyError, TypeError, ValueError):
            raise ValueError("invalid Ed25519 private JWK") from None
    else:
        loaded = serialization.load_pem_private_key(material, password=None)
        if not isinstance(loaded, Ed25519PrivateKey):
            raise ValueError("an Ed25519 private key is required")
        key = loaded
        jwk = None
    public = _encoded(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
    if jwk is not None and jwk.get("x") != public:
        raise ValueError("JWK public key does not match its private key")
    header = {"typ": "dpop+jwt", "alg": "EdDSA", "jwk": {"kty": "OKP", "crv": "Ed25519", "x": public}}
    def encode_json(value: object) -> str:
        return _encoded(json.dumps(value, separators=(",", ":")).encode("utf-8"))

    def sign(request: ProofRequest) -> str:
        url = urlsplit(request["url"])
        if url.scheme != "https" or not url.hostname or url.username is not None or url.password is not None:
            raise ValueError("proof target must use HTTPS without credentials")
        host = url.hostname.encode('idna').decode('ascii')
        authority = '[' + host + ']' if ':' in host else host
        if url.port is not None and url.port != 443:
            authority += ':' + str(url.port)
        claims = {"jti": str(uuid.uuid4()), "htm": request["method"],
                  "htu": urlunsplit((url.scheme, authority, quote(url.path or '/', safe="/%:@!$&'()*+,;=-._~"), "", "")),
                  "iat": int(time.time()), "ath": _encoded(hashlib.sha256(request["token"].encode("ascii")).digest())}
        if "nonce" in request:
            claims["nonce"] = request["nonce"]
        message = encode_json(header) + "." + encode_json(claims)
        return message + "." + _encoded(key.sign(message.encode("ascii")))
    return sign
