# ZdrofiBot

Automatic class registration for [zdrofit.pl](https://zdrofit.pl).

Popular Zdrofit classes such as reformer fill up within seconds after registration opens, which is **48 hours before the class starts**. ZdrofiBot runs on your computer and submits your registration the moment registration opens. You add classes and watch the results in a small local dashboard.

---

> [!WARNING]
> **Your computer must stay on and awake the whole time.**
>
> ZdrofiBot is not a cloud service. It only works while `npm start` is running in a terminal on your machine. If, at the moment registration opens, the computer is **asleep, shut down, offline, or the terminal window is closed**, the registration is **missed**. The bot does not catch up later, because by then the spots are gone.
>
> - **Keep the computer plugged in** and turn off automatic sleep:
>   - **macOS:** start the bot with `caffeinate -is npm start` instead of `npm start`. This blocks idle and system sleep while the bot runs (system sleep only on AC power). **Closing a laptop lid still puts it to sleep** unless an external display is connected (clamshell mode), so keep the lid open.
>   - **Windows:** Settings → System → Power & battery → Screen and sleep → set *"When plugged in, put my device to sleep after"* to **Never**.
>   - **Linux:** start with `systemd-inhibit --what=sleep:idle npm start`, or turn off suspend in your desktop's power settings.
> - An always-on desktop or mini PC works better than a laptop you carry around.
> - The screen may turn off. Only the computer itself has to stay awake.
> - **Someone sometimes has to be at the computer.** When your zdrofit.pl login session expires, the bot opens a browser window, and you must log in and tick the reCAPTCHA by hand (see [Logging in](#logging-in)). Until you do, registrations are blocked.

---

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [First run](#first-run)
- [Logging in](#logging-in)
- [Adding classes](#adding-classes)
- [How it works](#how-it-works)
- [Dashboard and statuses](#dashboard-and-statuses)
- [Files and state](#files-and-state)
- [Notifications](#notifications)
- [Troubleshooting](#troubleshooting)
- [Disclaimer](#disclaimer)

## Requirements

| What | Notes |
|---|---|
| **Node.js 20.12 or newer** | Use the current **LTS** release. Older Node versions fail on start. |
| npm | Comes with Node.js. |
| git | To clone the repository. |
| Chromium for Playwright | Installed with one command, see below. |
| A zdrofit.pl account | With an active membership at the club you book. |
| A desktop session | macOS, Windows or Linux with a screen, because the login window must be visible. A headless server won't work. |
| Correct clock and timezone | The system timezone must be **Europe/Warsaw** and the clock synced automatically. Registration times are calculated from your computer's local time. |

## Installation

### 1. Install Node.js

The recommended way is **nvm** (Node Version Manager). It installs Node without admin rights and makes later upgrades easy.

**macOS / Linux**

```bash
# Install nvm (check https://github.com/nvm-sh/nvm#installing-and-updating for the latest version)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# Close and reopen the terminal, then:
nvm install --lts
nvm use --lts
```

**Windows**

Use [nvm-windows](https://github.com/coreybutler/nvm-windows/releases), or download the **LTS** installer from [nodejs.org](https://nodejs.org/). With nvm-windows:

```powershell
nvm install lts
nvm use lts
```

**Check that it works** (in a new terminal):

```bash
node -v   # must print v20.12.0 or higher
npm -v
```

### 2. Get the code and install dependencies

```bash
git clone https://github.com/quechulo/ZdrofiBot.git
cd ZdrofiBot
npm install
```

### 3. Install the Playwright browser

The bot drives a real Chromium browser through [Playwright](https://playwright.dev/), both to log in and to find classes on the schedule page. `npm install` installs the Playwright library but **not the browser itself**, so install it separately:

```bash
npx playwright install chromium
```

On **Linux**, also install the system libraries Chromium needs:

```bash
npx playwright install --with-deps chromium
```

> If you skip this step, the bot fails with an error like `browserType.launch: Executable doesn't exist`. Run the command again whenever you upgrade the `playwright` package.

## First run

```bash
npm start
```

(On macOS, use `caffeinate -is npm start` so the computer doesn't sleep, see the warning above.)

What happens:

1. The terminal prints a line like `Dashboard: http://127.0.0.1:54321`, and the dashboard opens in your default browser.
2. The bot has no saved session yet, so it opens a **separate Chromium window** on the zdrofit.pl login page. Log in there (see the next section).
3. Add your classes in the dashboard (see [Adding classes](#adding-classes)).

**Leave the terminal window open.** Closing it or pressing `Ctrl+C` stops the bot.

### Using a fixed port

By default the dashboard picks a free port at random. To always use the same port:

```bash
npm start -- --port 8080
# or, on macOS / Linux:
PORT=8080 npm start
```

If that port is taken, the bot falls back to a random free port and prints the URL it ended up using.

## Logging in

zdrofit.pl login uses a reCAPTCHA, so the bot cannot log in by itself. When it needs a session:

1. A Chromium window opens on zdrofit.pl.
2. Log in with your email and password and **tick the reCAPTCHA** (solve the image challenge if one appears).
3. Once you're logged in, **go back to the terminal and press Enter.**
4. The bot saves your session to `.state/auth.json`, closes the window and carries on without you.

The bot checks the session **every 15 minutes**. If the session has expired, it opens the login window again and sends an alert (see [Notifications](#notifications)). Respond quickly: a registration that fires while the session is dead fails with the status `waiting-for-login`.

> Because the login step waits for Enter in the terminal, run the bot in a normal, interactive terminal window. Don't run it in the background (`nohup`, `pm2`, a system service, etc.).

## Adding classes

### Using the dashboard (recommended)

1. Open the **Activities** tab.
2. Click **+ Add a club**.
3. **Link**: paste the URL of the club's *Grafik zajęć* (class schedule) page from zdrofit.pl, for example
   `https://zdrofit.pl/kluby-fitness/warszawa-zoliborz-szamocka/grafik-zajec`
4. **Keyword**: a word from the class name, matched without regard to case (e.g. `reformer`). Leave it empty to match any class at that date and time.
5. Click **+ Add date/time** for every class you want: the class's **date and start time**, not the time registration opens.
6. Click **Save**.

The bot works out the registration time (start time minus 48 h) on its own, and new entries show up in the **Status** tab right away. If you add a class that starts in less than 48 hours, registration is already open, so the bot tries to register straight away.

To cancel a class you haven't registered for yet, remove it in the dashboard and save. Its status changes to `cancelled`.

### `activities.json` format

The dashboard stores your classes in `activities.json` next to `index.mjs`. For reference, the format is:

```json
[
  {
    "link": "https://zdrofit.pl/kluby-fitness/warszawa-zoliborz-szamocka/grafik-zajec",
    "keyword": "reformer",
    "dates": {
      "2026-12-03": ["19:00", "20:00"],
      "2026-12-05": ["10:00"]
    },
    "enabled": true
  }
]
```

| Field | Meaning |
|---|---|
| `link` | URL of the club's schedule page (`…/kluby-fitness/<club>/grafik-zajec`). |
| `clubSlug` | Optional. The `<club>` part of the URL. If missing, it's taken from `link`. |
| `keyword` | Part of the class name to match, case-insensitive. Empty matches anything at that time. |
| `dates` | Map of `YYYY-MM-DD` → list of class start times `HH:MM` (local Warsaw time). |
| `enabled` | Set to `false` to skip this club entry without deleting it. |

> **Use the dashboard rather than editing this file by hand.** The bot reads `activities.json` on its own only on the very first start, when it builds its queue (`.state/pending.json`). After that, only changes saved through the dashboard are applied.

## How it works

For every class, the bot works out a **trigger time** = class start − 48 h, then:

1. **Discovery.** A hidden (headless) browser opens the club schedule and looks up the internal ID of the class that matches the date, time and keyword. It tries once right away, and again every 15 s from 5 minutes before the trigger.
2. **Warm-up.** 2 seconds before the trigger, it fetches a fresh form token and keeps the connection open.
3. **Fire.** At the exact trigger moment it sends the registration request. If the response doesn't confirm success, it retries once with a fresh token.

In the background:

- a **session watchdog** checks your login every 15 minutes and asks you to log in again when needed;
- a **heartbeat** scans the queue every 15 seconds, so nothing is missed after a restart.

You can stop and restart the bot safely. Pending classes are stored on disk and picked up again on start. A class whose trigger passed while the bot was off is tried as soon as the bot starts again, but by then the spots are usually taken.

## Dashboard and statuses

The dashboard is only reachable from your own computer (`127.0.0.1`). It has three tabs:

- **Activities**: add, edit and remove classes.
- **Status**: every queued class with its trigger time, attempts and status.
- **Logs**: alerts and the full activity log.

| Status | Meaning |
|---|---|
| `pending` | Waiting for its trigger time. |
| `done` | ✅ Registered successfully. |
| `failed` | The registration was sent but not confirmed (class full, already booked, site error…). |
| `failed-discovery` | The class couldn't be found on the schedule. Check the link, keyword, date and time. |
| `failed-token` | The registration form couldn't be read from the class page. |
| `waiting-for-login` | The session was invalid at trigger time, so nothing was sent. |
| `cancelled` | You removed the class before it fired. |

## Files and state

Everything the bot creates lives next to `index.mjs`:

| Path | Contents |
|---|---|
| `activities.json` | Your class list (written by the dashboard). |
| `.state/auth.json` | Your saved zdrofit.pl login session (cookies). |
| `.state/pending.json` | The queue: every class, its trigger time and its status. |
| `.state/app.log` | Full activity log (trimmed automatically when it gets large). |
| `.state/alerts.log` | Important alerts only. |
| `.state/last-gather.json` | Debug output from the latest class lookup. |

> [!CAUTION]
> `.state/auth.json` gives **full access to your zdrofit.pl account**. Never share it or commit it. It's already in `.gitignore`.

## Notifications

When something needs your attention (session expired, a registration blocked by a dead session, a watchdog error), the bot:

- prints a large `[ALERT]` banner in the terminal and rings the terminal bell,
- appends a line to `.state/alerts.log` (also shown in the dashboard's **Logs** tab),
- shows a system notification on **macOS** (with sound) or on **Linux** (if `notify-send` is installed). Windows gets the first two only.

If you get a **"session expired"** alert, go to the computer, finish logging in in the Chromium window and press **Enter** in the terminal.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Executable doesn't exist` / browser won't launch | Run `npx playwright install chromium` (Linux: add `--with-deps`). |
| `SyntaxError` or an error about `node:sea` on start | Your Node.js is too old. Install the current LTS (see [Install Node.js](#1-install-nodejs)) and check `node -v`. |
| The dashboard didn't open | Copy the `Dashboard: http://127.0.0.1:…` URL from the terminal into your browser. |
| Status `failed-discovery` | Open the class link yourself and check that the class exists at that date and time and that its name contains your keyword. Details are in `.state/last-gather.json`. |
| Status `waiting-for-login` | Your session expired. Log in again when the window appears. To prevent this, watch for alerts and keep the computer awake. |
| Registration fired at the wrong time | Check that the system timezone is Europe/Warsaw and that the clock is set automatically. |
| Hand edits to `activities.json` are ignored | Make changes in the dashboard. To rebuild the queue from the file instead: stop the bot, delete `.state/pending.json` and start it again (this clears the status history). |
| The login window keeps appearing | Make sure you pressed **Enter** in the terminal *after* logging in fully. Delete `.state/auth.json` and log in again if it still happens. |
| Stopping the bot | Press `Ctrl+C` in the terminal. |

## Disclaimer

This is an unofficial, personal-use tool. It is not affiliated with or endorsed by Zdrofit. Use it responsibly and in line with your club's terms of service.
