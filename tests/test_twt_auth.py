# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 twt-cloud contributors
"""Unit tests for twt_auth.py: PKCE, state handling, refresh, loopback."""

import argparse
import base64
import contextlib
import hashlib
import io
import os
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import twt_auth  # noqa: E402


class PkceAndStateTests(unittest.TestCase):
    def test_gen_pkce_uses_s256(self):
        verifier, challenge = twt_auth.gen_pkce()
        self.assertEqual(len(verifier), 43)  # 32 bytes -> 43 base64url chars
        expected = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode()).digest()
        ).decode().rstrip("=")
        self.assertEqual(challenge, expected)
        self.assertNotIn("=", verifier)
        self.assertNotIn("=", challenge)

    def test_state_path_is_urlsafe_b64_of_api_base(self):
        api_base = "http://127.0.0.1:9080/api/v1"
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ, {twt_auth.STATE_DIR_ENV: tmp}
        ):
            path = twt_auth.state_path(api_base)
            key = base64.urlsafe_b64encode(api_base.encode()).decode().rstrip("=")
            self.assertEqual(os.path.dirname(path), tmp)
            self.assertEqual(os.path.basename(path), key + ".json")
            self.assertNotIn("=", os.path.basename(path))

    def test_save_state_round_trips_with_0600(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            state = {"access_token": "secret", "refresh_token": "refresh"}
            twt_auth.save_state(path, state)
            self.assertEqual(twt_auth.load_state(path), state)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_load_state_removes_malformed_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            Path(path).write_text("{not json", encoding="utf-8")
            self.assertIsNone(twt_auth.load_state(path))
            self.assertFalse(os.path.exists(path))

    def test_id_token_sub_decodes_payload(self):
        payload = base64.urlsafe_b64encode(b'{"sub":"user-123"}').decode().rstrip("=")
        self.assertEqual(twt_auth.id_token_sub("header." + payload + ".sig"), "user-123")
        self.assertEqual(twt_auth.id_token_sub("garbage"), "")

    def test_open_browser_returns_none_when_launcher_fails(self):
        with mock.patch.dict(os.environ, {"BROWSER": "browser"}), mock.patch.object(
            twt_auth.subprocess, "Popen"
        ) as popen:
            popen.return_value.wait.return_value = 1
            self.assertIsNone(twt_auth._open_browser("http://example"))

    def test_open_browser_returns_pid_when_launcher_succeeds(self):
        with mock.patch.dict(os.environ, {"BROWSER": "browser"}), mock.patch.object(
            twt_auth.subprocess, "Popen"
        ) as popen:
            popen.return_value.pid = 4242
            popen.return_value.wait.return_value = 0
            self.assertEqual(twt_auth._open_browser("http://example"), 4242)


def _listener():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    return srv, srv.getsockname()[1]


def _http_get(port, target):
    with socket.create_connection(("127.0.0.1", port), timeout=5) as conn:
        conn.sendall(b"GET " + target + b" HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
        return data


class LoopbackTests(unittest.TestCase):
    def test_stray_connection_does_not_consume_redirect(self):
        srv, port = _listener()
        result = {}

        def run():
            try:
                result["value"] = twt_auth.wait_loopback(srv, timeout_sec=5)
            except BaseException as exc:  # surface thread failures in the test
                result["error"] = exc

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        try:
            self.assertIn(b"400", _http_get(port, b"/favicon.ico"))
            self.assertIn(b"200", _http_get(port, b"/?code=abc&state=state-1"))
        finally:
            thread.join(5)

        self.assertNotIn("error", result)
        self.assertEqual(result.get("value"), ("abc", "state-1", None))

    def test_timeout_raises_and_closes_listener(self):
        srv, _ = _listener()
        with self.assertRaises(TimeoutError):
            twt_auth.wait_loopback(srv, timeout_sec=0.05)


class HttpErrorTests(unittest.TestCase):
    def test_fetch_config_reports_http_status(self):
        err = urllib.error.HTTPError("http://api/config", 404, "Not Found", {}, None)
        with mock.patch.object(twt_auth.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(ConnectionError) as ctx:
                twt_auth.fetch_config("http://api")
        self.assertIn("HTTP 404", str(ctx.exception))

    def test_discover_reports_http_status(self):
        err = urllib.error.HTTPError("https://idp/.well-known/openid-configuration",
                                     503, "Unavailable", {}, None)
        with mock.patch.object(twt_auth.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(ConnectionError) as ctx:
                twt_auth.discover("https://idp")
        self.assertIn("HTTP 503", str(ctx.exception))


class TokenCommandTests(unittest.TestCase):
    API = "http://127.0.0.1:9080/api/v1"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = mock.patch.dict(os.environ, {twt_auth.STATE_DIR_ENV: self.tmp.name})
        env.start()
        self.addCleanup(env.stop)

    def _path(self):
        return twt_auth.state_path(self.API)

    def _write_state(self, **overrides):
        state = {
            "api_base": self.API,
            "issuer": "https://idp.example",
            "client_id": "client",
            "discovered": {"token_endpoint": "https://idp.example/token"},
            "access_token": "old-token",
            "refresh_token": "old-refresh",
            "id_token": None,
            "obtained_at": 0,
            "expires_at": int(time.time()) + 3600,
            "scope": "openid offline_access",
        }
        state.update(overrides)
        twt_auth.save_state(self._path(), state)
        return state

    def _run_token(self, force=False):
        buf = io.StringIO()
        with redirect_stdout(buf):
            twt_auth.cmd_token(argparse.Namespace(api_base=self.API, force=force))
        return buf.getvalue()

    def test_fresh_token_is_returned_without_refresh(self):
        self._write_state()
        with mock.patch.object(twt_auth, "token_request") as request:
            text = self._run_token()
            request.assert_not_called()
        self.assertEqual(text.strip(), "old-token")

    def test_force_returns_cached_token_without_refresh_token(self):
        self._write_state(refresh_token=None)
        with mock.patch.object(twt_auth, "token_request") as request:
            text = self._run_token(force=True)
            request.assert_not_called()
        self.assertEqual(text.strip(), "old-token")

    def test_expired_token_refreshes_and_persists(self):
        self._write_state(expires_at=int(time.time()) - 10)
        tokens = {
            "access_token": "new-token",
            "refresh_token": "new-refresh",
            "expires_in": 3600,
        }
        with mock.patch.object(
            twt_auth, "token_request", return_value=(tokens, 200)
        ) as request:
            text = self._run_token()

        self.assertEqual(text.strip(), "new-token")
        request.assert_called_once()
        endpoint, form = request.call_args.args
        self.assertEqual(endpoint, "https://idp.example/token")
        self.assertEqual(form["grant_type"], "refresh_token")
        self.assertEqual(form["refresh_token"], "old-refresh")

        state = twt_auth.load_state(self._path())
        self.assertEqual(state["access_token"], "new-token")
        self.assertEqual(state["refresh_token"], "new-refresh")
        self.assertGreater(state["expires_at"], int(time.time()))

    def test_invalid_refresh_drops_state(self):
        self._write_state(expires_at=int(time.time()) - 10)
        with mock.patch.object(
            twt_auth, "token_request", return_value=({"error": "invalid_grant"}, 401)
        ):
            with self.assertRaises(SystemExit) as ctx, redirect_stdout(io.StringIO()):
                twt_auth.cmd_token(argparse.Namespace(api_base=self.API, force=False))
        self.assertEqual(ctx.exception.code, 1)
        self.assertFalse(os.path.exists(self._path()))

    def test_expired_without_refresh_token_drops_state(self):
        self._write_state(expires_at=int(time.time()) - 10, refresh_token=None)
        with self.assertRaises(SystemExit) as ctx, redirect_stdout(io.StringIO()):
            twt_auth.cmd_token(argparse.Namespace(api_base=self.API, force=False))
        self.assertEqual(ctx.exception.code, 1)
        self.assertFalse(os.path.exists(self._path()))


class LoginFailureTests(unittest.TestCase):
    API = "http://127.0.0.1:9080/api/v1"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = mock.patch.dict(os.environ, {twt_auth.STATE_DIR_ENV: self.tmp.name})
        env.start()
        self.addCleanup(env.stop)

    def test_timeout_error_contains_manual_url(self):
        config = {
            "issuer": "https://idp.example",
            "clientId": "client",
            "scopes": ["openid"],
            "flow": "authorization_code_pkce",
        }
        doc = {
            "authorization_endpoint": "https://idp.example/authorize",
            "token_endpoint": "https://idp.example/token",
        }
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(twt_auth, "fetch_config", return_value=config))
            stack.enter_context(mock.patch.object(twt_auth, "discover", return_value=doc))
            stack.enter_context(mock.patch.object(twt_auth, "_open_browser", return_value=None))
            stack.enter_context(
                mock.patch.object(
                    twt_auth,
                    "wait_loopback",
                    side_effect=TimeoutError("no browser redirect within timeout"),
                )
            )
            ctx = stack.enter_context(self.assertRaises(SystemExit))
            stack.enter_context(redirect_stdout(buf))
            twt_auth.cmd_login(argparse.Namespace(api_base=self.API, force=True))

        text = buf.getvalue()
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("OPEN manually: https://idp.example/authorize?", text)
        self.assertIn(
            "ERROR: no browser redirect within timeout; open manually: "
            "https://idp.example/authorize?",
            text,
        )
        self.assertIn("redirect_uri=http%3A%2F%2F127.0.0.1%3A", text)


if __name__ == "__main__":
    unittest.main()
