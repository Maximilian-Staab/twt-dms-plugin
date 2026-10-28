// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 twt-cloud contributors
//
// TwtStartupCheck.qml — DMS dependency gate for the twtBar plugin.

import QtQuick
import qs.Common

QtObject {
    function check(done) {
        Proc.runCommand("twtBar.depCheck",
            ["sh", "-c", "command -v curl >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1"],
            (stdout, exitCode) => {
                if (exitCode === 0) {
                    done(null);
                    return;
                }
                done({
                    "title": "curl and python3 are required",
                    "details": "twtBar uses curl for REST calls and python3 for OAuth sign-in/token refresh. Install both, make sure they are on PATH, then re-enable the plugin."
                });
            });
    }
}
