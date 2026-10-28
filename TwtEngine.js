// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 twt-cloud contributors
// Derived from TrackWorkTime (https://codeberg.org/mathisdt/trackworktime),
// Copyright (C) Mathis Dirksen-Thedens and contributors, licensed GPL-3.0.
//
// TwtEngine.js — faithful port of TrackWorkTime's calculation semantics.
//
// Mirrors (app/app/src/main/java/org/zephyrsoft/trackworktime/):
//   timer/TimeCalculatorV2.java  — per-day worked/target/balance (calculateNextDay, calculateWorkTime, calculateTargetTime)
//   timer/TimerManager.java      — getTimesAt, getNormalWorkDurationFor, isWorkDay, timeDiff (minute truncation)
//   model/FlexiReset.java        — flexi reset scheduling (getNextResetDate)
//
// Event shape  (GET /events):    { id, time (epoch sec), zoneOffset (min), type: "CLOCK_IN"|"CLOCK_OUT", task, comment, updatedAt, deletedAt }
// Target shape (GET /targets):   { id, date "YYYY-MM-DD", type: "DAY_SET"|"DAY_GRANT"|"DAY_IGNORE"|"FLEXI_SET"|"FLEXI_ADD", value (min), ... }
//
// Notes on app semantics mirrored here:
//   - Only DAY_SET / DAY_GRANT / DAY_IGNORE targets affect calculation (DAO.getDayTarget filters
//     type <= DAY_IGNORE); FLEXI_SET/FLEXI_ADD are stored but not consumed by the calculator.
//   - DAY_GRANT on a regular workday bumps worked to the day target for past days
//     (TimeCalculatorV2.calculateNextDay, "!isToday" branch).
//   - DAY_IGNORE days still accumulate actual/target sums; the app freezes
//     only its per-day currentBalance, while this widget reports the aggregate
//     flexi balance (actual - target) and keeps the day's difference.
//   - Flexi reset sets cumulative target = actual on the reset date (balance restarts at 0).
//   - "Clocked in with no future CLOCK_OUT" gets a synthetic CLOCK_OUT at now (today only);
//     with a future CLOCK_OUT present, an open carry counts to end of day instead.

.pragma library

// ---------- public API ----------

