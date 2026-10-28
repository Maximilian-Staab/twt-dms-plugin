#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 twt-cloud contributors
# Ported from TrackWorkTime's CloudAuthManager
# (https://codeberg.org/mathisdt/trackworktime), Copyright (C) Mathis Dirksen-Thedens and
# contributors, licensed GPL-3.0.
"""twt_auth.py — OAuth 2.0 sign-in helper for the twtBar DMS plugin.

Ports the app's CloudAuthManager flow to the desktop:

  1. GET <apiBase>/config                (bootstrap, unauthenticated)
  2. OIDC discovery from the issuer      (<issuer>/.well-known/openid-configuration)
  3. Authorization Code + PKCE in the default browser; the redirect goes to a
     loopback HTTP listener (RFC 8252). On Android the app used a custom URL
     scheme + AppAuth; on the desktop a loopback listener is the standard.
  4. Code exchange at the token endpoint
  5. Access-token refresh via the stored refresh_token

State (discovered config, tokens, expiry) is a JSON file keyed by the API
base. The widget calls `token` before each backend fetch and gets a valid
access token (this script refreshes when expired).

Three bar instances share one state file; a flock on <state>.lock
serializes concurrent refreshes so they cannot clobber each other.

Output contract (consumed by TwtAuth.js; Proc only forwards stdout):
  success → result on stdout, exit 0
  failure → "ERROR: <reason>" on stdout, exit != 0

  `login` may print an informational `OPEN manually: <url>` line to stdout
  when no browser can be launched; TwtAuth.js ignores it on success and
  prefers the subsequent ERROR line on failure.

Subcommands:
  login   <apiBase> [--force]   run the full flow and store state
  token   <apiBase> [--force]   print a valid access token (refreshing if
                                needed; --force refreshes even when cached)
  whoami  <apiBase>             print the "sub" claim of the stored id_token
  logout  <apiBase>             forget stored state

Environment:
  TWT_AUTH_STATE_DIR  directory for state files (default ~/.local/state/twtBar-auth)
  BROWSER             browser command used by webbrowser.open()
"""

import argparse
import base64
import fcntl
import hashlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HTTP_TIMEOUT = 10
HTTP_USER_AGENT = "twtBar/1.0 (DMS plugin; twt-cloud)"
LOOPBACK_TIMEOUT_SEC = 600
STATE_DIR_ENV = "TWT_AUTH_STATE_DIR"
STATE_DIR_DEFAULT = os.path.expanduser("~/.local/state/twtBar-auth")


def out(msg):
    print(msg, flush=True)


def die(msg, code=1):
    out(f"ERROR: {msg}")
    sys.exit(code)


def state_path(api_base):
    d = os.environ.get(STATE_DIR_ENV) or STATE_DIR_DEFAULT
    key = base64.urlsafe_b64encode(api_base.encode()).decode().rstrip("=")
    return os.path.join(d, key + ".json")


class StateLock:
    """flock on <state>.lock — serializes concurrent refresh/login between
    the three widget instances."""

    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.fd = os.open(path + ".lock", os.O_CREAT | os.O_WRONLY, 0o600)

    def __enter__(self):
        fcntl.flock(self.fd, fcntl.LOCK_EX)

    def __exit__(self, *exc):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


