import json
import hashlib
import hmac
import os
import socket
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


PORT = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else "4173"))
ROOT = Path(__file__).resolve().parent
STATE_FILE = ROOT / "state.json"
PASSWORD_FILE = ROOT / "control-password.txt"

BLIND_STRUCTURE = [
    {"smallBlind": 10, "bigBlind": 20},
    {"smallBlind": 20, "bigBlind": 40},
    {"smallBlind": 50, "bigBlind": 100},
    {"smallBlind": 100, "bigBlind": 200},
    {"smallBlind": 200, "bigBlind": 400},
    {"smallBlind": 300, "bigBlind": 600},
    {"smallBlind": 400, "bigBlind": 800},
    {"smallBlind": 500, "bigBlind": 1000},
    {"smallBlind": 700, "bigBlind": 1400},
    {"smallBlind": 1000, "bigBlind": 2000},
    {"smallBlind": 2000, "bigBlind": 4000},
    {"smallBlind": 3000, "bigBlind": 6000},
]

DEFAULTS = {
    "running": False,
    "level": 1,
    "levelMinutes": 25,
    "entryMinutes": 58,
    "breakMinutes": 25,
    "levelRemaining": 25 * 60,
    "entryRemaining": 58 * 60,
    "breakRemaining": 25 * 60,
    "players": 9,
    "playerMax": 9,
    "prizePlayers": 3,
    "handCount": 9,
    "buyInChips": 3000,
    "totalChips": 9 * 3000,
    "smallBlind": 10,
    "bigBlind": 20,
    "ante": 0,
    "nextSmallBlind": 20,
    "nextBigBlind": 40,
    "nextAnte": 0,
}

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

state_lock = threading.Lock()
clients_lock = threading.Lock()
clients = set()
last_tick = time.time()
dirty = False


def control_password():
    env_password = os.environ.get("CONTROL_PASSWORD")
    if env_password:
        return env_password.strip()
    try:
        password = PASSWORD_FILE.read_text(encoding="utf-8").strip()
        return password or "bluff2026"
    except FileNotFoundError:
        return "bluff2026"


def auth_token():
    seed = f"green-texas-scoreboard:{control_password()}"
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


def cookie_value(headers, name):
    raw_cookie = headers.get("Cookie", "")
    for part in raw_cookie.split(";"):
        if "=" not in part:
            continue
        key, value = part.strip().split("=", 1)
        if key == name:
            return value
    return ""


def is_authenticated(headers):
    return hmac.compare_digest(cookie_value(headers, "control_auth"), auth_token())