// settings = {
//   flexiEnabled:   bool,
//   flexiStartValue:"H:MM"   (minutes credited at the start of tracking),
//   flexiTarget:    "H:MM"   (target work per week),
//   workdays:       [bool x7] (Mon..Sun),
//   resetInterval:  "NONE"|"DAILY"|"WEEKLY"|"MONTHLY"|"QUARTERLY"|"HALF_YEARLY"|"YEARLY"
// }
// homeOffset: how local day boundaries are derived. Either a fixed number of
//   east-positive minutes, or a function (ms) => east-positive minutes evaluated
//   per instant — pass a DST-aware provider (e.g. offsets from the system
//   timezone) so day bucketing follows the home timezone across DST
//   transitions, mirroring the app's ZoneId-based calculation.
function calculate(events, targets, settings, nowMs, homeOffset) {
    var result = {
        workedToday: 0,
        balance: 0,
        clockedIn: false,
        lastEventTime: 0,
        lastEventType: "",
        flexiUsed: settings.flexiEnabled
    };
    if (!events || events.length === 0)
        return result;

    var evs = [];
    var i;
    for (i = 0; i < events.length; i++) {
        var e = events[i];
        if (e.deletedAt !== undefined && e.deletedAt !== null)
            continue;
        if (e.type !== "CLOCK_IN" && e.type !== "CLOCK_OUT")
            continue;
        evs.push({ time: e.time, type: e.type, order: evs.length });
    }
    if (evs.length === 0)
        return result;
    // The API breaks same-time ties by insertion order. Qt's Array.sort is
    // unstable for long lists, so keep that order while sorting by time.
    evs.sort(function (a, b) { return (a.time - b.time) || (a.order - b.order); });
    // homeOffset: fixed minutes, or per-instant function (ms) => minutes.
    // The offset is evaluated per instant: event bucketing uses the offset at
    // the event, day boundaries use the offset at local midnight. That keeps
    // historical winter/summer days and DST transition days correct.
    var offFn = typeof homeOffset === "function"
        ? homeOffset
        : function () { return homeOffset; };

    // targets by local date (only DAY_* types, mirroring DAO.getDayTarget).
    // Differing day targets on one date yield no special target, so they must
    // not silently resolve by API order. Rows identical for calculation (same
    // type and value, e.g. a holiday duplicated by an import and a later sync)
    // collapse to one row: they express the same decision, and the app's
    // "duplicate => none" rule would otherwise let a stale copy silently turn
    // a free day into a workday.
    var dayTargets = {};
    var dayTargetSeen = {};
    var dayTargetConflict = {};
    for (i = 0; i < (targets || []).length; i++) {
        var t = targets[i];
        if (t.deletedAt)
            continue;
        if (t.type !== "DAY_SET" && t.type !== "DAY_GRANT" && t.type !== "DAY_IGNORE")
            continue;
        if (dayTargetConflict[t.date])
            continue;
        var firstDayTarget = dayTargetSeen[t.date];
        if (firstDayTarget === undefined) {
            dayTargetSeen[t.date] = t;
            dayTargets[t.date] = t;
        } else if (firstDayTarget.type !== t.type || firstDayTarget.value !== t.value) {
            dayTargetConflict[t.date] = true;
            dayTargets[t.date] = null;
        }
    }

    var todayEpoch = todayEpochDay(nowMs, offFn(nowMs));
    var firstDay = todayEpochDay(evs[0].time * 1000, offFn(evs[0].time * 1000));
    // getTimesAt: start at the Monday of the first event's week, crediting flexiStartValue
    var startDay = mondayOf(firstDay);

    var countWorkDays = 0;
    for (i = 0; i < 7; i++)
        if (settings.workdays[i])
            countWorkDays++;
    var normalWork = countWorkDays > 0 ? roundHalfUpDivide(parseHoursMinutes(settings.flexiTarget, 0), countWorkDays) : 0;

    // does any future CLOCK_OUT exist? (gates the synthetic clock-out-now, mirrors the app)
    var futureClockOutExists = false;
    for (i = 0; i < evs.length; i++) {
        if (evs[i].type === "CLOCK_OUT" && evs[i].time * 1000 > nowMs) {
            futureClockOutExists = true;
            break;
        }
    }

    var actual = settings.flexiEnabled ? parseHoursMinutes(settings.flexiStartValue, 0) : 0;
    var target = 0;
    var resetInterval = settings.flexiEnabled ? (settings.resetInterval || "NONE") : "NONE";
    var nextReset = resetInterval !== "NONE" ? nextResetAfter(startDay - 1, resetInterval) : -1;

    var carry = null; // last event of previous day (clock-in carry)
    var workedToday = 0;
    var clockedIn = false;

    // Bucket events by local day once (O(events)). The previous per-day scan
    // was O(days × events) and could freeze the shell for seconds on a long
    // history. Using the offset at each event's own instant also keeps DST
    // transition days bucketed correctly.
    var eventsByDay = {};
    for (i = 0; i < evs.length; i++) {
        var evMs = evs[i].time * 1000;
        var evDay = todayEpochDay(evMs, offFn(evMs));
        if (eventsByDay[evDay] === undefined)
            eventsByDay[evDay] = [];
        eventsByDay[evDay].push(evs[i]);
    }
    var dayStartCache = {};

    for (var day = startDay; day <= todayEpoch; day++) {
        var dayEvents = eventsByDay[day] || [];
        var dayStartMs = dayStartFor(day, offFn, dayStartCache);
        var dayEndMs = dayStartFor(day + 1, offFn, dayStartCache);
        var isToday = day === todayEpoch;

        // effective list for today: events up to now, plus synthetic clock-out when applicable
        var effective;
        if (isToday) {
            effective = [];
            var lastUpToNow = carry;
            for (var j = 0; j < dayEvents.length; j++) {
                if (dayEvents[j].time * 1000 <= nowMs) {
                    effective.push(dayEvents[j]);
                    lastUpToNow = dayEvents[j];
                }
            }
            // Java: synthetic CLOCK_OUT at "now" when the day ends clocked-in
            // (also when only a carry-over clock-in exists and today has no events yet)
            // and no future CLOCK_OUT event exists.
            var clockedInAsOfNow = (lastUpToNow !== null && lastUpToNow.type === "CLOCK_IN")
                || (lastUpToNow === null && carry !== null && carry.type === "CLOCK_IN");
            if (clockedInAsOfNow && !futureClockOutExists)
                effective.push({ time: Math.floor(nowMs / 1000), type: "CLOCK_OUT", synthetic: true });
            for (var k2 = 0; k2 < dayEvents.length; k2++) {
                if (dayEvents[k2].time * 1000 > nowMs)
                    effective.push(dayEvents[k2]);
            }
        } else {
            effective = dayEvents;
        }

        var dayRes = workDay(day, effective, carry, nowMs, dayStartMs, dayEndMs, isToday, dayTargets, normalWork, settings.workdays);

        // flexi reset: cumulative target = actual on reset date
        if (resetInterval !== "NONE" && nextReset === day) {
            target = actual;
            nextReset = nextResetAfter(day, resetInterval);
        }

        actual += dayRes.worked;
        target += dayRes.target;

        if (isToday) {
            workedToday = dayRes.worked;
        }
        carry = dayRes.lastEvent;
    }

    // pill clock-in state: last event at or before now
    var lastSeen = null;
    for (var m = 0; m < evs.length; m++) {
        if (evs[m].time * 1000 <= nowMs)
            lastSeen = evs[m];
        else
            break;
    }

    result.workedToday = workedToday;
    result.balance = settings.flexiEnabled ? actual - target : 0;
    result.clockedIn = lastSeen !== null && lastSeen.type === "CLOCK_IN";
    result.lastEventTime = lastSeen ? lastSeen.time : 0;
    return result;
}

