// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 twt-cloud contributors
//
// TwtAuth.js — sign-in / token resolution for the twtBar plugin.
//
// The widget never handles OAuth itself: it shells out to twt_auth.py
// (a stateful CLI that owns the browser PKCE round-trip, refresh and the
// token file) and only reads back a resolved access token.
//
// Output contract of twt_auth.py (Proc only forwards stdout): success →
// result on stdout, exit 0; failure → "ERROR: <reason>" on stdout, exit != 0.
// `login` can precede the result/error with an informational
// "OPEN manually: <url>" line, so failures prefer the ERROR line.
//
// scriptPath comes in as a file:// URL from the widget (Qt.resolvedUrl in a
// .pragma library has no base URL, so the widget resolves it).
//
// Functions (all take the Proc singleton as first argument):
//   token(proc, scriptPath, apiBase, cb, force)   cb(err, accessToken)
//   signIn(proc, scriptPath, apiBase, cb)         cb(err)
//   signOut(proc, scriptPath, apiBase, cb)        cb(err)

.pragma library

function _strip(url) {
    var s = String(url);
    if (s.indexOf("file://") === 0)
        s = s.slice("file://".length);
    try {
        return decodeURIComponent(s);
    } catch (e) {
        return s; // malformed escape: pass the original path through
    }
}

function _run(proc, scriptPath, subCmd, apiBase, extraArgs, cb, timeoutMs) {
    var argv = ["python3", _strip(scriptPath), subCmd];
    if (extraArgs) {
        for (var i = 0; i < extraArgs.length; i++)
            argv.push(extraArgs[i]);
    }
    argv.push(apiBase);
    proc.runCommand(null, argv, function (stdoutText, exitCode) {
        var text = String(stdoutText || "").trim();
        var lines = text.split("\n");
        var firstLine = lines.length > 0 ? lines[0].trim() : "";
        // login can emit an informational URL before an ERROR line; always
        // surface the actual failure instead of the first line.
        var errorLine = "";
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf("ERROR:") === 0) {
                errorLine = line;
                break;
            }
        }
        cb(exitCode === 0 ? null : (errorLine || firstLine || ("exit " + exitCode)),
           exitCode === 0 ? text : null);
    }, 0, timeoutMs);
}

// Valid access token, or null when no sign-in state exists (fallback path).
function token(proc, scriptPath, apiBase, cb, force) {
    _run(proc, scriptPath, "token", apiBase, force ? ["--force"] : null,
         function (err, text) {
             if (err && err.indexOf("ERROR: not signed in") === 0)
                 return cb(null, null); // no stored state → caller falls back
             cb(err, err ? null : text);
         }, 30000);
}

// Full browser flow; blocks until the round-trip completes (≤10 min inside
// the helper), so the Proc timeout is generous but finite. `--force` lets the
// UI recover from a malformed/stale state file instead of reporting
// "already signed in".
function signIn(proc, scriptPath, apiBase, cb) {
    _run(proc, scriptPath, "login", apiBase, ["--force"], cb, 700000);
}

function signOut(proc, scriptPath, apiBase, cb) {
    _run(proc, scriptPath, "logout", apiBase, null, cb, 15000);
}
