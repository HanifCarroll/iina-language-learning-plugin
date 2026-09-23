"""Local, synthetic transport checks for the packaged Swift executable."""

import http.server
import json
import os
import pathlib
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import unittest


BINARY = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
if BINARY:
    del sys.argv[1]


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen = []
    expected_key = ""
    redirect_port = 0

    def log_message(self, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        authorized = self.headers.get("Authorization") == "Bearer " + self.expected_key
        valid_json = json.loads(body).get("stream") is True
        self.seen.append((self.server.server_port, self.path, authorized, valid_json))
        if self.path == "/redirect-other":
            self.send_response(307)
            self.send_header("Location", f"http://127.0.0.1:{self.redirect_port}/stream")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/unauth":
            self.send_response(401)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/slow-first":
            time.sleep(0.8)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.path == "/slow-first":
            return
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
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.other = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        Handler.redirect_port = cls.other.server_port
        for server in (cls.server, cls.other):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.other.shutdown()

    def run_helper(self, path, *, timeouts=None, stop_after_delta=False):
        with tempfile.TemporaryDirectory() as parent:
            directory = pathlib.Path(parent) / "request"
            process = subprocess.Popen([str(BINARY), str(directory)], stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True, bufsize=1)
            self.assertEqual(process.stdout.readline().strip(), "READY")
            control = os.open(directory / "control", os.O_WRONLY)
            request = os.open(directory / "request", os.O_WRONLY)
            payload = {"url": path, "key": Handler.expected_key,
                       "body": {"model": "mock", "messages": [], "stream": True},
                       "timeouts": timeouts or {}}
            os.write(request, json.dumps(payload).encode())
            os.close(request)
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
            os.close(control)
            process.wait(timeout=5)
            self.assertFalse(directory.exists(), "request FIFO directory must be removed")
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

    def test_stop(self):
        lines, _ = self.run_helper(self.url("/stream"), stop_after_delta=True)
        self.assertEqual(lines[-1], "CANCELLED stop")
        self.assertEqual(len([line for line in lines if line.startswith("DELTA ")]), 1)

    def test_closed_stdout_still_cleans_up(self):
        with tempfile.TemporaryDirectory() as parent:
            directory = pathlib.Path(parent) / "request"
            with subprocess.Popen([str(BINARY), str(directory)], stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True) as process:
                self.assertEqual(process.stdout.readline().strip(), "READY")
                process.stdout.close()
                control = os.open(directory / "control", os.O_WRONLY)
                request = os.open(directory / "request", os.O_WRONLY)
                payload = {"url": self.url("/stream"), "key": Handler.expected_key,
                           "body": {"model": "mock", "messages": [], "stream": True}}
                os.write(request, json.dumps(payload).encode())
                os.close(request)
                self.assertEqual(process.wait(timeout=5), 0)
                os.close(control)
                self.assertFalse(directory.exists())
                self.assertEqual(process.stderr.read(), "")

    def test_boundary_errors(self):
        for url, expected in [
            ("http://example.com/chat/completions", "ERROR request_invalid"),
            ("http://user:pass@127.0.0.1:9/chat/completions", "ERROR request_invalid"),
            (self.url("/redirect-other"), "ERROR redirect_blocked"),
            (self.url("/unauth"), "ERROR http_401"),
        ]:
            with self.subTest(url=url):
                lines, _ = self.run_helper(url)
                self.assertEqual(lines[-1], expected)
        self.assertFalse(any(row[0] == self.other.server_port for row in Handler.seen),
                         "redirect target must receive no request")

    def test_timeouts(self):
        lines, _ = self.run_helper(self.url("/slow-first"), timeouts={"firstByteMs": 300})
        self.assertEqual(lines[-1], "ERROR first_byte_timeout")
        lines, _ = self.run_helper(self.url("/slow-idle"), timeouts={"idleMs": 300})
        self.assertEqual(lines[-1], "ERROR idle_timeout")
        lines, _ = self.run_helper(self.url("/slow-idle"), timeouts={"totalMs": 700})
        self.assertEqual(lines[-1], "ERROR total_timeout")


if __name__ == "__main__":
    unittest.main()
