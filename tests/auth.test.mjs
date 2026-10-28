// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 twt-cloud contributors
//
// Error-mapping tests for the twt_auth.py wrapper.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createContext, runInContext } from "node:vm"

const source = readFileSync(new URL("../TwtAuth.js", import.meta.url), "utf8")
    .replace(/^\.pragma library\s*$/m, "")
const AuthContext = createContext({})
runInContext(source, AuthContext, { filename: "TwtAuth.js" })

function fakeProc(stdout, exitCode) {
    const calls = []
    return {
        calls,
        runCommand(id, argv, cb) {
            calls.push(argv)
            cb(stdout, exitCode)
        }
    }
}

test("token maps 'not signed in' to the manual-token fallback", () => {
    const proc = fakeProc("ERROR: not signed in\n", 1)
    let error = "unset"
    let token = "unset"
    AuthContext.token(proc, "file:///tmp/twt_auth.py", "http://api", (err, tok) => {
        error = err
        token = tok
    })
    assert.equal(error, null)
    assert.equal(token, null)
    assert.deepEqual(Array.from(proc.calls[0].slice(1)), ["/tmp/twt_auth.py", "token", "http://api"])
})

test("token returns the access token on success", () => {
    const proc = fakeProc("access-token\n", 0)
    let error = "unset"
    let token = "unset"
    AuthContext.token(proc, "/tmp/twt_auth.py", "http://api", (err, tok) => {
        error = err
        token = tok
    })
    assert.equal(error, null)
    assert.equal(token, "access-token")
})

test("token decodes a percent-encoded file URL", () => {
    const proc = fakeProc("access-token\n", 0)
    AuthContext.token(proc, "file:///tmp/my%20plugin/twt_auth.py", "http://api", () => {})
    assert.equal(proc.calls[0][1], "/tmp/my plugin/twt_auth.py")
})

test("token passes --force before the api base", () => {
    const proc = fakeProc("access-token\n", 0)
    AuthContext.token(proc, "/tmp/twt_auth.py", "http://api", () => {}, true)
    assert.deepEqual(Array.from(proc.calls[0].slice(1)), [
        "/tmp/twt_auth.py", "token", "--force", "http://api"
    ])
})

test("signIn surfaces the ERROR line after an informational URL", () => {
    const manual = "http://127.0.0.1:12345/"
    const proc = fakeProc(
        "OPEN manually: " + manual + "\n"
        + "ERROR: no browser redirect within timeout; open manually: " + manual + "\n",
        1
    )
    let error = "unset"
    AuthContext.signIn(proc, "/tmp/twt_auth.py", "http://api", (err) => {
        error = err
    })
    assert.equal(error,
        "ERROR: no browser redirect within timeout; open manually: " + manual)
    assert.deepEqual(Array.from(proc.calls[0].slice(1)), [
        "/tmp/twt_auth.py", "login", "--force", "http://api"
    ])
})
