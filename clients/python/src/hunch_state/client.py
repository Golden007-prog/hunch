"""Synchronous HTTP client; no local state semantics and no write retries."""
from __future__ import annotations

import http.client
import json
import math
import ssl
from collections.abc import Callable, Mapping
from typing import Any, TypedDict, NotRequired, cast
from urllib.parse import quote, urlsplit, urlunsplit

from .models import (Scope, ReadRequest, ReadResponse, WriteRequest, WriteResult,
                     RecordsRequest, RecordsResponse, SubscribeRequest, SubscribeResponse,
                     CaptureRequest, CaptureBatchRequest, CaptureBatchResult,
                     CapabilitiesResponse, HealthResponse, StateProblem)


class ProofRequest(TypedDict):
    method: str
    url: str
    token: str
    nonce: NotRequired[str]


class StateClientError(Exception):
    """A server refusal, or an unsupported capability detected before sending a verb."""
    def __init__(self, status: int, code: str, problem: StateProblem):
        self.status, self.code, self.problem = status, code, problem
        super().__init__(f"{code}: {problem.get('detail', 'state request refused')}")


class StateTransportError(Exception):
    """No reliable state result. A failed write may have committed; reconcile before retrying."""
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class StateClient:
    """One synchronous client per worker. Timeout applies to blocking socket operations.

    Default TLS certificate verification is retained. An SSLContext can add a private CA.
    Redirects and proxy environment variables are never followed. Responses are bounded.
    """
    def __init__(self, base_url: str, token: str, *, timeout: float = 15,
                 proof: Callable[[ProofRequest], str] | None = None,
                 ssl_context: ssl.SSLContext | None = None, max_response_bytes: int = 16 * 1024 * 1024):
        base = urlsplit(base_url)
        if (base.scheme not in ("http", "https") or not base.hostname or base.username is not None
                or base.password is not None or base.query or base.fragment
                or any(ord(c) < 33 for c in base_url)):
            raise ValueError("base_url must be HTTP(S) without credentials, query, fragment or whitespace")
        if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError("token must be a nonempty ASCII credential without whitespace")
        if not math.isfinite(timeout) or not 0 < timeout <= 300:
            raise ValueError("timeout must be greater than zero and at most 300 seconds")
        if not isinstance(max_response_bytes, int) or not 1 <= max_response_bytes <= 64 * 1024 * 1024:
            raise ValueError("max_response_bytes must be 1..67108864")
        if proof is not None and base.scheme != "https":
            raise ValueError("key-bound credentials require HTTPS")
        self._base = base
        self._host = base.hostname.encode('idna').decode('ascii')
        authority = '[' + self._host + ']' if ':' in self._host else self._host
        if base.port is not None and base.port != (443 if base.scheme == 'https' else 80):
            authority += ':' + str(base.port)
        self._path = quote(base.path.rstrip('/'), safe="/%:@!$&'()*+,;=-._~")
        self._url = urlunsplit((base.scheme, authority, self._path, '', ''))
        self._token, self._timeout, self._proof = token, timeout, proof
        self._context, self._limit = ssl_context, max_response_bytes
        self._nonce: str | None = None

    def _call(self, method: str, path: str, body: Mapping[str, Any] | None = None) -> dict[str, Any]:
        data = None
        if body is not None:
            if "principal" in body or "schema" in body:
                raise ValueError("request identity and protocol are server-owned; omit principal and schema")
            data = json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            if len(data) > 1024 * 1024:
                raise ValueError("request exceeds 1 MiB")
        for attempt in range(2):
            headers = {"Authorization": ("DPoP " if self._proof else "Bearer ") + self._token,
                       "Accept": "application/json", "Content-Type": "application/json"}
            if self._proof:
                request: ProofRequest = {"method": method, "url": self._url + path, "token": self._token}
                if self._nonce is not None:
                    request["nonce"] = self._nonce
                headers["DPoP"] = self._proof(request)
            connection: http.client.HTTPConnection
            if self._base.scheme == "https":
                connection = http.client.HTTPSConnection(self._host, self._base.port,
                                                         timeout=self._timeout, context=self._context)
            else:
                connection = http.client.HTTPConnection(self._host, self._base.port, timeout=self._timeout)
            try:
                connection.request(method, self._path + path, body=data, headers=headers)
                response = connection.getresponse()
                if 300 <= response.status < 400:
                    raise StateTransportError("redirect", "state server redirects are refused")
                raw = response.read(self._limit + 1)
                if len(raw) > self._limit:
                    raise StateTransportError("response-too-large", "state response exceeds configured limit")
                try:
                    parsed = json.loads(raw)
                    if not isinstance(parsed, dict):
                        raise ValueError("object required")
                except (ValueError, UnicodeError):
                    raise StateTransportError("invalid-response", "state server returned an invalid JSON object") from None
                nonce = response.getheader("DPoP-Nonce")
                if (attempt == 0 and self._proof and response.status == 401 and nonce
                        and parsed.get("title") == "use_dpop_nonce"):
                    if len(nonce) > 128 or any(ord(c) < 33 or ord(c) > 126 for c in nonce):
                        raise StateTransportError("invalid-response", "state server returned an invalid nonce")
                    self._nonce = nonce
                    continue
                if not 200 <= response.status < 300:
                    problem = cast(StateProblem, parsed)
                    raise StateClientError(response.status, str(parsed.get("title", response.status)), problem)
                return cast(dict[str, Any], parsed)
            except TimeoutError:
                raise StateTransportError("timeout", "state request timed out; reconcile a write before retrying") from None
            except (OSError, http.client.HTTPException):
                raise StateTransportError("connection", "state connection failed; reconcile a write before retrying") from None
            finally:
                connection.close()
        raise AssertionError("nonce retry exhausted")

    def health(self) -> HealthResponse:
        return cast(HealthResponse, self._call("GET", "/nuryel/v1/health"))

    def capabilities(self, scope: Scope | None = None) -> CapabilitiesResponse:
        query = "?scope=" + quote(scope["kind"] + ":" + scope["id"], safe="") if scope else ""
        result = self._call("GET", "/nuryel/v1/capabilities" + query)
        if result.get("protocol") != "nuryel.state/1" or not isinstance(result.get("capabilities"), list):
            raise StateTransportError("unsupported", "server does not offer the nuryel.state/1 contract")
        return cast(CapabilitiesResponse, result)

    def _verb(self, verb: str, request: Mapping[str, Any]) -> dict[str, Any]:
        # Negotiate on each operation so a rolling downgrade never silently drops a feature.
        required = [f"nuryel.state.{verb}/1"]
        records = [request.get("record", {}), *request.get("observations", [])]
        if "visibility" in request:
            records.append(request)
        for record in records:
            if "field_provenance" in record:
                required.append("nuryel.field-provenance/1")
            if "visibility" in record:
                required.append("nuryel.record-visibility/1")
            if isinstance(record.get("schema"), str):
                required.append(record["schema"])
        caps = self.capabilities(request.get("scope"))
        missing = sorted(set(required) - set(caps["capabilities"]))
        if missing:
            problem: StateProblem = {"type": "about:blank", "title": "unsupported", "status": 400,
                                     "detail": "server lacks required capabilities: " + ", ".join(missing)}
            raise StateClientError(400, "unsupported", problem)
        return self._call("POST", "/nuryel/v1/" + verb, request)

    def read(self, request: ReadRequest) -> ReadResponse:
        return cast(ReadResponse, self._verb("read", request))

    def write(self, request: WriteRequest) -> WriteResult:
        return cast(WriteResult, self._verb("write", request))

    def records(self, request: RecordsRequest) -> RecordsResponse:
        return cast(RecordsResponse, self._verb("records", request))

    def subscribe(self, request: SubscribeRequest) -> SubscribeResponse:
        """Poll once. Persist head_seq; on resync rebuild held state before continuing."""
        return cast(SubscribeResponse, self._verb("subscribe", request))

    def capture(self, request: CaptureRequest) -> WriteResult:
        return cast(WriteResult, self._verb("capture", request))

    def capture_batch(self, request: CaptureBatchRequest) -> CaptureBatchResult:
        return cast(CaptureBatchResult, self._verb("capture-batch", request))
