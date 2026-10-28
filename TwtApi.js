// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 twt-cloud contributors
//
// TwtApi.js — REST client for the twt-cloud backend via curl + Proc.runCommand.
//
// Backend contract (backend/src/routes/events.rs, targets.rs):
//   GET  /events?from=<sec>&to=<sec>    → [{id, time, zoneOffset, type, task, comment, updatedAt, deletedAt}]
//                                         ordered by (time, insertion_seq, id); `to` EXCLUSIVE; default limit 500
//   GET  /targets?from=<date>&to=<date>&limit=&offset=
//                                        → [{id, date: "YYYY-MM-DD", type, value, comment, updatedAt, deletedAt}]
//                                         ordered by (date, id); `to` EXCLUSIVE; default limit 500, max 1000
//   GET  /tasks                         → [{id, name, active, ordering, isDefault, updatedAt, deletedAt}]
//   POST /events body {time, zoneOffset, type, task, comment} → 201 + event JSON
//   Auth: Authorization: Bearer — delivered via -H @<headerPath>; the widget
//   writes that file, so the token never appears in curl argv (ps-safe).
//
// This is a .pragma library file: it cannot reference QML singletons, so every
// entry point receives the Proc singleton object as first argument.
//
// HTTP status is surfaced via `curl -w "\n%{http_code}"`: the last stdout
// line after a completed transfer is the numeric status code. cb(err, data,
// status) — status is 0 when curl itself failed (network/timeout).
//
// Proc.runCommand(id, command, callback, debounceMs, timeoutMs, owner):
//   command is an argv array (Process.command is QList<QString>), callback(stdout, exitCode).

.pragma library

// ---------- public API ----------

// Fetch events in [fromSec, toSec). `to` is exclusive on the backend, so a
// caller that has just POSTed an event at `now` must pass toSec = now + 1.
// Paginated oldest-first: the backend caps `limit` per request, and a single
// page may not reach "today" when the window holds many older events.
// cb(err, events, status)
var EVENTS_PAGE_LIMIT = 1000;
var MAX_EVENTS_PAGES = 50; // 50k events hard stop; beyond that surfaces as an error
var TARGETS_PAGE_LIMIT = 1000;
var MAX_TARGETS_PAGES = 50; // 50k targets hard stop

function fetchEvents(proc, baseUrl, headerPath, fromSec, toSec, cb) {
    var all = [];
    var offset = 0;

    function fetchPage() {
        if (offset >= MAX_EVENTS_PAGES * EVENTS_PAGE_LIMIT) {
            cb("event window exceeds " + MAX_EVENTS_PAGES * EVENTS_PAGE_LIMIT + " events", null, 0);
            return;
        }
        var url = baseUrl + "/events?from=" + fromSec + "&to=" + toSec
                + "&limit=" + EVENTS_PAGE_LIMIT + "&offset=" + offset;
        _run(proc, url, headerPath, function (err, body, status) {
            if (err) return cb(err, null, status);
            if (status !== 200) return cb("events HTTP " + status, null, status);
            var page;
            try {
                page = JSON.parse(body);
            } catch (e) {
                return cb("events page " + (offset / EVENTS_PAGE_LIMIT + 1) + ": " + e
                        + " body=" + String(body).slice(0, 200), null, status);
            }
            if (!Array.isArray(page))
                return cb("events: expected an array", null, status);
            for (var i = 0; i < page.length; i++)
                all.push(page[i]);
            if (page.length < EVENTS_PAGE_LIMIT) {
                cb(null, all, status);
                return;
            }
            offset += EVENTS_PAGE_LIMIT;
            fetchPage();
        });
    }
    fetchPage();
}