// ---------- day-level calculation (mirrors calculateNextDay + calculateWorkTime) ----------

function workDay(day, dayEvents, carry, nowMs, dayStartMs, dayEndMs, isToday, dayTargets, normalWork, workdays) {
    var dateISO = epochDayToISODate(day);

    // --- calculateWorkTime port ---
    var clockedInSince = null; // ms epoch
    var worked = 0;
    var firstClockInMs = null;
    var effectiveClockOutMs = null;
    var inMs = null;
    var outMs = null;

    // carry: clocked in since start of day
    if (carry !== null && carry.type === "CLOCK_IN" && dayEvents.length > 0 && dayEvents[0].type !== "CLOCK_IN") {
        clockedInSince = dayStartMs;
        inMs = dayStartMs;
    }

    var k;
    for (k = 0; k < dayEvents.length; k++) {
        var ev = dayEvents[k];
        var evMs = ev.time * 1000;
        if (ev.type === "CLOCK_IN" && clockedInSince === null) {
            clockedInSince = evMs;
            if (firstClockInMs === null)
                firstClockInMs = evMs;
        } else if (clockedInSince !== null && ev.type === "CLOCK_OUT") {
            worked += diffMinutes(clockedInSince, evMs);
            clockedInSince = null;
            effectiveClockOutMs = evMs;
        }
    }

    // still clocked in at end of day (and now is after the clock-in instant)
    if (clockedInSince !== null && nowMs > clockedInSince) {
        var dayEndMinute = dayEndMs - 60000; // 23:59 local
        outMs = dayEndMinute;
        worked += diffMinutes(clockedInSince, dayEndMinute);
    } else if (effectiveClockOutMs !== null) {
        outMs = effectiveClockOutMs;
    }

    if (firstClockInMs !== null && inMs === null)
        inMs = firstClockInMs;

    // no events this day but clocked in all day (mirrors calculateWorkTime else-branch)
    if (dayEvents.length === 0 && carry !== null && carry.type === "CLOCK_IN" && nowMs > carry.time * 1000) {
        inMs = dayStartMs;
        outMs = dayEndMs - 60000;
        worked = 24 * 60;
    }

    var lastEvent = dayEvents.length > 0 ? dayEvents[dayEvents.length - 1] : carry;

    // --- target for this day (mirrors calculateTargetTime) ---
    var special = dayTargets[dateISO] || null;
    var targetEnum = special ? special.type : null;
    var weekdayIdx = ((day + 3) % 7 + 7) % 7; // 0 = Monday (epoch day 0 = Thursday)
    var isRegularWorkday = workdays[weekdayIdx];

    var dayTarget = 0;
    if (targetEnum === "DAY_SET") {
        if (special.value === 0) {
            dayTarget = 0; // free day override
        } else {
            dayTarget = special.value;
        }
    } else if (isRegularWorkday) {
        dayTarget = normalWork;
    }
    // DAY_GRANT / DAY_IGNORE keep the regular target (0 on free days)

    // DAY_GRANT bump for past days: worked = max(worked, dayTarget)
    if (!isToday && targetEnum === "DAY_GRANT" && dayTarget !== 0 && worked < dayTarget) {
        worked = dayTarget;
    }

    return {
        worked: worked,
        target: dayTarget,
        inMs: inMs,
        outMs: outMs,
        lastEvent: lastEvent
    };
}

