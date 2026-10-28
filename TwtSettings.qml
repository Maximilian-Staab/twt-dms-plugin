// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 twt-cloud contributors
//
// TwtSettings.qml — settings UI for the twtBar plugin.

import QtQuick
import qs.Common
import qs.Widgets
import qs.Modules.Plugins

PluginSettings {
    id: root
    pluginId: "twtBar"

    StyledText {
        width: parent.width
        text: qsTr("twtBar — Track Work Time")
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Font.Bold
        color: Theme.surfaceText
    }

    StyledText {
        width: parent.width
        text: qsTr("Shows your worked time and flexi balance in the bar, with clock in/out from the popout. Computation mirrors the TrackWorkTime app.")
        font.pixelSize: Theme.fontSizeSmall
        color: Theme.surfaceVariantText
        wrapMode: Text.WordWrap
    }

    StringSetting {
        settingKey: "apiBase"
        label: qsTr("API Base URL")
        description: qsTr("twt-cloud backend base, e.g. https://twt.example.com/api/v1. Plain http:// is only safe for loopback; non-loopback HTTP sends the bearer token unencrypted.")
        defaultValue: "http://localhost:9080/api/v1"
    }

    StringSetting {
        settingKey: "token"
        label: qsTr("Bearer Token (fallback)")
        description: qsTr("Manual authorization token, used only when you are not signed in. Prefer signing in from the widget popout (OAuth via your browser).")
        defaultValue: ""
    }

    SliderSetting {
        settingKey: "refreshIntervalSec"
        label: qsTr("Refresh Interval")
        description: qsTr("Seconds between backend refreshes")
        defaultValue: 60
        minimum: 10
        maximum: 600
        unit: "s"
    }

    StringSetting {
        settingKey: "homeOffsetMinutes"
        label: qsTr("Home Timezone Offset (minutes)")
        description: qsTr("East-positive UTC offset in minutes, e.g. 120 for UTC+2. Leave empty to follow the system timezone (DST-aware, recommended).")
        defaultValue: ""
    }

    ToggleSetting {
        settingKey: "flexiEnabled"
        label: qsTr("Flexi Time Enabled")
        description: qsTr("Track overtime/flexi balance (actual minus target)")
        defaultValue: true
    }

    StringSetting {
        settingKey: "flexiStartValue"
        label: qsTr("Flexi Start Value")
        description: qsTr("Overtime carried in at the start of tracking, H:MM")
        defaultValue: "0:00"
    }

    StringSetting {
        settingKey: "flexiTarget"
        label: qsTr("Weekly Target")
        description: qsTr("Target work time per week, H:MM")
        defaultValue: "40:00"
    }

    Column {
        id: workdaysSection
        width: parent.width
        spacing: Theme.spacingS

        property int mask: 31

        function loadValue() {
            const parsed = parseInt(root.loadValue("workdaysMask", 31))
            mask = isNaN(parsed) ? 31 : parsed
        }

        Component.onCompleted: Qt.callLater(loadValue)

        StyledText {
            text: qsTr("Workdays")
            font.pixelSize: Theme.fontSizeMedium
            font.weight: Font.Medium
            color: Theme.surfaceText
        }

        StyledText {
            width: parent.width
            text: qsTr("Regular workdays per week — the weekly target is split evenly across these days")
            font.pixelSize: Theme.fontSizeSmall
            color: Theme.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        DankFilterChips {
            id: dayChips
            width: parent.width
            multiSelect: true
            showCounts: false
            model: [qsTr("Mon"), qsTr("Tue"), qsTr("Wed"), qsTr("Thu"), qsTr("Fri"), qsTr("Sat"), qsTr("Sun")]
            selectedValues: {
                const sel = []
                for (let i = 0; i < 7; i++)
                    if ((workdaysSection.mask >> i) & 1)
                        sel.push(dayChips.model[i])
                return sel
            }
            onSelectionToggled: (index, selected) => {
                const bit = 1 << index
                const newMask = selected ? (workdaysSection.mask | bit) : (workdaysSection.mask & ~bit)
                workdaysSection.mask = newMask
                root.saveValue("workdaysMask", newMask)
            }
        }
    }

    SelectionSetting {
        settingKey: "resetInterval"
        label: qsTr("Flexi Reset Interval")
        description: qsTr("How often the flexi balance resets to zero")
        defaultValue: "NONE"
        options: [
            { label: qsTr("None"), value: "NONE" },
            { label: qsTr("Daily"), value: "DAILY" },
            { label: qsTr("Weekly"), value: "WEEKLY" },
            { label: qsTr("Monthly"), value: "MONTHLY" },
            { label: qsTr("Quarterly"), value: "QUARTERLY" },
            { label: qsTr("Half-Yearly"), value: "HALF_YEARLY" },
            { label: qsTr("Yearly"), value: "YEARLY" }
        ]
    }
}
