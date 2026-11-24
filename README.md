# ZdrofiBot

Registers for zdrofit.pl classes the moment registration opens.

This branch is being rewritten as a small service. Until cutover, `index.mjs` is still the working MVP, and `npm start` runs it.

## Development

Needs Node 24. Run `corepack enable` once, so that `pnpm` is available.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

After changing `libs/db/src/schema.ts`, create a migration with `pnpm db:generate --name <what_changed>`. Without `--name`, drizzle-kit picks random words.

## Running it locally

Postgres runs in Docker locally. Production uses Neon.

```sh
cp .env.example .env              # then set SECRETS_LOCAL_KEK, and TELEGRAM_BOT_TOKEN if you have one
pnpm dev:db                       # Postgres on 127.0.0.1:54320. Stop it with pnpm dev:db:stop
pnpm build
pnpm db:migrate
pnpm cli add-user --name <name> --login <portal email> --club warszawa-zoliborz-szamocka
node recon/login.mjs home         # log in by hand, tick the checkbox
pnpm cli import-session --recon home
```

Then start both workers, each in its own terminal, under `caffeinate -i` so the Mac doesn't sleep:

```sh
caffeinate -i pnpm start:session
caffeinate -i pnpm start:fire
```

Pick classes and add jobs. Only use classes you're happy to book, and never one the MVP is also handling:

```sh
pnpm cli discover
pnpm cli classes --search joga --days 3
pnpm cli add-job --class <id>
pnpm cli jobs
pnpm cli status                   # session state, and recorded session lifetimes
```

To get alerts on Telegram, set `TELEGRAM_BOT_TOKEN`, restart the session-worker, run `pnpm cli telegram-link` and open the link on your phone. `pnpm cli help` lists every command.

### Settings

Both workers and the CLI read `.env` from the repository root.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. On Neon, use the direct endpoint: pg-boss can't use the pooler |
| `SECRETS_LOCAL_KEK` | Development master key, 32 bytes in base64. Production will use KMS instead |
| `TELEGRAM_BOT_TOKEN` | From @BotFather. Without it, alerts are only logged. Never commit it or paste it anywhere |
| `WORKER_ID` | Fire worker only. Stable per container, so a restart takes back its own jobs at once. Defaults to `fire-<hostname>` |
| `ZDROFIT_BASE_URL` | Portal origin, for pointing at the mock portal. Defaults to `https://zdrofit.pl` |
| `DISCOVERY_CLUBS` | Extra clubs to keep in the class list, comma-separated |
| `RECONNECT_URL` | Adds a Reconnect button to alerts, once assisted login exists (M4) |
| `PORTAL_USER_AGENT` | Optional |

Generate a key with `node -e "console.log(crypto.randomBytes(32).toString('base64'))"`. If you lose it, stored sessions can't be read, and you log in again.

## The session worker

Runs periodic work through pg-boss, in Warsaw time:

| Task | When | What |
| --- | --- | --- |
| discovery | hourly, and at start | Copies the public schedule into `portal_activities`, and moves pending jobs if a class's time changes |
| keep-alive | every 20 min, and at start | Checks each live session, keeps rotated cookies, and records a death in `session_ends` with its lifetime. Skips accounts with an armed job |
| alert-ladder | every minute | For each account's next job within the hour, alerts at T-60/30/15/10/5 while the session is dead, then sends one "all good" |
| retention | 03:30 | Drops expired Telegram link codes and classes over 30 days old that no job uses |

It also long-polls Telegram for the Start link. The fire worker never changes session state, so the session worker is the only writer.

## The fire worker

On SIGTERM it hands back jobs more than 2 minutes away and finishes the rest, so a stop can take up to about 2.5 minutes.

### How a job fires

1. Every 30 s, jobs opening within 10 minutes are claimed with `FOR UPDATE SKIP LOCKED` and a 45 s lease.
2. At T-60 s the worker loads the session and takes the booking token from another open class. Tokens are per session, so it works for the target. It retries every 10 s until T-3 s, reloading the session each time, so a reconnect just before T still counts.
3. At T-5 s it opens a fresh connection. At T-2 s it writes `FIRING`, its last database write before the response.
4. At T it sends one POST. Several users wanting the same moment go in a new random order each time.
5. "Not open yet" is retried, up to 3 POSTs in total. No answer, or one it can't read, goes to `VERIFYING`. It then reads the class page from the same session. If the class is open with seats left and not booked, it may send one more POST, which is safe because the portal treats a repeat as a no-op.
6. A job whose worker died mid-fire is only checked, never sent again. A job found more than 2 minutes after T becomes `MISSED`.

## Layout

| Path | Purpose |
| --- | --- |
| `apps/api` | HTTP API |
| `apps/fire-worker` | Fires registrations. Must never depend on Playwright |
| `apps/session-worker` | Discovery, keep-alive, alerts, Telegram, and the admin CLI |
| `libs/portal` | The only code that knows the portal's URLs and markup |
| `libs/scheduling` | Opening times and job states |
| `libs/db` | Schema and migrations. `@zdrofibot/db/testing` gives tests an in-memory Postgres |
| `libs/crypto` | Envelope encryption for secrets |
| `libs/sessions` | Reads and writes encrypted portal sessions |
| `test/mock-portal` | Fake portal for tests, rendering real markup from `fixtures/` |
| `recon/` | Throwaway probes. See `recon/README.md` |

Regenerate fixtures with `node recon/make-fixtures.mjs`. It fails if anything personal or a real token gets through.
