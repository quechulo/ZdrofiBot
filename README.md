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

After changing `libs/db/src/schema.ts`, run `pnpm db:generate` to create a migration.

## Running the fire worker

It needs a Postgres with the migrations applied, and these variables:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Use Neon's direct endpoint, not the pooler |
| `SECRETS_LOCAL_KEK` | Development master key, 32 bytes in base64. Production will use KMS instead |
| `WORKER_ID` | Stable per container, so a restart takes back its own jobs at once. Defaults to `fire-<hostname>` |
| `ZDROFIT_BASE_URL` | Portal origin, for pointing at the mock portal. Defaults to `https://zdrofit.pl` |
| `PORTAL_USER_AGENT` | Optional |

Generate a key with `node -e "console.log(crypto.randomBytes(32).toString('base64'))"`. On SIGTERM the worker hands back jobs more than 2 minutes away and finishes the rest, so a stop can take up to about 2.5 minutes.

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
| `apps/session-worker` | Discovery, keep-alive, logins and alerts |
| `libs/portal` | The only code that knows the portal's URLs and markup |
| `libs/scheduling` | Opening times and job states |
| `libs/db` | Schema and migrations. `@zdrofibot/db/testing` gives tests an in-memory Postgres |
| `libs/crypto` | Envelope encryption for secrets |
| `libs/sessions` | Reads and writes encrypted portal sessions |
| `test/mock-portal` | Fake portal for tests, rendering real markup from `fixtures/` |
| `recon/` | Throwaway probes. See `recon/README.md` |

Regenerate fixtures with `node recon/make-fixtures.mjs`. It fails if anything personal or a real token gets through.