def load_state(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        # Malformed/truncated state must not block a fresh sign-in. Remove it
        # so `login` treats the user as signed out; unlink failures (e.g. a
        # permission error) are handled by callers using this return value
        # instead of os.path.exists().
        try:
            os.unlink(path)
        except OSError:
            pass
        return None


def save_state(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    # Create the temporary file with 0600 before writing tokens, so there is
    # no window (even after os.replace) where the secret is group/world-readable.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def fetch_config(api_base):
    url = api_base.rstrip("/") + "/config"
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": HTTP_USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise ConnectionError(f"config fetch failed: {url}: HTTP {e.code}")
    except (urllib.error.URLError, socket.timeout) as e:
        raise ConnectionError(f"config fetch failed: {url}: {e}")


def discover(issuer):
    url = issuer.rstrip("/") + "/.well-known/openid-configuration"
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": HTTP_USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            doc = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise ConnectionError(f"OIDC discovery failed: {url}: HTTP {e.code}")
    except (urllib.error.URLError, socket.timeout) as e:
        raise ConnectionError(f"OIDC discovery failed: {url}: {e}")
    for k in ("authorization_endpoint", "token_endpoint"):
        if k not in doc:
            raise ValueError(f"discovery document missing '{k}'")
    return doc


def gen_pkce():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).decode().rstrip("=")
    return verifier, challenge


def token_request(token_endpoint, form):
    data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(
        token_endpoint,
        data=data,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": HTTP_USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode()), resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return json.loads(body), e.code
        except json.JSONDecodeError:
            return {"error": body}, e.code
    except (urllib.error.URLError, socket.timeout) as e:
        raise ConnectionError(f"token endpoint unreachable: {token_endpoint}: {e}")


def wait_loopback(srv, timeout_sec=LOOPBACK_TIMEOUT_SEC):
    """Accept the browser redirect on an already-listening socket (RFC 8252).

    The listener must be bound before the browser is launched, otherwise the
    redirect can race the bind. Local probes (favicon, port scanners, health
    checks) must not consume the one-shot flow, so keep accepting until a
    request actually carries `code` or `error` (or the deadline expires).
    """
    deadline = time.monotonic() + timeout_sec
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("no browser redirect within timeout")
            srv.settimeout(remaining)
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                raise TimeoutError("no browser redirect within timeout")
            with conn:
                conn.settimeout(min(10, max(deadline - time.monotonic(), 0.001)))
                req = b""
                try:
                    while b"\r\n\r\n" not in req and len(req) < 65536:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        req += chunk
                except socket.timeout:
                    pass

                first_line = req.split(b"\r\n", 1)[0].decode(errors="replace")
                path = first_line.split(" ")[1] if " " in first_line else ""
                qs = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
                code = qs.get("code", [None])[0]
                state = qs.get("state", [None])[0]
                error = qs.get("error", [None])[0]

                if code is None and error is None:
                    # Not the OAuth redirect: answer the probe and keep waiting
                    # for the real browser redirect.
                    body = b"<html><body><p>twtBar: waiting for sign-in redirect.</p></body></html>"
                    try:
                        conn.sendall(
                            b"HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\n"
                            b"Content-Length: " + str(len(body)).encode()
                            + b"\r\nConnection: close\r\n\r\n" + body
                        )
                    except OSError:
                        pass
                    continue

                body = b"<html><body><p>twtBar: sign-in complete, you can close this tab.</p></body></html>"
                try:
                    conn.sendall(
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n"
                        b"Content-Length: " + str(len(body)).encode()
                        + b"\r\nConnection: close\r\n\r\n" + body
                    )
                except OSError:
                    pass
                return code, state, error
    finally:
        srv.close()


def _open_browser(url):
    """Launch the default browser without blocking on it.

    webbrowser.open() with a GenericBrowser blocks on p.wait(); that deadlocks
    a loopback-redirect flow, since the redirect must be accepted while the
    "browser" process is still running. xdg-open (or the BROWSER env var,
    split on whitespace) is spawned via subprocess.Popen; a launcher that
    fails within half a second falls through to a printed URL.
    """
    browser = os.environ.get("BROWSER", "").strip()
    if not browser and shutil.which("xdg-open") is None:
        return None
    try:
        if browser:
            proc = subprocess.Popen(
                browser.split() + [url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            proc = subprocess.Popen(
                ["xdg-open", url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        # A launcher that fails immediately (no browser installed, bad
        # handler) must fall back to the printed URL instead of looking like
        # a successful launch. Real browsers/handlers keep running past this.
        try:
            return proc.pid if proc.wait(timeout=0.5) == 0 else None
        except subprocess.TimeoutExpired:
            return proc.pid
    except OSError:
        return None

def id_token_sub(id_token):
    """Decode the id_token payload without verification (it came from the
    token endpoint over TLS, so it is as trusted as the access token)."""
    if not id_token:
        return ""
    try:
        payload = id_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("sub", "")
    except Exception:
        return ""


def cmd_login(args):
    api_base = args.api_base.rstrip("/")
    path = state_path(api_base)
    if load_state(path) is not None and not args.force:
        die("already signed in")
    config = fetch_config(api_base)
    issuer = config["issuer"]
    client_id = config["clientId"]
    if config.get("flow", "authorization_code_pkce") != "authorization_code_pkce":
        die(f"unsupported OAuth flow: {config.get('flow')}")
    scopes = list(config.get("scopes") or [])
    if "offline_access" not in scopes:
        scopes.append("offline_access")

    doc = discover(issuer)
    state_rand = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    verifier, challenge = gen_pkce()

    # bind the loopback listener before the browser opens, so the redirect
    # always finds a waiting socket (RFC 8252 §7.3)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    port = srv.getsockname()[1]
    redirect_uri = f"http://127.0.0.1:{port}/"

    auth_url = doc["authorization_endpoint"] + "?" + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": " ".join(scopes),
        "state": state_rand,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    opened = _open_browser(auth_url)
    if opened:
        print("browser launched", file=sys.stderr)
    else:
        # Proc only forwards stdout to the widget. Printing the URL here keeps
        # it visible in the sign-in error instead of losing it on stderr.
        out(f"OPEN manually: {auth_url}")

    try:
        code, got_state, error = wait_loopback(srv)
    except TimeoutError as e:
        die(f"{e}; open manually: {auth_url}")
    finally:
        srv.close()
    if error:
        die(f"authorization error: {error}")
    if not code:
        die("no authorization code in redirect")
    if got_state != state_rand:
        die("state mismatch — aborting")

    with StateLock(path):
        if load_state(path) is not None and not args.force:
            die("already signed in")
        tokens, status = token_request(doc["token_endpoint"], {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "code_verifier": verifier,
        })
        if status != 200 or "access_token" not in tokens:
            die(f"token exchange failed: HTTP {status} {tokens}")
        now = int(time.time())
        st = {
            "api_base": api_base,
            "issuer": issuer,
            "client_id": client_id,
            "discovered": doc,
            "access_token": tokens["access_token"],
            "refresh_token": tokens.get("refresh_token"),
            "id_token": tokens.get("id_token"),
            "obtained_at": now,
            "expires_at": now + int(tokens.get("expires_in", 3600)),
            "scope": " ".join(scopes),
        }
        save_state(path, st)
    out(f"OK sub={id_token_sub(tokens.get('id_token'))}")


def cmd_token(args):
    api_base = args.api_base.rstrip("/")
    path = state_path(api_base)
    with StateLock(path):
        st = load_state(path)
        if not st:
            die("not signed in")
        now = int(time.time())
        fresh = st.get("expires_at", 0) - now > 60
        if fresh and not args.force:
            out(st["access_token"])
            return
        if not st.get("refresh_token"):
            if fresh:
                # --force but nothing to refresh with: return the cached token
                out(st["access_token"])
                return
            # expired without refresh token: state is permanently unusable
            os.unlink(path)
            die("token expired and no refresh token; sign in again")
        tokens, status = token_request(st["discovered"]["token_endpoint"], {
            "grant_type": "refresh_token",
            "refresh_token": st["refresh_token"],
            "client_id": st["client_id"],
        })
        if status != 200 or "access_token" not in tokens:
            if status in (400, 401, 403):
                # refresh token no longer usable (expired/revoked/session
                # ended): drop the whole auth state, the user signs in again
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass
                die("refresh token no longer valid; sign in again")
            die(f"refresh failed: HTTP {status} {tokens}")
        st["access_token"] = tokens["access_token"]
        st["refresh_token"] = tokens.get("refresh_token", st["refresh_token"])
        st["id_token"] = tokens.get("id_token", st.get("id_token"))
        st["obtained_at"] = now
        st["expires_at"] = now + int(tokens.get("expires_in", 3600))
        save_state(path, st)
    out(st["access_token"])


def cmd_whoami(args):
    api_base = args.api_base.rstrip("/")
    st = load_state(state_path(api_base))
    if not st:
        die("not signed in")
    out(id_token_sub(st.get("id_token")) or "-")


def cmd_logout(args):
    api_base = args.api_base.rstrip("/")
    path = state_path(api_base)
    with StateLock(path):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    out("OK")


def main():
    parser = argparse.ArgumentParser(description="twtBar OAuth sign-in helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def add(name, fn, force=False):
        p = sub.add_parser(name)
        p.add_argument("api_base")
        if force:
            p.add_argument("--force", action="store_true")
        p.set_defaults(func=fn)

    add("login", cmd_login, force=True)
    add("token", cmd_token, force=True)
    add("whoami", cmd_whoami)
    add("logout", cmd_logout)

    args = parser.parse_args()
    try:
        args.func(args)
    except (ConnectionError, TimeoutError, ValueError, KeyError) as e:
        die(str(e))


if __name__ == "__main__":
    main()