def safe_int(value, fallback=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return fallback


def blind_for_level(level):
    safe_level = max(1, safe_int(level, 1))
    blind = BLIND_STRUCTURE[(safe_level - 1) % len(BLIND_STRUCTURE)]
    ante = blind["bigBlind"] if safe_level >= 5 else 0
    return {**blind, "ante": ante}


def blind_patch_for_level(level):
    current = blind_for_level(level)
    next_blind = blind_for_level(safe_int(level, 1) + 1)
    return {
        "smallBlind": current["smallBlind"],
        "bigBlind": current["bigBlind"],
        "ante": current["ante"],
        "nextSmallBlind": next_blind["smallBlind"],
        "nextBigBlind": next_blind["bigBlind"],
        "nextAnte": next_blind["ante"],
    }


def normalize_state(data):
    next_state = {**DEFAULTS, **data}
    next_state["level"] = max(1, safe_int(next_state["level"], 1))
    next_state["levelMinutes"] = max(1, safe_int(next_state["levelMinutes"], DEFAULTS["levelMinutes"]))
    next_state["entryMinutes"] = max(0, safe_int(next_state["entryMinutes"], DEFAULTS["entryMinutes"]))
    next_state["breakMinutes"] = max(0, safe_int(next_state["breakMinutes"], DEFAULTS["breakMinutes"]))
    next_state["levelRemaining"] = max(0, safe_int(next_state["levelRemaining"], DEFAULTS["levelRemaining"]))
    next_state["entryRemaining"] = max(0, safe_int(next_state["entryRemaining"], DEFAULTS["entryRemaining"]))
    next_state["breakRemaining"] = max(0, safe_int(next_state["breakRemaining"], DEFAULTS["breakRemaining"]))
    next_state["players"] = max(0, safe_int(next_state["players"], DEFAULTS["players"]))
    next_state["playerMax"] = max(1, safe_int(next_state["playerMax"], DEFAULTS["playerMax"]))
    next_state["prizePlayers"] = max(0, safe_int(next_state["prizePlayers"], DEFAULTS["prizePlayers"]))
    next_state["handCount"] = max(0, safe_int(next_state["handCount"], DEFAULTS["handCount"]))
    next_state["buyInChips"] = max(0, safe_int(next_state["buyInChips"], DEFAULTS["buyInChips"]))
    next_state["handCount"] = max(next_state["handCount"], next_state["players"])
    next_state["totalChips"] = next_state["handCount"] * next_state["buyInChips"]
    return {**next_state, **blind_patch_for_level(next_state["level"])}


def load_state():
    try:
        with STATE_FILE.open("r", encoding="utf-8") as file:
            return normalize_state({**DEFAULTS, **json.load(file)})
    except (FileNotFoundError, json.JSONDecodeError):
        return normalize_state(DEFAULTS)


state = load_state()


def save_state():
    global dirty
    with STATE_FILE.open("w", encoding="utf-8") as file:
        json.dump(state, file, ensure_ascii=False, indent=2)
    dirty = False


def clean_patch(data):
    patch = {}
    for key in DEFAULTS:
        if key not in data:
            continue
        if key == "running":
            patch[key] = bool(data[key])
            continue
        try:
            patch[key] = max(0, int(float(data[key])))
        except (TypeError, ValueError):
            pass
    return patch


def public_state():
    with state_lock:
        return normalize_state(state)


def broadcast():
    payload = f"data: {json.dumps(public_state(), ensure_ascii=False)}\n\n".encode("utf-8")
    stale = []
    with clients_lock:
        targets = list(clients)
    for client in targets:
        try:
            client.write(payload)
            client.flush()
        except OSError:
            stale.append(client)
    if stale:
        with clients_lock:
            for client in stale:
                clients.discard(client)


def apply_elapsed():
    global dirty, last_tick
    now = time.time()
    elapsed = int(now - last_tick)
    if elapsed <= 0:
        return False

    last_tick += elapsed
    with state_lock:
        if not state["running"]:
            return False
        state["levelRemaining"] -= elapsed
        state["entryRemaining"] = max(0, state["entryRemaining"] - elapsed)
        state["breakRemaining"] = max(0, state["breakRemaining"] - elapsed)
        level_seconds = max(60, safe_int(state["levelMinutes"], DEFAULTS["levelMinutes"]) * 60)
        while state["levelRemaining"] <= 0:
            state["level"] += 1
            state["levelRemaining"] += level_seconds
        state.update(normalize_state(state))
        dirty = True
    return True


def timer_loop():
    while True:
        time.sleep(1)
        if apply_elapsed():
            broadcast()
        if dirty:
            with state_lock:
                save_state()


def lan_addresses():
    addresses = set()
    try:
        host_name = socket.gethostname()
        for item in socket.getaddrinfo(host_name, None, socket.AF_INET):
            address = item[4][0]
            if not address.startswith("127."):
                addresses.add(address)
    except OSError:
        pass
    return sorted(addresses)


class ScoreboardHandler(SimpleHTTPRequestHandler):
    server_version = "GreenTexasScoreboard/1.0"

    def log_message(self, format, *args):
        return

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/session":
            self.send_json(200, {"authenticated": is_authenticated(self.headers)})
            return

        if parsed.path == "/api/state":
            self.send_json(200, public_state())
            return

        if parsed.path == "/api/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            with clients_lock:
                clients.add(self.wfile)
            try:
                self.wfile.write(f"data: {json.dumps(public_state(), ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
                while True:
                    time.sleep(25)
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                with clients_lock:
                    clients.discard(self.wfile)
            return

        if parsed.path in ("/login", "/login.html"):
            if is_authenticated(self.headers):
                self.redirect("/control")
                return
            self.serve_static("/login.html")
            return

        if parsed.path in ("/control", "/control.html") and not is_authenticated(self.headers):
            self.serve_static("/login.html")
            return

        self.serve_static(parsed.path)

    def do_HEAD(self):
        self.serve_static(urlparse(self.path).path, head_only=True)

    def do_POST(self):
        global dirty, last_tick, state
        parsed = urlparse(self.path)

        if parsed.path == "/api/login":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length).decode("utf-8") if length else "{}"
                password = json.loads(body).get("password", "")
            except (ValueError, json.JSONDecodeError):
                self.send_json(400, {"error": "Bad request"})
                return

            if hmac.compare_digest(str(password), control_password()):
                self.send_response(204)
                self.send_header(
                    "Set-Cookie",
                    f"control_auth={auth_token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800",
                )
                self.end_headers()
                return

            self.send_json(401, {"error": "Wrong password"})
            return

        if parsed.path == "/api/logout":
            self.send_response(204)
            self.send_header("Set-Cookie", "control_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
            self.end_headers()
            return

        if parsed.path != "/api/state":
            self.send_json(404, {"error": "Not found"})
            return

        if not is_authenticated(self.headers):
            self.send_json(401, {"error": "Login required"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8") if length else "{}"
            patch = clean_patch(json.loads(body))
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Bad request"})
            return

        with state_lock:
            state = normalize_state({**state, **patch})
            last_tick = time.time()
            dirty = True
            save_state()

        broadcast()
        self.send_json(200, public_state())

    def send_json(self, status, data):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.end_headers()

    def serve_static(self, raw_path, head_only=False):
        route = "/" if raw_path == "" else raw_path
        if route == "/":
            route = "/index.html"
        elif route == "/control":
            route = "/control.html"

        requested = (ROOT / unquote(route).lstrip("/")).resolve()
        try:
            if os.path.commonpath([ROOT, requested]) != str(ROOT):
                self.send_error(403)
                return
        except ValueError:
            self.send_error(403)
            return

        if not requested.is_file():
            self.send_error(404)
            return

        payload = requested.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME_TYPES.get(requested.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if not head_only:
            self.wfile.write(payload)


if __name__ == "__main__":
    threading.Thread(target=timer_loop, daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), ScoreboardHandler)
    print(f"Display: http://127.0.0.1:{PORT}/")
    print(f"Control: http://127.0.0.1:{PORT}/control")
    for address in lan_addresses():
        print(f"LAN display: http://{address}:{PORT}/")
        print(f"LAN control: http://{address}:{PORT}/control")
    httpd.serve_forever()
