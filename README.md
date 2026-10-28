# twtBar

A [DankMaterialShell](https://github.com/AvengeMedia/DMS) bar widget for
[TrackWorkTime](https://codeberg.org/mathisdt/trackworktime) users: a compact
pill showing today's worked time, with a popout for clock in / clock out, the
flexi balance, and OAuth sign-in.

All work-time math runs client-side. The widget is a client for a self-hosted
**twt-cloud** backend (the storage/OIDC backend from the TrackWorkTime fork);
it stores no data locally beyond the auth state needed to talk to that
backend.

> Unofficial project. It is not affiliated with the upstream TrackWorkTime
> author. The calculation engine and OAuth helper are GPL-3.0 ports of
> TrackWorkTime code — see [License](#license).

## Features

- Bar pill with worked-today time; the icon reflects clocked-in/out state and
  turns amber for an insecure transport or red on fetch/auth errors.
- Popout with **Clock In** / **Clock Out**, today's worked time, and the
  flexi/overtime balance.
- OAuth 2.0 Authorization Code + PKCE via the system browser and a loopback
  redirect; access tokens refresh in the background.
- Incremental polling (events newer than the newest row) with a six-hour full
  re-baseline so edits/deletes in older history are picked up.
- Client-side day bucketing is DST-aware and follows the system timezone, or a
  fixed UTC offset if configured.
- No build step: plain QML, JavaScript, and a Python stdlib helper.

## Requirements

- DankMaterialShell **>= 1.6.2**.
- `curl` **>= 7.55** (the bearer header is passed via `-H @file`) and
  `python3` (stdlib only) on DMS's `PATH`.
- A reachable **twt-cloud** backend. The widget uses:
  - `GET /config` and OIDC discovery for sign-in;
  - `GET /events` and `GET /targets` for the current data;
  - `POST /events` for clock in/out.
- For anything other than loopback, serve the backend over **HTTPS**. A bearer
  token sent over plain HTTP is readable on the network; the widget warns when
  it detects this.

## Install

### User plugin directory

Clone the repo and symlink it into DMS's plugin directory:

```sh
git clone https://github.com/Maximilian-Staab/twt-dms-plugin.git
mkdir -p ~/.config/DankMaterialShell/plugins
ln -s "$PWD/twt-dms-plugin" ~/.config/DankMaterialShell/plugins/twtBar
```

`cp -r` works too; the plugin has no build step. Then:

1. DMS **Settings → Plugins → Scan for Plugins**, enable **TrackWorkTime
   (twtBar)**.
2. Add the widget to a bar (DMS settings GUI, or add `"twtBar"` to the bar's
   `rightWidgets` in `~/.config/DankMaterialShell/settings.json`).
3. Restart DMS: `dms restart` (or `systemctl --user restart dms.service`).
4. Set **API Base URL** in DMS **Settings → Plugins → twtBar**, e.g.
   `https://twt.example.com/api/v1` or `http://localhost:9080/api/v1` for a
   local backend.
5. Open the pill and click the sign-in icon in the popout.

If the pill does not appear, run `dms kill && dms run` and check the log.
Common causes are a broken symlink, `curl`/`python3` missing from DMS's
`PATH`, or an unreachable backend.

### NixOS (system-wide, via flake)

The flake deploys the plugin to DMS's system plugin directory
(`/etc/xdg/quickshell/dms-plugins/twtBar`):

```nix
# system flake.nix
inputs.twt-dms-plugin.url = "github:Maximilian-Staab/twt-dms-plugin";

# NixOS configuration
imports = [ inputs.twt-dms-plugin.nixosModules.default ];
programs.twt.twtBar.enable = true;
```

The module takes `lib` from the importing system, so the flake pins no
nixpkgs. The plugin is plain data; `twt_auth.py` keeps its executable bit.

## Settings

Stored by DMS in `~/.config/DankMaterialShell/plugin_settings.json` under
`"twtBar"`:

| key | meaning |
| --- | --- |
| `apiBase` | backend base URL incl. `/api/v1`; use `https://` for remote hosts |
| `token` | manual bearer JWT — fallback for headless setups, stored in plaintext by DMS |
| `refreshIntervalSec` | backend poll interval (default 60) |
| `homeOffsetMinutes` | east-positive UTC offset in minutes; empty follows the system timezone (DST-aware) |
| `flexiEnabled` / `flexiStartValue` / `flexiTarget` | flexi-time accounting |
| `resetInterval` | flexi reset (`NONE`, `DAILY`, `WEEKLY`, `MONTHLY`, `QUARTERLY`, `HALF_YEARLY`, `YEARLY`) |
| `workdaysMask` | bitmask, bit 0 = Monday (default `31` = Mon–Fri) |

## Sign-in (OAuth)

The preferred path is the popout's sign-in icon. `twt_auth.py`:

1. fetches the backend `config`;
2. discovers the OIDC endpoints from the issuer;
3. runs Authorization Code + PKCE (S256) in the default browser, with the
   redirect accepted on a loopback listener;
4. exchanges the code and persists access/refresh tokens;
5. refreshes the access token on demand.

State lives in `~/.local/state/twtBar-auth/<b64url(apiBase)>.json` (`0600`);
override the directory with `TWT_AUTH_STATE_DIR`. A lock file serializes
concurrent refreshes across multiple widget instances.

For REST calls the resolved bearer header is written to
`$XDG_RUNTIME_DIR/twtBar-auth/<b64url(apiBase)>.headers`, handed to curl as
`-H @file`, and removed on sign-out. The plugin sets the directory to `0700`
and the file to `0600` after each write. If `$XDG_RUNTIME_DIR` is unset,
refresh and clock in/out refuse to run instead of writing the token elsewhere.

The manual `token` setting is a plaintext fallback stored in DMS settings.
Prefer OAuth. Sign-out clears local auth state but does not call an IdP
revocation endpoint.

## Backend

This repository contains only the desktop client. It expects a twt-cloud
backend implementing the storage REST API and the `/config` OAuth bootstrap.
The backend, its Docker deployment, and the normative OpenAPI contract live in
the **twt** project (the TrackWorkTime fork's monorepo). The widget does not
send telemetry; it only talks to the configured API base.

## Differences from the Android app

- **Auto-pause** is not modeled (the app's auto-pause is off by default). If
  you enabled it there, worked time and balance will differ.
- Clock in/out posts `task: null`; there is no task picker in the popout.
- `DAY_IGNORE` keeps the aggregate flexi balance (`actual - target`); the
  app's per-day frozen balance is not displayed.
- `FLEXI_SET` / `FLEXI_ADD` rows are stored by the backend but not consumed by
  the calculator, matching the app's calculator.

## Development

From this directory:

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
qmllint -W -1 TwtWidget.qml TwtSettings.qml TwtStartupCheck.qml
```

Node 22+ is required for the JavaScript tests; the Python tests use the
standard library only. CI runs the JavaScript/Python suites, QML syntax
checks, `py_compile`, and a manifest field/path check. QML runtime behavior
still needs a real DMS session for smoke testing.

The package layout is deliberately flat: `plugin.json` and the QML components
are at the repo root so DMS can load the checkout directly.

## License

GPL-3.0-only. See [LICENSE](LICENSE).

`TwtEngine.js` and `twt_auth.py` are derived from
[TrackWorkTime](https://codeberg.org/mathisdt/trackworktime), Copyright (C)
Mathis Dirksen-Thedens and contributors, licensed GPL-3.0. Modified for
twtBar; this project is unofficial and not endorsed by the upstream author.
