#!/usr/bin/env python3
"""Local preview server for Mandir Marg.

Serves the static site and emulates the Cloudflare Pages Function at
/api/temples, including a small in-memory cache. No dependencies required.

Usage:
    python tools/dev_server.py
Then open http://127.0.0.1:5173/
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("PORT", "5173"))

MIRRORS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
ALLOWED_RADII = {5000, 10000, 25000, 50000}
CACHE_SECONDS = 30 * 60

_cache: dict[str, tuple[float, list]] = {}
_cache_lock = threading.Lock()


def build_query(lat: float, lng: float, radius: int) -> str:
    return (
        "[out:json][timeout:20];\n"
        'nwr["amenity"="place_of_worship"]["religion"="hindu"]'
        f"(around:{radius},{lat:.5f},{lng:.5f});\n"
        "out center 300;"
    )


def fetch_elements(query: str) -> list | None:
    data = urllib.parse.urlencode({"data": query}).encode()
    for mirror in MIRRORS:
        request = urllib.request.Request(
            mirror,
            data=data,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                "User-Agent": "MandirMarg/0.1 (local preview; temple directory)",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=22) as response:
                payload = json.load(response)
            elements = payload.get("elements")
            if isinstance(elements, list):
                return elements
            print(f"[temples] unexpected response from {mirror}")
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            print(f"[temples] mirror failed: {mirror} ({error})")
    return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/temples":
            self.handle_temples(parsed)
            return

        if parsed.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        super().do_GET()

    def handle_temples(self, parsed: urllib.parse.ParseResult) -> None:
        params = urllib.parse.parse_qs(parsed.query)

        try:
            lat = float(params["lat"][0])
            lng = float(params["lng"][0])
            radius = int(params["radius"][0])
        except (KeyError, ValueError, IndexError):
            self.send_json({"error": "Provide lat, lng and radius."}, status=400)
            return

        if (
            not -90 <= lat <= 90
            or not -180 <= lng <= 180
            or radius not in ALLOWED_RADII
        ):
            self.send_json({"error": "Invalid lat, lng or radius."}, status=400)
            return

        key = f"{lat:.2f},{lng:.2f},{radius}"
        now = time.time()

        with _cache_lock:
            cached = _cache.get(key)
            if cached and cached[0] > now:
                self.send_json({"elements": cached[1], "cached": True})
                return

        elements = fetch_elements(build_query(lat, lng, radius))
        if elements is None:
            self.send_json(
                {"error": "The temple database is temporarily unavailable."},
                status=502,
            )
            return

        with _cache_lock:
            _cache[key] = (now + CACHE_SECONDS, elements)

        self.send_json({"elements": elements, "cached": False})

    def send_json(self, body: dict, status: int = 200) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def end_headers(self) -> None:
        if self.path.endswith((".html", "/")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # Keep the console readable: skip noisy per-asset lines.
        if "/api/" in self.path:
            super().log_message(fmt, *args)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}/"
    print("\n  Mandir Marg is running")
    print(f"      {url}")
    print("      Press Ctrl+C to stop.\n")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Mandir Marg.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
