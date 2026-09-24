"""Synthetic local SSE endpoint for the installed-IINA integration milestone."""

import http.server
import json
import threading
import time


class Mock(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        try:
            request = json.loads(body)
            if not isinstance(request, dict):
                request = {}
            valid = request.get("stream") is True
        except (ValueError, UnicodeDecodeError):
            request = {}
            valid = False
        authorized = self.headers.get("Authorization", "").startswith("Bearer fixture-")
        print(json.dumps({"path": self.path, "authorized": authorized, "stream": valid}), flush=True)
        if self.path == "/redirect-other":
            self.send_response(307)
            self.send_header("Location", "http://127.0.0.1:47892/received")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/unauth":
            self.send_response(401)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/slow-first":
            time.sleep(1.0)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if self.path == "/slow-first":
            return
        parts = ["Ön", "ce", " —", " gerçek", " akış"]
        if self.path == "/chat/completions":
            parts = (["**Follow-up**\n", "This is a synthetic reply ", "to test the chat layout."]
                     if len(request.get("messages", [])) > 2 else
                     ["**Natural meaning**\n", "A synthetic explanation for the selected phrase.\n\n",
                      "**Literal meaning**\n", "A synthetic word-by-word gloss.\n\n",
                      "**Breakdown**\n", "This text tests Markdown rendering and streaming."])
        if self.path == "/long":
            parts = [f"chunk {i} " for i in range(100)]
        for index, part in enumerate(parts):
            event = json.dumps({"choices": [{"delta": {"content": part}}]})
            try:
                self.wfile.write(f"data: {event}\n\n".encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                print(json.dumps({"path": self.path, "disconnected": True,
                                  "after": index}), flush=True)
                return
            time.sleep(1.0 if self.path == "/slow-idle" else 0.25)
        try:
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class RedirectTarget(Mock):
    def do_POST(self):
        print(json.dumps({"redirect_target_received": True,
                          "has_auth": bool(self.headers.get("Authorization"))}), flush=True)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()


def serve(port, handler):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == "__main__":
    first = serve(47891, Mock)
    second = serve(47892, RedirectTarget)
    print("mock ready", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        first.shutdown()
        second.shutdown()
