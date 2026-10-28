// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 twt-cloud contributors
//
// Regression tests for TwtEngine.js. Run with:
//   node --test tests/*.test.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createContext, runInContext } from "node:vm"

const source = readFileSync(new URL("../TwtEngine.js", import.meta.url), "utf8")
    .replace(/^\.pragma library\s*$/m, "")
const Engine = createContext({})
runInContext(source, Engine, { filename: "TwtEngine.js" })

const SETTINGS = {
    flexiEnabled: true,
    flexiStartValue: "0:00",
    flexiTarget: "40:00",
    workdays: [true, true, true, true, true, false, false],
    resetInterval: "NONE"
}

function utc(iso) {
    return Math.floor(new Date(iso + "Z").getTime() / 1000)
}

function event(time, type) {
    return { id: String(time) + type, time, type, zoneOffset: 0 }
}

function berlinOffset(ms) {
    const name = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Berlin",
        timeZoneName: "longOffset"
    }).formatToParts(new Date(ms)).find(part => part.type === "timeZoneName").value
    const m = name.match(/GMT([+-])(\d+)(?::(\d+))?/)
    if (!m)
        return 0
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0))
}

function berlinInstant(y, month, day, hour, minute) {
    const target = Date.UTC(y, month - 1, day, hour, minute)
    for (let t = target - 3 * 3600000; t <= target + 3 * 3600000; t += 60000) {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Berlin",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hour12: false
        }).formatToParts(t).reduce((acc, p) => (acc[p.type] = p.value, acc), {})
        if (Number(parts.year) === y && Number(parts.month) === month
                && Number(parts.day) === day && Number(parts.hour) === hour
                && Number(parts.minute) === minute)
            return t
    }
    throw new Error("instant not found")
}

test("a normal eight-hour day has no balance", () => {
    const events = [
        event(utc("2026-10-26T09:00:00"), "CLOCK_IN"),
        event(utc("2026-10-26T17:00:00"), "CLOCK_OUT")
    ]
    const result = Engine.calculate(events, [], SETTINGS, utc("2026-10-26T20:00:00") * 1000, 0)
    assert.equal(result.workedToday, 480)
    assert.equal(result.balance, 0)
    assert.equal(result.clockedIn, false)
})

test("cross-midnight carry credits the new day", () => {
    const events = [
        event(utc("2026-10-26T23:00:00"), "CLOCK_IN"),
        event(utc("2026-10-27T07:00:00"), "CLOCK_OUT")
    ]
    const result = Engine.calculate(events, [], SETTINGS, utc("2026-10-27T08:00:00") * 1000, 0)
    assert.equal(result.workedToday, 420)
    assert.equal(result.clockedIn, false)
})

test("open clock-in gets a synthetic clock-out at now", () => {
    const events = [event(utc("2026-10-26T09:00:00"), "CLOCK_IN")]
    const result = Engine.calculate(events, [], SETTINGS, utc("2026-10-26T12:30:00") * 1000, 0)
    assert.equal(result.workedToday, 210)
    assert.equal(result.clockedIn, true)
})

test("DAY_GRANT bumps a past day to its target", () => {
    const events = [
        event(utc("2026-10-26T09:00:00"), "CLOCK_IN"),
        event(utc("2026-10-26T17:00:00"), "CLOCK_OUT"),
        event(utc("2026-10-27T09:00:00"), "CLOCK_IN"),
        event(utc("2026-10-27T10:00:00"), "CLOCK_OUT")
    ]
    const targets = [{
        id: "grant", date: "2026-10-27", type: "DAY_GRANT", value: 480
    }]
    const result = Engine.calculate(events, targets, SETTINGS, utc("2026-10-28T12:00:00") * 1000, 0)
    assert.equal(result.workedToday, 0)
    assert.equal(result.balance, -480)
})

test("multiple day targets on one date are ignored like the app", () => {
    const events = [
        event(utc("2026-10-26T09:00:00"), "CLOCK_IN"),
        event(utc("2026-10-26T17:00:00"), "CLOCK_OUT")
    ]
    const targets = [
        { id: "set", date: "2026-10-26", type: "DAY_SET", value: 0 },
        { id: "grant", date: "2026-10-26", type: "DAY_GRANT", value: 480 }
    ]
    const result = Engine.calculate(events, targets, SETTINGS, utc("2026-10-26T20:00:00") * 1000, 0)
    // Exactly one row would make this a free day (target 0, balance +480).
    // DAO.getDayTarget returns null for a duplicate date, so the regular
    // Monday target of 480 applies and the balance stays flat.
    assert.equal(result.workedToday, 480)
    assert.equal(result.balance, 0)
})

