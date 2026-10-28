// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 twt-cloud contributors
//
// TwtWidget.qml — twtBar bar widget: worked-time pill + clock in/out popout.
//
// Data flow:
//   Timer (refreshIntervalSec) → TwtAuth.token(Proc, …) → TwtApi.fetchEvents
//   (full baseline every 6 h, incremental since the newest event otherwise)
//   → Engine.calculate(...) → calcValue {workedToday, balance, clockedIn} → pill + popout.
//
// Auth: twt_auth.py owns the OAuth state (browser PKCE round-trip, refresh,
// token file shared by all instances). Each refresh resolves the access
// token: sign-in state takes precedence; a manually configured
// pluginData.token is the fallback when not signed in.
// The resolved token is written to a header file under $XDG_RUNTIME_DIR
// (0700 tmpfs) and handed to curl via -H @file — never in curl argv.

import QtCore
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Common
import qs.Services
import qs.Widgets
import qs.Modules.Plugins

import "TwtEngine.js" as Engine
import "TwtApi.js" as TwtApi
import "TwtAuth.js" as TwtAuth

PluginComponent {
    id: root

    // ---- configuration (from plugin settings) ----
    readonly property string apiBase: {
        const raw = pluginData.apiBase
        const value = raw !== undefined && raw !== null && String(raw).trim() !== ""
                ? String(raw).trim() : "http://localhost:9080/api/v1"
        return value.replace(/\/+$/, "")
    }
    readonly property string manualToken: pluginData.token || ""
    readonly property int refreshIntervalSec: pluginData.refreshIntervalSec !== undefined ? pluginData.refreshIntervalSec : 60
    // Full re-baseline catches edits/deletes in older history; normal polls only
    // fetch events newer than the last one we already have.
    readonly property int fullRefreshIntervalMs: 6 * 60 * 60 * 1000
    readonly property int targetRefreshIntervalMs: 10 * 60 * 1000
    // east-positive minutes pinned via settings, else a DST-aware provider
    // following the system timezone (the app's home zone lives there)
    readonly property var homeOffset: {
        const raw = pluginData.homeOffsetMinutes
        if (raw !== undefined && String(raw) !== "") {
            const parsed = parseInt(raw)
            if (!isNaN(parsed))
                return parsed
        }
        return function (ms) { return -new Date(ms).getTimezoneOffset() }
    }
    readonly property var workdays: {
        const mask = pluginData.workdaysMask !== undefined ? pluginData.workdaysMask : 31
        const days = []
        for (let i = 0; i < 7; i++)
            days.push(((mask >> i) & 1) === 1)
        return days
    }
    readonly property string flexiStartValue: pluginData.flexiStartValue || "0:00"
    readonly property string flexiTarget: pluginData.flexiTarget || "40:00"
    readonly property bool flexiEnabled: pluginData.flexiEnabled !== undefined ? pluginData.flexiEnabled : true
    readonly property string resetInterval: pluginData.resetInterval || "NONE"
    // Plain HTTP to anything but loopback sends the bearer token unencrypted.
    readonly property bool insecureTransport: TwtApi.isInsecureHttpUrl(apiBase)

    // bundled helper (next to this QML file)
    readonly property url authScript: Qt.resolvedUrl("./twt_auth.py")
    // Auth header file: curl reads it via -H @file so the bearer token never
    // shows up in curl argv (ps). It lives under $XDG_RUNTIME_DIR; the helper
    // below narrows the directory to 0700 and the file to 0600 after each
    // write, so the token does not rely on the parent directory's mode alone.
    readonly property string authHeaderDir: {
        const rt = String(StandardPaths.writableLocation(StandardPaths.RuntimeLocation));
        return rt.startsWith("file://") ? rt.slice("file://".length) : rt;
    }
    readonly property string authHeaderPath: authHeaderDir + "/twtBar-auth/"
            + authHeaderKey(apiBase) + ".headers"

    function authHeaderKey(base) {
        // urlsafe-b64(apiBase) without padding — the same keying twt_auth.py
        // uses for its state files. Hand-rolled: Qt.btoa(string) is
        // deprecated in this Qt.
        const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let out = "";
        for (let i = 0; i < base.length; i += 3) {
            const n = (base.charCodeAt(i) << 16)
                    | ((base.charCodeAt(i + 1) || 0) << 8)
                    | (base.charCodeAt(i + 2) || 0);
            out += A[(n >> 18) & 63] + A[(n >> 12) & 63];
            if (i + 1 < base.length)
                out += A[(n >> 6) & 63];
            if (i + 2 < base.length)
                out += A[n & 63];
        }
        return out;
    }

    function secureAuthHeader() {
        if (authHeaderDir.length === 0)
            return;
        // Positional args keep paths out of the shell program text; the token
        // is already in the file and never appears in this argv.
        Proc.runCommand(null, ["sh", "-c",
            "umask 077; mkdir -p \"$1\" 2>/dev/null; chmod 700 \"$1\" 2>/dev/null; chmod 600 \"$2\" 2>/dev/null",
            "twtBar", authHeaderDir + "/twtBar-auth", authHeaderPath],
            function () {}, 0, 5000);
    }

    function removeAuthHeader() {
        if (authHeaderDir.length === 0)
            return;
        Proc.runCommand(null, ["sh", "-c", "rm -f \"$1\"", "twtBar", authHeaderPath],
            function () {}, 0, 5000);
    }

    function writeAuthHeader() {
        if (authHeaderDir.length === 0) {
            lastError = qsTr("XDG_RUNTIME_DIR is not set")
            return;
        }
        authHeaderFile.setText("Authorization: Bearer " + accessToken + "\n");
        secureAuthHeader();
    }

    Component.onCompleted: secureAuthHeader()

    FileView {
        id: authHeaderFile
        path: root.authHeaderPath
        blockWrites: true
        atomicWrites: true
        watchChanges: false
        onSaved: root.secureAuthHeader()
    }

    // ---- runtime state ----
    property var events: []
    property var targets: []
    property bool loading: false
    property string lastError: ""
    property var calcValue: null
    property double lastFullFetchMs: 0
    property double lastTargetFetchMs: 0
    property int eventRank: 0
    property int refreshGen: 0
    property bool posting: false
    property bool initialRefreshDone: false

    // auth state (resolved via twt_auth.py; shared by all bar instances)
    property string accessToken: ""
    property bool signedIn: false
    property bool signingIn: false

    readonly property int workedToday: calcValue ? calcValue.workedToday : 0
    readonly property int balance: calcValue ? calcValue.balance : 0
    readonly property bool clockedIn: calcValue ? calcValue.clockedIn : false
    readonly property string errorText: lastError.length > 0 ? qsTr("Error: %1").arg(lastError) : ""

    onApiBaseChanged: resetAndRefresh()
    onManualTokenChanged: resetAndRefresh()

    function resetData() {
        events = []
        targets = []
        lastFullFetchMs = 0
        lastTargetFetchMs = 0
        eventRank = 0
        // Drop the rendered result too: sign-out / API-base changes must not
        // leave the previous account's or backend's numbers in the pill when
        // the next refresh stops before recalc() (e.g. no token).
        calcValue = null
    }

    function resetAndRefresh() {
        resetData()
        initialRefreshDone = true
        refresh(true)
    }

    function refresh(forceFull) {
        if (!apiBase) {
            lastError = qsTr("apiBase not set")
            return
        }
        const gen = ++refreshGen
        loading = true
        // resolve access token: sign-in state > manual pluginData.token
        TwtAuth.token(Proc, authScript, apiBase, (err, tok) => {
            if (gen !== refreshGen)
                return
            if (err) {
                console.warn("twtBar: auth token:", err)
                if (!manualToken) {
                    loading = false
                    lastError = err
                    return
                }
                // Keep the error visible but still try the manual fallback.
                lastError = err
            }
            if (tok) {
                signedIn = true
                accessToken = tok
            } else {
                signedIn = false
                accessToken = manualToken
                if (!manualToken) {
                    loading = false
                    lastError = qsTr("no token — sign in from the popout")
                    return
                }
            }
            if (authHeaderDir.length === 0) {
                loading = false
                lastError = qsTr("XDG_RUNTIME_DIR is not set")
                return
            }
            writeAuthHeader()
            _fetchWindow(gen, forceFull === true)
        })
    }

    function _fetchWindow(gen, forceFull) {
        // `to` is exclusive on the backend: +1 keeps an event posted at the
        // current second visible to the refresh triggered right after it.
        const toSec = Math.floor(Date.now() / 1000) + 1
        const full = forceFull || events.length === 0 || lastFullFetchMs === 0
                || (Date.now() - lastFullFetchMs) > fullRefreshIntervalMs
        const fromSec = full ? 0 : Math.max(0, newestEventSec() - 2)

        TwtApi.fetchEvents(Proc, apiBase, authHeaderPath, fromSec, toSec, (err, fetched, status) => {
            if (gen !== refreshGen)
                return
            if (err) {
                loading = false
                lastError = err
                console.warn("twtBar: events:", err)
                if (status === 401 && signedIn) {
                    // token rejected: force a helper refresh so the next
                    // cycle starts fresh
                    TwtAuth.token(Proc, authScript, apiBase, (e2) => {
                        if (e2)
                            console.warn("twtBar: reauth:", e2)
                    }, true)
                }
                return
            }
            if (full) {
                events = rankEvents(fetched || [])
                lastFullFetchMs = Date.now()
            } else {
                events = mergeEvents(events, fetched || [])
            }

            const targetsDue = full || lastTargetFetchMs === 0
                    || (Date.now() - lastTargetFetchMs) > targetRefreshIntervalMs
            if (!targetsDue) {
                loading = false
                lastError = ""
                recalc()
                return
            }
            TwtApi.fetchTargets(Proc, apiBase, authHeaderPath, (err2, fetchedTargets, status2) => {
                if (gen !== refreshGen)
                    return
                loading = false
                if (err2) {
                    lastError = err2
                    console.warn("twtBar: targets:", err2)
                    return
                }
                targets = fetchedTargets || []
                lastTargetFetchMs = Date.now()
                lastError = ""
                recalc()
            })
        })
    }

    function newestEventSec() {
        let max = 0
        for (let i = 0; i < events.length; i++) {
            if (events[i].time > max)
                max = events[i].time
        }
        return max
    }

    // The engine breaks same-second ties by array order, so keep a stable rank
    // across incremental merges (new events append after existing ones).
    function rankEvents(list) {
        eventRank = 0
        for (let i = 0; i < list.length; i++)
            list[i]._rank = eventRank++
        return list
    }

    function mergeEvents(current, incoming) {
        const out = current.slice()
        const indexById = {}
        for (let i = 0; i < out.length; i++) {
            if (out[i].id !== undefined)
                indexById[out[i].id] = i
        }
        for (let j = 0; j < incoming.length; j++) {
            const ev = incoming[j]
            const key = ev.id !== undefined ? ev.id : (ev.time + ":" + ev.type)
            if (indexById[key] !== undefined) {
                ev._rank = out[indexById[key]]._rank
                out[indexById[key]] = ev
            } else {
                ev._rank = eventRank++
                indexById[key] = out.length
                out.push(ev)
            }
        }
        out.sort((a, b) => (a.time - b.time) || ((a._rank || 0) - (b._rank || 0)))
        return out
    }

    function applyEvent(created) {
        if (!created || created.id === undefined)
            return
        if (events.length === 0)
            events = rankEvents([created])
        else
            events = mergeEvents(events, [created])
    }

    function recalc() {
        const now = new Date()
        const settings = {
            flexiEnabled: root.flexiEnabled,
            flexiStartValue: root.flexiStartValue,
            flexiTarget: root.flexiTarget,
            workdays: root.workdays,
            resetInterval: root.resetInterval
        }
        calcValue = Engine.calculate(events, targets, settings, now.getTime(), root.homeOffset)
    }

    // live "now" tick only while a session is open
    Timer {
        interval: 30000
        running: root.clockedIn
        repeat: true
        onTriggered: {
            root.recalc()
        }
    }

    // periodic refresh from backend (also re-fetches after clock in/out)
    Timer {
        interval: Math.max(5, root.refreshIntervalSec) * 1000
        running: root.apiBase !== ""
        repeat: true
        triggeredOnStart: true
        onTriggered: {
            const first = !root.initialRefreshDone
            root.initialRefreshDone = true
            root.refresh(first)
        }
    }

    function clockIn() {
        if (!posting)
            postEvent("CLOCK_IN")
    }

    function clockOut() {
        if (!posting)
            postEvent("CLOCK_OUT")
    }

    function postEvent(type) {
        if (posting)
            return
        if (authHeaderDir.length === 0) {
            const missing = qsTr("XDG_RUNTIME_DIR is not set")
            lastError = missing
            ToastService.showError(qsTr("twtBar"), missing)
            return
        }
        posting = true
        const nowD = new Date()
        const ev = {
            time: Math.floor(nowD.getTime() / 1000),
            zoneOffset: -nowD.getTimezoneOffset(),
            type: type,
            task: null,
            comment: ""
        }
        writeAuthHeader()
        TwtApi.postEvent(Proc, apiBase, authHeaderPath, ev, (err, created) => {
            posting = false
            if (err) {
                lastError = err
                console.warn("twtBar: post event:", err)
                ToastService.showError(qsTr("twtBar"), err)
                return
            }
            // Apply the server's row immediately; the follow-up refresh only
            // reconciles, so the pill/popout never lag behind the click.
            applyEvent(created)
            lastError = ""
            recalc()
            ToastService.showInfo(type === "CLOCK_IN" ? qsTr("Clocked in") : qsTr("Clocked out"))
            refresh()
        })
    }

    // ---- sign-in / sign-out (delegated to twt_auth.py) ----

    function signIn() {
        if (signingIn)
            return
        signingIn = true
        TwtAuth.signIn(Proc, authScript, apiBase, (err) => {
            signingIn = false
            if (err) {
                lastError = err
                console.warn("twtBar: sign in:", err)
                ToastService.showError(qsTr("twtBar"), err)
                return
            }
            // Different account (or fresh state): never merge into old rows.
            resetData()
            refresh(true)
        })
    }

    function signOut() {
        TwtAuth.signOut(Proc, authScript, apiBase, (err) => {
            if (err) {
                lastError = err
                console.warn("twtBar: sign out:", err)
                ToastService.showError(qsTr("twtBar"), err)
                return
            }
            authHeaderFile.setText("")
            removeAuthHeader()
            accessToken = ""
            signedIn = false
            resetData()
            refresh(true)
        })
    }

    horizontalBarPill: Component {
        Row {
            spacing: Theme.spacingXS

            DankIcon {
                name: root.clockedIn ? "schedule" : "pause_circle"
                size: root.iconSize
                color: root.lastError ? Theme.error
                       : (root.insecureTransport ? Theme.warning
                       : (root.clockedIn ? Theme.success : Theme.widgetInactiveIconColor))
                anchors.verticalCenter: parent.verticalCenter
            }

            StyledText {
                text: Engine.formatMinutes(root.workedToday)
                font.pixelSize: Theme.barTextSize(root.barThickness, root.barConfig?.fontScale, root.barConfig?.maximizeWidgetText)
                color: Theme.widgetTextColor
                anchors.verticalCenter: parent.verticalCenter
            }
        }
    }

    verticalBarPill: Component {
        Column {
            spacing: Theme.spacingXXS

            DankIcon {
                name: root.clockedIn ? "schedule" : "pause_circle"
                size: root.iconSize
                color: root.lastError ? Theme.error
                       : (root.insecureTransport ? Theme.warning
                       : (root.clockedIn ? Theme.success : Theme.widgetInactiveIconColor))
                anchors.horizontalCenter: parent.horizontalCenter
            }

            StyledText {
                text: Engine.formatMinutes(root.workedToday)
                font.pixelSize: Theme.barTextSize(root.barThickness, root.barConfig?.fontScale, root.barConfig?.maximizeWidgetText)
                color: Theme.widgetTextColor
                anchors.horizontalCenter: parent.horizontalCenter
            }
        }
    }

    popoutContent: Component {
        PopoutComponent {
            id: popoutRoot

            headerText: qsTr("Work Time")
            detailsText: qsTr("Worked today: %1").arg(Engine.formatMinutes(root.workedToday))
                         + qsTr("  •  Balance: %2").arg(Engine.formatMinutes(root.balance))
                         + (root.errorText.length > 0 ? "\n" + root.errorText : "")
                         + (root.insecureTransport ? "\n" + qsTr("Warning: plain HTTP sends your bearer token unencrypted. Use https:// for any non-loopback host.") : "")
            showCloseButton: true
            closePopout: function () { root.closePopout() }

            // compact sign-in/sign-out toggle: icon + hover tooltip,
            // mutually exclusive by auth state
            headerActions: Component {
                DankActionButton {
                    iconName: root.signedIn ? "logout" : "login"
                    iconColor: root.signedIn ? Theme.primary : Theme.widgetInactiveIconColor
                    opacity: root.signingIn ? 0.5 : 1
                    enabled: !root.signingIn
                    tooltipText: root.signingIn ? qsTr("Signing in…")
                                : root.signedIn ? qsTr("Sign Out")
                                : qsTr("Sign In")
                    onClicked: root.signedIn ? root.signOut() : root.signIn()
                }
            }

            Column {
                width: parent.width
                spacing: Theme.spacingS

                DankButton {
                    width: parent.width
                    text: root.posting ? qsTr("Clocking…")
                          : (root.clockedIn ? qsTr("Clock Out") : qsTr("Clock In"))
                    iconName: root.clockedIn ? "logout" : "login"
                    enabled: !root.posting
                    onClicked: root.clockedIn ? root.clockOut() : root.clockIn()
                }

                DankButton {
                    width: parent.width
                    text: qsTr("Refresh")
                    iconName: "refresh"
                    enabled: !root.loading
                    onClicked: root.refresh(true)
                }
            }
        }
    }

    popoutWidth: 300
    popoutHeight: 280
}
