"""Local, synthetic transport checks for the packaged Swift executable."""

import http.server
import json
import os
import pathlib
import secrets
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest


BINARY = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
if BINARY:
    del sys.argv[1]


class MockServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            super().handle_error(request, client_address)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen = []
    expected_key = ""
    redirect_port = 0

    def log_message(self, *_args):
        pass

    def do_POST(self):

        # 1. Record authorization and streaming flags without retaining request content.
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        authorized = self.headers.get("Authorization") == "Bearer " + self.expected_key
        valid_json = json.loads(body).get("stream") is True
        self.seen.append((self.server.server_port, self.path, authorized, valid_json))

        # 2. Exercise redirect and HTTP-error boundaries.
        if self.path == "/redirect-other":
            self.send_response(307)
            self.send_header(
                "Location", f"http://127.0.0.1:{self.redirect_port}/stream"
            )
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if self.path == "/redirect-same":
            self.send_response(307)
            self.send_header("Location", "/stream")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if self.path == "/redirect-get":
            self.send_response(302)
            self.send_header("Location", "/stream")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if self.path in ("/unauth", "/forbidden"):
            self.send_response(401 if self.path == "/unauth" else 403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if self.path in ("/rate-limit", "/outage"):
            self.send_response(429 if self.path == "/rate-limit" else 503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        # 3. Serve malformed, interrupted, or delayed streaming scenarios.
        if self.path == "/slow-first":
            time.sleep(0.8)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.path == "/batched-events":
            event = b'data: {"choices":[{"delta":{"content":"x"}}]}\n\n'
            self.wfile.write(event * 2000 + b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        if self.path == "/invalid":
            self.wfile.write(b"data: {broken}\n\n")
            self.wfile.flush()
            return

        if self.path == "/interrupted":
            self.wfile.write(b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
            self.wfile.flush()
            self.close_connection = True
            return

        if self.path == "/slow-first":
            return

        # 4. Flush separate events so the tests can measure incremental delivery.
        parts = ["Ön", "ce", " test"]
        for index, part in enumerate(parts):
            payload = json.dumps({"choices": [{"delta": {"content": part}}]})
            try:
                self.wfile.write(f"data: {payload}\n\n".encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return

            time.sleep(0.6 if self.path == "/slow-idle" else 0.3)
        try:
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class HelperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert BINARY and BINARY.is_file()
        Handler.expected_key = secrets.token_urlsafe(20)
        cls.server = MockServer(("127.0.0.1", 0), Handler)
        cls.other = MockServer(("127.0.0.1", 0), Handler)
        Handler.redirect_port = cls.other.server_port
        for server in (cls.server, cls.other):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.other.shutdown()
        cls.server.server_close()
        cls.other.server_close()

    def run_helper(self, path, *, timeouts=None, stop_after_delta=False):

        # 1. Start the helper in a private request directory.
        with tempfile.TemporaryDirectory() as parent:
            directory = pathlib.Path(parent) / "request"
            process = subprocess.Popen(
                [str(BINARY), str(directory)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )

            # 2. Wait for readiness before writing the authenticated payload through a pipe.
            self.assertEqual(process.stdout.readline().strip(), "READY")
            control = os.open(directory / "control", os.O_WRONLY)
            request = os.open(directory / "request", os.O_WRONLY)
            payload = {
                "url": path,
                "key": Handler.expected_key,
                "body": {"model": "mock", "messages": [], "stream": True},
                "timeouts": timeouts or {},
            }
            os.write(request, json.dumps(payload).encode())
            os.close(request)

            # 3. Capture frames and timing, optionally cancelling after the first delta.
            received = []
            times = []
            started = time.monotonic()
            for line in process.stdout:
                line = line.strip()
                received.append(line)
                times.append(time.monotonic() - started)
                if stop_after_delta and line.startswith("DELTA "):
                    os.write(control, b"STOP\n")
                    stop_after_delta = False

            # 4. Verify process cleanup and empty stderr before returning the observations.
            os.close(control)
            process.wait(timeout=5)
            self.assertFalse(
                directory.exists(), "request FIFO directory must be removed"
            )
            self.assertEqual(process.stderr.read(), "")
            process.stdout.close()
            process.stderr.close()
            return received, times

    def url(self, path):
        return f"http://127.0.0.1:{self.server.server_port}{path}"

    def test_incremental_auth_and_cleanup(self):
        lines, times = self.run_helper(self.url("/stream"))
        self.assertEqual(lines[-1], "DONE")
        self.assertEqual(len([line for line in lines if line.startswith("DELTA ")]), 3)
        self.assertLess(times[0], times[-1] - 0.4)
        self.assertIn((self.server.server_port, "/stream", True, True), Handler.seen)

    def test_many_small_events_in_one_network_write(self):
        lines, _ = self.run_helper(self.url("/batched-events"))
        self.assertEqual(lines[-1], "DONE")
        self.assertEqual(
            len([line for line in lines if line.startswith("DELTA ")]), 2000
        )

    def test_stop(self):
        lines, _ = self.run_helper(self.url("/stream"), stop_after_delta=True)
        self.assertEqual(lines[-1], "CANCELLED stop")
        self.assertEqual(len([line for line in lines if line.startswith("DELTA ")]), 1)

    def test_closed_stdout_still_cleans_up(self):

        # 1. Start the helper and simulate the host closing its output pipe.
        with tempfile.TemporaryDirectory() as parent:
            directory = pathlib.Path(parent) / "request"
            with subprocess.Popen(
                [str(BINARY), str(directory)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            ) as process:
                self.assertEqual(process.stdout.readline().strip(), "READY")
                process.stdout.close()

                # 2. Submit a synthetic request after the output reader has gone away.
                control = os.open(directory / "control", os.O_WRONLY)
                request = os.open(directory / "request", os.O_WRONLY)
                payload = {
                    "url": self.url("/stream"),
                    "key": Handler.expected_key,
                    "body": {"model": "mock", "messages": [], "stream": True},
                }
                os.write(request, json.dumps(payload).encode())
                os.close(request)

                # 3. Verify the helper still exits and removes its private pipes.
                self.assertEqual(process.wait(timeout=5), 0)
                os.close(control)
                self.assertFalse(directory.exists())
                self.assertEqual(process.stderr.read(), "")

    def test_boundary_errors(self):
        for url, expected in [
            ("http://example.com/chat/completions", "ERROR request_invalid"),
            ("http://user:pass@127.0.0.1:9/chat/completions", "ERROR request_invalid"),
            (self.url("/redirect-other"), "ERROR redirect_blocked"),
            (self.url("/redirect-get"), "ERROR redirect_blocked"),
            (self.url("/unauth"), "ERROR http_401"),
            (self.url("/forbidden"), "ERROR http_403"),
            (self.url("/rate-limit"), "ERROR http_429"),
            (self.url("/outage"), "ERROR http_503"),
            (self.url("/invalid"), "ERROR invalid_sse"),
        ]:
            with self.subTest(url=url):
                lines, _ = self.run_helper(url)
                self.assertEqual(lines[-1], expected)
        self.assertFalse(
            any(row[0] == self.other.server_port for row in Handler.seen),
            "redirect target must receive no request",
        )

    def test_same_origin_redirect_preserves_auth(self):
        before = len(Handler.seen)
        lines, _ = self.run_helper(self.url("/redirect-same"))
        self.assertEqual(lines[-1], "DONE")
        seen = Handler.seen[before:]
        self.assertEqual([row[1] for row in seen], ["/redirect-same", "/stream"])
        self.assertTrue(all(row[2] for row in seen))

    def test_tls_rejects_untrusted_certificate(self):

        # 1. Generate a temporary certificate that the system does not trust.
        with tempfile.TemporaryDirectory() as directory:
            cert = pathlib.Path(directory) / "cert.pem"
            key = pathlib.Path(directory) / "key.pem"
            subprocess.run(
                [
                    "openssl",
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-keyout",
                    str(key),
                    "-out",
                    str(cert),
                    "-days",
                    "1",
                    "-subj",
                    "/CN=localhost",
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            # 2. Start a local TLS endpoint with that certificate.
            server = MockServer(("127.0.0.1", 0), Handler)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(str(cert), str(key))
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            # 3. Verify TLS rejection and close the endpoint even if the check fails.
            try:
                lines, _ = self.run_helper(
                    f"https://127.0.0.1:{server.server_port}/stream"
                )
                self.assertEqual(lines[-1], "ERROR tls_failure")
            finally:
                server.shutdown()
                server.server_close()

    def test_timeouts(self):
        lines, _ = self.run_helper(
            self.url("/slow-first"), timeouts={"firstByteMs": 300}
        )
        self.assertEqual(lines[-1], "ERROR first_byte_timeout")
        lines, _ = self.run_helper(self.url("/slow-idle"), timeouts={"idleMs": 300})
        self.assertEqual(lines[-1], "ERROR idle_timeout")
        lines, _ = self.run_helper(self.url("/slow-idle"), timeouts={"totalMs": 700})
        self.assertEqual(lines[-1], "ERROR total_timeout")

    def test_interrupted_stream_reports_failure_after_partial_output(self):
        lines, _ = self.run_helper(self.url("/interrupted"))
        self.assertEqual(lines[-1], "ERROR interrupted")
        self.assertTrue(any(line.startswith("DELTA ") for line in lines))

    def test_unopened_request_pipe_times_out_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as parent:
            directory = pathlib.Path(parent) / "request"
            with subprocess.Popen(
                [str(BINARY), str(directory)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            ) as process:
                self.assertEqual(process.stdout.readline().strip(), "READY")
                self.assertEqual(
                    process.stdout.readline().strip(), "ERROR request_timeout"
                )
                self.assertNotEqual(process.wait(timeout=3), 0)
                self.assertFalse(directory.exists())


if __name__ == "__main__":
    unittest.main()