// ---------- helpers shared with callers ----------

// First minute of local day `day` in the home offset. Most days resolve from
// the offset at UTC midnight; transition days that do not fall back to a
// minute-resolution search. Cached because the day loop asks for D and D+1.
function dayStartFor(day, offFn, cache) {
    var cached = cache[day];
    if (cached !== undefined)
        return cached;
    var start = localDayStartMs(day, offFn);
    cache[day] = start;
    return start;
}

function localDayStartMs(day, offFn) {
    var t = day * 86400000;
    var guess = t - offFn(t) * 60000;
    if (todayEpochDay(guess, offFn(guess)) === day
            && todayEpochDay(guess - 60000, offFn(guess - 60000)) < day)
        return guess;

    // Zone transition at/near local midnight: search the first UTC minute
    // whose local date is `day`; bounded to ±36 h and only hit on transition
    // days (the normal path above resolves in two offset lookups).
    var lo = t - 36 * 3600000;
    var hi = t + 36 * 3600000;
    while (hi - lo > 60000) {
        var mid = lo + Math.floor((hi - lo) / 120000) * 60000;
        if (mid <= lo)
            mid = lo + 60000;
        if (todayEpochDay(mid, offFn(mid)) < day)
            lo = mid;
        else
            hi = mid;
    }
    return hi;
}

function epochDayToISODate(epochDay) {
    return new Date(epochDay * 86400000).toISOString().slice(0, 10);
}

function todayEpochDay(nowMs, tzOffsetMinutes) {
    return Math.floor((nowMs + tzOffsetMinutes * 60000) / 86400000);
}

function mondayOf(day) {
    // epoch day 0 (1970-01-01) was a Thursday → (d+3)%7 = 0 on Mondays
    return day - ((day + 3) % 7);
}

function diffMinutes(fromMs, toMs) {
    // TimerManager.timeDiff truncates both operands to minutes
    return Math.floor(toMs / 60000) - Math.floor(fromMs / 60000);
}

function roundHalfUpDivide(total, divisor) {
    // BigDecimal.divide(..., HALF_UP).intValue()
    return Math.round(total / divisor);
}

function parseHoursMinutes(str, fallback) {
    // TimerManager.parseHoursMinutesString
    if (str === null || str === undefined || str === "")
        return fallback;
    var trimmed = String(str).trim();
    var negative = trimmed.indexOf("-") === 0;
    var s = trimmed.replace(/[- ]/g, "");
    var parts = s.split(/[:.]/);
    var h = parseInt(parts[0], 10);
    var m = parts.length > 1 ? parseInt(parts[1], 10) : 0;
    if (isNaN(h)) h = 0;
    if (isNaN(m)) m = 0;
    var total = h * 60 + m;
    return negative ? -total : total;
}

function formatMinutes(minutes) {
    // TimerManager.formatTime: "H:MM" / "-H:MM"
    var sign = minutes < 0 ? "-" : "";
    var abs = Math.abs(Math.round(minutes));
    var h = Math.floor(abs / 60);
    var m = abs % 60;
    return sign + h + ":" + (m < 10 ? "0" + m : "" + m);
}

// ---------- flexi reset scheduling (FlexiReset.getNextResetDate port) ----------

var RESET_SIZES = { DAILY: 1, WEEKLY: 1, MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 };

function nextResetAfter(day, interval) {
    var size = RESET_SIZES[interval];
    if (size === undefined)
        return -1;
    if (interval === "DAILY")
        return day + size;
    if (interval === "WEEKLY")
        return mondayOf(day) + 7 * size;
    // month-based intervals
    var ymd = dayToYMD(day);
    var monthsDelta = (ymd.m - 1) % size;
    var anchorMonth = ymd.y * 12 + (ymd.m - 1) - monthsDelta; // day 1 of anchor month
    var nextMonth = anchorMonth + size;
    return ymdToEpochDay(Math.floor(nextMonth / 12), (nextMonth % 12) + 1, 1);
}

function dayToYMD(epochDay) {
    var d = new Date(epochDay * 86400000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function ymdToEpochDay(y, m, d) {
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
