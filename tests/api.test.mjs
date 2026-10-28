// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 twt-cloud contributors
//
// REST client tests for TwtApi.js (pagination/status handling).

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createContext, runInContext } from "node:vm"

const source = readFileSync(new URL("../TwtApi.js", import.meta.url), "utf8")
    .replace(/^\.pragma library\s*$/m, "")
const ApiContext = createContext({})
runInContext(source, ApiContext, { filename: "TwtApi.js" })

function fakeProc(handler) {
    const calls = []
    return {
        calls,
        runCommand(id, argv, cb) {
            const url = argv[argv.length - 1]
            calls.push(url)
            handler(url, cb)
        }
    }
}

function ok(body) {
    return String(body) + "\n200"
}

test("fetchEvents paginates until a short page", () => {
    const first = Array.from({ length: 1000 }, (_, i) => ({ id: "a" + i, time: i, type: "CLOCK_IN" }))
    const second = [{ id: "b", time: 1001, type: "CLOCK_OUT" }]
    const proc = fakeProc((url, cb) => {
        const match = url.match(/[?&]offset=(\d+)/)
        const offset = match ? Number(match[1]) : 0
        cb(ok(JSON.stringify(offset === 0 ? first : second)), 0)
    })
    let result
    ApiContext.fetchEvents(proc, "http://api/api/v1", "/tmp/h", 0, 2000, (err, events) => {
        assert.equal(err, null)
        result = events
    })
    assert.equal(result.length, 1001)
    assert.equal(proc.calls.length, 2)
    assert.match(proc.calls[0], /from=0&to=2000/)
    assert.match(proc.calls[1], /offset=1000/)
})

test("fetchTargets parses the target list", () => {
    const proc = fakeProc((url, cb) => {
        assert.match(url, /\/targets\?limit=1000&offset=0$/)
        cb(ok(JSON.stringify([{ id: "t", date: "2026-10-26", type: "DAY_SET", value: 480 }])), 0)
    })
    let targets
    ApiContext.fetchTargets(proc, "http://api/api/v1", "/tmp/h", (err, rows) => {
        assert.equal(err, null)
        targets = rows
    })
    assert.equal(targets.length, 1)
    assert.equal(targets[0].type, "DAY_SET")
})

test("fetchTargets paginates until a short page", () => {
    const first = Array.from({ length: 1000 }, (_, i) => ({
        id: "t" + i, date: "2026-01-01", type: "DAY_SET", value: i
    }))
    const second = [{ id: "last", date: "2026-10-26", type: "DAY_GRANT", value: 480 }]
    const proc = fakeProc((url, cb) => {
        const match = url.match(/[?&]offset=(\d+)/)
        const offset = match ? Number(match[1]) : 0
        cb(ok(JSON.stringify(offset === 0 ? first : second)), 0)
    })
    let targets
    ApiContext.fetchTargets(proc, "http://api/api/v1", "/tmp/h", (err, rows) => {
        assert.equal(err, null)
        targets = rows
    })
    assert.equal(targets.length, 1001)
    assert.equal(proc.calls.length, 2)
    assert.match(proc.calls[0], /limit=1000&offset=0/)
    assert.match(proc.calls[1], /limit=1000&offset=1000/)
})

test("fetchEvents surfaces HTTP status without parsing the body as success", () => {
    const unauthorized = fakeProc((url, cb) => cb("unauthorized\n401", 0))
    let error, status
    ApiContext.fetchEvents(unauthorized, "http://api/api/v1", "/tmp/h", 0, 1, (err, events, code) => {
        error = err
        status = code
    })
    assert.equal(error, "events HTTP 401")
    assert.equal(status, 401)
})

test("fetchEvents rejects a non-array 200 response without paginating", () => {
    const proc = fakeProc((url, cb) => cb(ok('{"error":"proxy"}'), 0))
    let error, status
    ApiContext.fetchEvents(proc, "http://api/api/v1", "/tmp/h", 0, 1, (err, events, code) => {
        error = err
        status = code
    })
    assert.equal(error, "events: expected an array")
    assert.equal(status, 200)
    assert.equal(proc.calls.length, 1)
})

test("isInsecureHttpUrl only flags plain HTTP outside loopback", () => {
    for (const url of [
        "http://localhost:9080/api/v1",
        "http://127.0.0.1:9080/api/v1",
        "http://[::1]:9080/api/v1",
        "http://user:pass@localhost/api/v1",
        "https://twt.example.com/api/v1"
    ])
        assert.equal(ApiContext.isInsecureHttpUrl(url), false, url)
    for (const url of [
        "http://twt.example.com/api/v1",
        "http://192.168.1.10:9080/api/v1",
        "http://10.0.0.5:9080/api/v1",
        "http://[2001:db8::1]:9080/api/v1",
        "http://user:pass@example.com/api/v1"
    ])
        assert.equal(ApiContext.isInsecureHttpUrl(url), true, url)
})
