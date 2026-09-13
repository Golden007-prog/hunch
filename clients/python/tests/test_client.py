import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from hunch_state import StateClient, StateClientError, StateTransportError


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.mode, self.paths = "unsupported", []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                owner.paths.append(self.path)
                if owner.mode == "timeout":
                    time.sleep(0.15)
                    return
                if owner.mode == "redirect":
                    self.send_response(307)
                    self.send_header("Location", "/redirected")
                    self.end_headers()
                    return
                value = (b"x" * 200 if owner.mode == "large" else b"not-json" if owner.mode == "invalid"
                         else json.dumps({"protocol": "nuryel.state/1", "capabilities": ["nuryel.state.write/1"] if owner.mode == "write-failure" else []}).encode())
                self.send_response(200)
                self.send_header("Content-Length", str(len(value)))
                self.end_headers()
                self.wfile.write(value)

            def do_POST(self):
                owner.paths.append('POST ' + self.path)
                self.rfile.read(int(self.headers.get('Content-Length', '0')))
                # Simulate a lost result after a write reached the server.
                self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_unsupported_before_post(self):
        with self.assertRaises(StateClientError) as result:
            StateClient(self.url, "fixture").read({"scope": {"kind": "organization", "id": "test"}})
        self.assertEqual(result.exception.code, "unsupported")
        self.assertEqual(len(self.paths), 1)

    def test_transport_failures_do_not_retry(self):
        for mode, code in [("redirect", "redirect"), ("invalid", "invalid-response"),
                           ("large", "response-too-large"), ("timeout", "timeout")]:
            with self.subTest(mode=mode):
                self.mode, self.paths = mode, []
                with self.assertRaises(StateTransportError) as result:
                    StateClient(self.url, "fixture", timeout=0.05, max_response_bytes=100).health()
                self.assertEqual(result.exception.code, code)
                self.assertEqual(len(self.paths), 1)

    def test_invalid_configuration_never_connects(self):
        for url in ["ftp://host", "https://user:pass@host", "https://host/?token=x", "https://host/#fragment", "https://host/\n"]:
            with self.assertRaises(ValueError):
                StateClient(url, "fixture")
        for timeout in [0, -1, float("nan"), float("inf"), 301]:
            with self.assertRaises(ValueError):
                StateClient(self.url, "fixture", timeout=timeout)
        with self.assertRaises(ValueError):
            StateClient(self.url, "fixture", proof=lambda request: "proof")
        with self.assertRaises(ValueError):
            StateClient(self.url, "fixture\r\nInjected: value")
        self.assertEqual(self.paths, [])

    def test_lost_write_result_is_not_retried_and_oversized_body_is_not_sent(self):
        self.mode = 'write-failure'
        client = StateClient(self.url, 'fixture')
        request = {'scope': {'kind': 'organization', 'id': 'test'}, 'facet': 'derived',
                   'record': {}, 'idempotency_key': 'fixture-write'}
        with self.assertRaises(StateTransportError) as result:
            client.write(request)
        self.assertEqual(result.exception.code, 'connection')
        self.assertEqual(sum(path.startswith('POST ') for path in self.paths), 1)
        self.paths = []
        with self.assertRaises(ValueError):
            client.write({**request, 'record': {'content': 'x' * (1024 * 1024)}})
        self.assertFalse(any(path.startswith('POST ') for path in self.paths))


if __name__ == "__main__":
    unittest.main()