// Fetch the full day-target list. The backend bounds each page, so walk
// oldest-first until a short page marks the end. cb(err, targets, status)
function fetchTargets(proc, baseUrl, headerPath, cb) {
    var all = [];
    var offset = 0;

    function fetchPage() {
        if (offset >= MAX_TARGETS_PAGES * TARGETS_PAGE_LIMIT) {
            cb("target list exceeds " + MAX_TARGETS_PAGES * TARGETS_PAGE_LIMIT + " rows", null, 0);
            return;
        }
        var url = baseUrl + "/targets?limit=" + TARGETS_PAGE_LIMIT + "&offset=" + offset;
        _run(proc, url, headerPath, function (err, body, status) {
            if (err) return cb(err, null, status);
            if (status !== 200) return cb("targets HTTP " + status, null, status);
            var page;
            try {
                page = JSON.parse(body);
            } catch (e) {
                return cb("targets page " + (offset / TARGETS_PAGE_LIMIT + 1) + ": " + e
                        + " body=" + String(body).slice(0, 200), null, status);
            }
            if (!Array.isArray(page))
                return cb("targets: expected an array", null, status);
            for (var i = 0; i < page.length; i++)
                all.push(page[i]);
            if (page.length < TARGETS_PAGE_LIMIT) {
                cb(null, all, status);
                return;
            }
            offset += TARGETS_PAGE_LIMIT;
            fetchPage();
        });
    }
    fetchPage();
}

// POST an event; ev = {time, zoneOffset, type, task, comment}. cb(err, created, status)
function postEvent(proc, baseUrl, headerPath, ev, cb) {
    var body = JSON.stringify({
        time: ev.time,
        zoneOffset: ev.zoneOffset,
        type: ev.type,
        task: ev.task,
        comment: ev.comment
    });
    var argv = ["curl", "-sS", "-m", "20",
                "-X", "POST",
                "-H", "@" + headerPath,
                "-H", "Content-Type: application/json",
                "-d", body,
                "-w", "\n%{http_code}",
                baseUrl + "/events"];
    proc.runCommand(null, argv, function (stdout, exitCode) {
        var parsed = _splitStatus(stdout);
        if (exitCode !== 0)
            return cb("curl exit " + exitCode, null, 0);
        var parsedBody = _safeParse(parsed.body);
        if (parsedBody.error !== null)
            return cb(parsedBody.error, null, parsed.status);
        if (parsed.status !== 200 && parsed.status !== 201)
            return cb("HTTP " + parsed.status + " body=" + parsed.body.slice(0, 200), null, parsed.status);
        cb(null, parsedBody.value, parsed.status);
    }, 0, 30000);
}

// True when `baseUrl` would send the bearer token over cleartext to a host
// that is not the local machine. Callers should warn instead of silently
// transmitting credentials across the network in plain HTTP.
function isInsecureHttpUrl(baseUrl) {
    var m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(String(baseUrl || ""));
    if (!m || m[1].toLowerCase() !== "http")
        return false;
    var authority = m[2].split(/[/?#]/)[0];
    var at = authority.lastIndexOf("@");
    if (at !== -1)
        authority = authority.slice(at + 1);
    var host;
    if (authority.charAt(0) === "[") {
        var close = authority.indexOf("]");
        host = close === -1 ? authority.slice(1) : authority.slice(1, close);
    } else {
        var colon = authority.indexOf(":");
        host = colon === -1 ? authority : authority.slice(0, colon);
    }
    host = host.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
}

// ---------- internals ----------

function _run(proc, url, headerPath, cb) {
    var argv = ["curl", "-sS", "-m", "20",
                "-H", "@" + headerPath,
                "-H", "Accept: application/json",
                "-w", "\n%{http_code}",
                url];
    proc.runCommand(null, argv, function (stdout, exitCode) {
        var parsed = _splitStatus(stdout);
        if (exitCode !== 0)
            return cb("curl exit " + exitCode + " out=" + String(stdout).slice(0, 200), null, 0);
        cb(null, parsed.body, parsed.status);
    }, 0, 30000);
}

// Split "body\nstatus" into {body, status}. curl -w output is appended after
// the body, on its own line.
function _splitStatus(stdout) {
    var s = String(stdout);
    var idx = s.lastIndexOf("\n");
    if (idx === -1)
        return { body: s, status: 0 };
    var statusLine = s.slice(idx + 1).trim();
    var status = parseInt(statusLine, 10);
    if (isNaN(status) || status <= 0)
        return { body: s, status: 0 };
    return { body: s.slice(0, idx), status: status };
}

function _safeParse(s) {
    try {
        return { value: JSON.parse(s), error: null };
    } catch (e) {
        return { value: null, error: "invalid JSON: " + e + " body=" + String(s).slice(0, 200) };
    }
}