test("identical duplicate day targets collapse to one", () => {
    const events = [
        event(utc("2026-10-26T09:00:00"), "CLOCK_IN"),
        event(utc("2026-10-26T17:00:00"), "CLOCK_OUT")
    ]
    const targets = [
        { id: "sync", date: "2026-10-26", type: "DAY_SET", value: 0 },
        { id: "import", date: "2026-10-26", type: "DAY_SET", value: 0, comment: "re-imported" }
    ]
    const result = Engine.calculate(events, targets, SETTINGS, utc("2026-10-26T20:00:00") * 1000, 0)
    // A re-import must not turn the free day back into a regular workday.
    assert.equal(result.workedToday, 480)
    assert.equal(result.balance, 480)
})

test("a single DAY_SET zero still clears the day target", () => {
    const events = [
        event(utc("2026-10-26T09:00:00"), "CLOCK_IN"),
        event(utc("2026-10-26T17:00:00"), "CLOCK_OUT")
    ]
    const targets = [{ id: "set", date: "2026-10-26", type: "DAY_SET", value: 0 }]
    const result = Engine.calculate(events, targets, SETTINGS, utc("2026-10-26T20:00:00") * 1000, 0)
    assert.equal(result.workedToday, 480)
    assert.equal(result.balance, 480)
})

test("unknown target types do not conflict with day targets", () => {
    const events = [
        event(utc("2026-10-26T09:00:00"), "CLOCK_IN"),
        event(utc("2026-10-26T17:00:00"), "CLOCK_OUT")
    ]
    const targets = [
        { id: "set", date: "2026-10-26", type: "DAY_SET", value: 0 },
        { id: "future", date: "2026-10-26", type: "DAY_FUTURE", value: 1 }
    ]
    const result = Engine.calculate(events, targets, SETTINGS, utc("2026-10-26T20:00:00") * 1000, 0)
    // An unknown row must be ignored, not treated as a competing day target.
    assert.equal(result.workedToday, 480)
    assert.equal(result.balance, 480)
})

test("flexi reset schedules target = actual on the reset day", () => {
    const events = [
        event(utc("2026-10-26T09:00:00"), "CLOCK_IN"),
        event(utc("2026-10-26T17:00:00"), "CLOCK_OUT")
    ]
    const settings = Object.assign({}, SETTINGS, {
        flexiStartValue: "10:00",
        resetInterval: "DAILY"
    })
    const result = Engine.calculate(events, [], settings, utc("2026-10-26T20:00:00") * 1000, 0)
    assert.equal(result.balance, 0)
})

test("fall-back day keeps events from the repeated hour", () => {
    const clockIn = berlinInstant(2026, 10, 25, 0, 30)
    const clockOut = berlinInstant(2026, 10, 25, 7, 0)
    const now = berlinInstant(2026, 10, 25, 8, 0)
    const events = [
        event(Math.floor(clockIn / 1000), "CLOCK_IN"),
        event(Math.floor(clockOut / 1000), "CLOCK_OUT")
    ]
    const result = Engine.calculate(events, [], SETTINGS, now, berlinOffset)
    // 00:30 -> 07:00 across the fall-back is 7.5 elapsed hours; the previous
    // implementation lost the event entirely and reported 0.
    assert.equal(result.workedToday, 450)
    assert.equal(result.balance, -1950)
})

test("ten years of history stays well below the old quadratic cost", () => {
    const now = utc("2026-10-26T12:00:00")
    const from = now - 10 * 365 * 86400
    const events = []
    for (let t = from; t < now; t += 86400) {
        const weekday = new Date(t * 1000).getUTCDay()
        if (weekday > 0 && weekday < 6) {
            events.push(event(t + 9 * 3600, "CLOCK_IN"))
            events.push(event(t + 17 * 3600, "CLOCK_OUT"))
        }
    }
    Engine.calculate(events, [], SETTINGS, now * 1000, 0)
    const start = performance.now()
    for (let i = 0; i < 3; i++)
        Engine.calculate(events, [], SETTINGS, now * 1000, 0)
    const elapsed = performance.now() - start
    assert.ok(elapsed < 1000, `3 calculations took ${elapsed.toFixed(0)} ms`)
})
