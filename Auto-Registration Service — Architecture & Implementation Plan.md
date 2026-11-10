# Auto-Registration Service — Architecture & Implementation Plan

## Goals and scope

Turn the single-script MVP into a small, invite-only service. It registers users for portal activities at the exact opening time, keeps their portal sessions alive, and repairs them automatically. Only users holding a valid token can do anything.

**Goals**

1. Only users with an admin-issued token can see or schedule anything. Everything else gets 401.
2. Registrations fire at the opening time, measured to under a second, and are never duplicated.
3. A dead portal session is found and repaired well before a registration is due, never at the moment of firing.
4. Manual re-login is the last resort. When it is needed, it takes the user under a minute, from their phone, inside our UI.
5. No portal password, cookie or access token is ever readable in plain text outside the worker's memory.

**Non-goals for v1:** public sign-up, more than one portal, hundreds of concurrent users, a native mobile app.

**Assumptions to confirm** (see Open questions): the portal has no official API; each user has their own portal account; the captcha type is still unknown.

**Terms of service.** Check the portal's terms before going further. Some portals forbid automated access or captcha automation, and breaking that can get user accounts banned. The design below keeps captcha handling pluggable, so the default path never needs to solve a captcha automatically.

## Architecture overview

One GCE VM runs three containers behind Caddy. Neon holds all state, and Cloud KMS holds the only key that can open stored secrets.

&#91;embedded content: system architecture · one VM, three containers, Neon, KMS\]

The API never talks to the portal and can't decrypt anything. It only writes encrypted credentials and jobs to Neon. The worker takes jobs from the queue, decrypts sessions in memory only, and uses Chromium only to log in.

**Why one VM, not Cloud Run.** Persistent browser profiles, timers that fire to the second and one static outgoing IP all need a long-running machine. Cloud Run's scale-to-zero and changing IPs work against all three. You can move the API to Cloud Run later if you need to.

## Portal sessions and automatic login

A captcha can't be avoided with full reliability, so the system is built so that captchas rarely matter. It keeps sessions alive, re-logs in quietly and early, and passes a challenge to the user only when it must, hours before anything is due.

**Why the MVP breaks.** It probably saves cookies once and replays them. That fails when the portal has an absolute session lifetime, rotates a CSRF or refresh token on each response, or ties the session to browser fingerprint or IP. Check which of these applies first, because the fix differs (see Open questions).

**Layered strategy, cheapest first**

| Layer | What it does | When it runs | Needs the user? |
| --- | --- | --- | --- |
| 1. Keep-alive | Plays the whole `storageState` (cookies + localStorage) and saves every rotated cookie and token back after each response | Every N minutes, below the idle timeout, with random jitter | No |
| 2. Silent re-login | Logs in with Playwright using a **persistent browser profile per user**, from the same fixed VM IP, with "remember me" ticked. Invisible or risk-based captchas often pass trusted returning profiles without a challenge | When keep-alive fails, or ahead of the absolute expiry, at quiet hours | No |
| 3. Assisted re-login | Pauses at the challenge, marks the account `NEEDS_USER` and notifies the user. They solve it in a live remote view of that same browser on the Reconnect screen | When layer 2 meets a visible challenge | Yes, about 30 s |
| 4. Solver service (optional) | A third-party captcha-solving API behind a feature flag, off by default | Only if the portal's terms allow it and you accept the cost and the data sent to a third party | No |

**Preflight checks are the real safety net.** Before each registration the worker checks the session at T-12 h, T-30 min and T-5 min. A failure starts layers 2 and 3 straight away, so the user hears about it hours early, not after the slot is gone.

**Assisted re-login, in practice**

- Interactive captchas (reCAPTCHA v2, hCaptcha, Turnstile) are tied to the portal's domain, so they can't be copied into our page. The user has to drive the real browser.
- MVP option: a headful Chromium in Xvfb, exposed through noVNC behind our auth. Simple, but heavy.
- Better option: stream the Playwright page with CDP `Page.startScreencast` over a WebSocket and send clicks and keys back with `Input.dispatch*`. It's lighter and fits a phone screen.
- Either way, the stream opens only for the account owner, through a single-use ticket valid for 2 minutes. The browser context closes and the new session is saved as soon as login succeeds.
- A simple image captcha (distorted text) is the exception: show the image in our UI and pass the typed answer back.

**Session record per user:** encrypted `storageState`, encrypted browser profile directory (or a volume path), `expires_at` taken from cookie attributes, `last_ok_at`, `state` and `failure_count`. Back off after 3 failed silent logins so the portal doesn't lock the account.

## User access and web interface

Access is invite-only: an admin issues a token, the user exchanges it once for a short-lived web session, and every API route denies by default.

**Token lifecycle**

1. Admin creates a user in the admin panel or with a CLI command. The server generates 32 random bytes, encoded as `ar_live_<base64url>`.
2. The token is shown **once**. The database stores only its SHA-256 hash (or an HMAC with a server-side pepper), its first 8 characters for display, a label, `expires_at` and `last_used_at`.
3. The user pastes the token on the login page. The server compares hashes in constant time, then sets an `HttpOnly; Secure; SameSite=Strict` session cookie valid for about 12 hours. The token is never kept in localStorage.
4. Sessions live in the `web_sessions` table, so the admin can revoke a token and kill its sessions instantly.
5. Optional second factor later: a passkey (WebAuthn) or TOTP bound to the user after their first login.

**Authorization rules**

- A global guard (a NestJS `AuthGuard` or a FastAPI dependency) runs on every route; only `/auth/login` and `/healthz` are public.
- `user_id` always comes from the session, never from the request body or URL. Every query filters by it, which prevents one user reading another's jobs (IDOR).
- Two roles: `admin` (users, tokens, system health) and `user` (own data only).
- Login is rate-limited per IP and per token prefix, for example 5 attempts per 15 minutes, with every attempt written to the audit log.

**Screens (Vue 3 SPA, mobile-first)**

| Screen | What the user does there |
| --- | --- |
| Login | Pastes the access token once |
| Dashboard | Sees a portal connection badge (Connected / Refreshing / Needs you) and the next registrations with countdowns |
| Activities | Browses activities pulled from the portal and toggles "Auto-register" |
| Rules | Sets recurring rules, e.g. "every Tuesday 18:00, Yoga, any instructor" |
| Reconnect | Completes a portal login challenge in the remote browser view when automation fails |
| History | Sees each attempt's result, timing and error in plain words |
| Settings | Enters portal credentials (write-only), notification channel, deletes their data |
| Admin | Manages users and tokens and sees the session health of every account |

Portal credentials are **write-only** in the UI: after saving, the password is never sent back to the browser, only "saved on \<date>".

## Data model (Neon Postgres)

Eight tables plus the job queue's own schema. Every column marked *enc* is encrypted by the application before it reaches Neon.

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | id, display\_name, email, role, status, created\_at | role = admin or user |
| `access_tokens` | id, user\_id, token\_hash, prefix, label, expires\_at, last\_used\_at, revoked\_at | Only the hash is stored |
| `web_sessions` | id, user\_id, expires\_at, created\_ip, user\_agent, revoked\_at | Lets the admin revoke sessions instantly |
| `portal_accounts` | id, user\_id, login, password *enc*, wrapped\_dek, status, last\_ok\_at | One per user in v1 |
| `portal_sessions` | id, portal\_account\_id, storage\_state *enc*, expires\_at, state, failure\_count, updated\_at | State machine: ACTIVE, REFRESHING, NEEDS\_USER, FAILED |
| `registration_rules` | id, user\_id, matcher (JSON: activity, weekday, time, location), enabled | Generates jobs on its own |
| `registration_jobs` | id, user\_id, rule\_id, portal\_activity\_id, opens\_at, state, attempts, result, fired\_at, latency\_ms | UNIQUE (user\_id, portal\_activity\_id) blocks duplicates |
| `audit_log` | id, actor\_id, action, target, ip, at | Never holds secrets or portal content |

**Practical notes**

- Use a migration tool (Drizzle or Prisma for TypeScript, Alembic for Python). Never alter the schema by hand.
- Two database roles: `app_api` (no access to `portal_sessions.storage_state`) and `app_worker`. Turn on Postgres row-level security on user tables as a second line of defence.
- Use [pg-boss](https://github.com/timgit/pg-boss) as the job queue so you don't need Redis. Point it at Neon's **direct** endpoint, not the pooler, and note that a polling queue keeps the compute awake, so Neon's scale-to-zero won't save money here.
- Use a separate Neon branch for development with fake data. Never copy production credentials into it.

## Registration engine

Use plain HTTP calls for registration and a browser only for login. Copy the portal's own XHR requests with the saved session: they are about 100 times faster and cheaper than clicking through pages.

**Timeline of one job**

1. **Discovery**: an hourly job reads the portal's schedule, matches it against each user's rules, and inserts `registration_jobs` with `opens_at`. Duplicates are blocked by the unique key.
2. **Preflight** at T-12 h, T-30 min and T-5 min: check the session with a cheap authenticated request and repair it if needed (previous section).
3. **Warm-up** at T-60 s: load the session into a keep-alive HTTP agent, open the TLS connection, and fetch any CSRF token the form needs.
4. **Fire** at T: send the request from an in-process timer, not cron, which only has minute resolution. If the portal answers "not open yet", retry every 250–500 ms for up to 10 s, then stop.
5. **Settle**: on success, "full" or "already registered", save the result and notify the user. On an unclear error, check the user's bookings before any retry. Never register blind twice.

**Timing accuracy**

- Run `chrony` on the VM. Also measure the portal's clock offset from its HTTP `Date` header during warm-up and adjust the fire time by it.
- Record `latency_ms` (actual fire time minus `opens_at`) for each job. This is your main quality metric.

**Concurrency and fairness**

- Each user has their own session and is fired in parallel. Cap the worker at, say, 20 concurrent requests.
- Claim each job with `SELECT … FOR UPDATE SKIP LOCKED` (pg-boss does this), so two workers never fire the same job.
- Keep retries small and bounded. Hammering the portal is the quickest way to get the fixed IP blocked for everyone.

**Code structure (porting the MVP)**

- `portal-client`: a typed wrapper around the portal's endpoints (login check, list activities, register, my bookings). It's the only module that knows portal URLs and selectors.
- `session-manager`: keep-alive, silent login, assisted login, and the state machine.
- `scheduler`: discovery, preflight, warm-up and fire.
- `notifier`: email, Telegram or web push.
- One shared package, two entrypoints: `api` and `worker`.

## Scheduling: from configuration to the exact second

Use a two-stage scheduler. Postgres holds every job and its `opens_at` until 10 minutes before it is due. An arming loop then hands the job to a precise in-memory timer. Nothing busy-waits for more than the last \~20 ms.

&#91;embedded content: registration job lifecycle · Postgres to timer to result\]

Only the ARMED stage lives in memory, and its database lease means a crash puts the job back in the queue rather than losing it.

**Why the active wait has to go.** It keeps a CPU core busy for hours and handles one job per process. It also loses everything on a crash, restart or deploy. One crash between configuration and opening time means a missed registration with no record of it.

**Computing `opens_at`**

- Store the activity start as `timestamptz` together with the portal's time zone (for example `Europe/Warsaw`). Run the VM in UTC and never use the server's local time.
- "Two full days before" is ambiguous on a DST weekend. 48 elapsed hours and "the same clock time two days earlier" differ by one hour there. Check which one the portal uses, put the rule in one tested function, and use Luxon or date-fns-tz for the math.
- Recompute it when the user edits the job, or when discovery sees the portal move the activity.
- Show the result in the UI right away ("Registration fires Mon 18:00:00"). If `opens_at` has already passed, say so at configuration time.

**Options compared**

| Option | Survives restart | Timing precision | Extra infrastructure | Use it for |
| --- | --- | --- | --- | --- |
| Active wait or one long `setTimeout` | No | Milliseconds | None | Only the final seconds |
| Cron (node-cron, Cloud Scheduler) | Cloud Scheduler only | 1 minute | None or GCP | Periodic work: discovery, keep-alive |
| pg-boss `startAfter` | Yes | Seconds (polling) | None, runs on Neon | Preflight checks and periodic jobs |
| BullMQ delayed jobs | Yes | Milliseconds to tens of ms | Redis | Works, but adds Redis for little gain |
| Cloud Tasks with a schedule time | Yes | Seconds, not guaranteed | An HTTP endpoint, GCP | Arming at most |
| Temporal.io workflows | Yes | Seconds | A Temporal cluster | Too much for one VM |

**Recommended flow**

1. **Configure**: the API inserts a `registration_jobs` row with `opens_at`, state `SCHEDULED`. The unique key (user\_id, activity\_id) blocks duplicates.
2. **Preflight**: pg-boss jobs with `startAfter` at T-12 h and T-30 min check and repair the portal session.
3. **Arm**: every 30 s the worker claims jobs due within 10 minutes with `UPDATE … SET state='ARMED', worker_id=$1, lease_until=now()+'15 min' WHERE id IN (SELECT id … WHERE state='SCHEDULED' AND opens_at < now()+'10 min' FOR UPDATE SKIP LOCKED) RETURNING *`. Each claimed job gets an in-memory timer.
4. **Warm up** at T-60 s: decrypt the session, open the TLS connection, fetch the CSRF token, and build the request object.
5. **Fire**: a `setTimeout` until T-2 s, then short timeouts that re-check a `performance.now()` target, then a spin for the last \~20 ms. Adjust T for the portal's measured clock offset. If the portal answers "not open yet", retry every 150–300 ms for up to 10 s.
6. **Settle**: write DONE, FULL or FAILED with `latency_ms`, release the lease, and notify the user.

**Restarts and deploys**

- On boot, the worker moves `ARMED` jobs with an expired lease back to `SCHEDULED`, and the next arming pass picks them up.
- If a job is found up to 2 minutes past T, fire it once anyway and mark it late, because the slot may still be free. Past that, mark it `MISSED` and notify the user.
- Graceful shutdown: on SIGTERM the worker stops arming and settles its armed jobs before it exits. Set Docker's `stop_grace_period` long enough for that, and block deploys within 10 minutes of an armed job.
- Arming only 10 minutes ahead also avoids Node's `setTimeout` cap of about 24.8 days (2^31−1 ms).

**Precision hygiene**

- Run the firing worker as its own process, separate from Playwright logins, so a browser job can't block the event loop at T. Watch event-loop delay with `perf_hooks.monitorEventLoopDelay`.
- Run `chrony` on the VM. The portal's `Date` header has 1-second resolution, so estimate its offset from several samples around a second boundary, and refine it from the logged moment the portal switched from "not open" to "open".
- Several users with the same T are all armed in one process and fired together with `Promise.all`.

## Security and data-leak prevention

The most valuable data you hold is other people's portal passwords and live sessions. The core rule: the internet-facing API can **encrypt** them but can't **decrypt** them. Only the worker can.

**Secrets and encryption**

- Envelope encryption: each secret gets its own data key (AES-256-GCM). That data key is wrapped by one [Cloud KMS](https://cloud.google.com/kms/docs/envelope-encryption) key and stored next to the ciphertext.
- Two service accounts. The API account has only `cloudkms.cryptoKeyEncrypter`. The worker account has `cloudkms.cryptoKeyDecrypter`. A compromised API still leaks no passwords.
- The Neon connection string, session-signing key and token pepper are kept in Secret Manager and read at startup. Never put them in `.env` files in the repo, the Docker image or VM metadata.
- Encrypt browser profile directories at rest (an encrypted disk or a per-user tarball sealed with the same scheme) and delete them when the user is deleted.

**Network and VM**

- Firewall: only 443 is open to the internet. SSH goes through [IAP TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding) only, never a public port 22.
- TLS terminates at Caddy (automatic certificates) or at a Google HTTPS load balancer with Cloud Armor rate limits.
- Use a Shielded VM with automatic security updates. Don't use the default compute service account with Editor rights.
- Neon: `sslmode=verify-full`, a separate role per service, and an IP allowlist for the VM's static IP if your plan has it.

**Containers**

- Run as non-root with a read-only root filesystem and all capabilities dropped. Pin image versions and scan them in CI.
- Keep Chromium's sandbox on. Don't use `--no-sandbox`: run the browser as a non-root user with a seccomp profile.
- Give each user a separate browser context, so no cookies or storage are shared between them.

**Application**

- Sessions use HttpOnly, Secure, SameSite=Strict cookies. Add a CSRF token on state-changing routes, restrict CORS to the same origin, and set a strict CSP and security headers (Helmet).
- Validate every input (zod or class-validator, or Pydantic). Use the ORM or parameterized SQL only.
- Write tests that try to read another user's jobs, sessions and history, and expect a 404.

**Logs and debugging artifacts**

- The logger redacts cookies, `Authorization`, passwords, tokens and `storageState` by key, and logs only allowlisted fields.
- Never log full portal responses, which contain names and booking data.
- Playwright traces, screenshots and HAR files hold live cookies. Keep them off in production. If you turn them on for debugging, encrypt them and delete them within 24 h.

**Data minimization**

- Keep job history for 90 days, then delete it. A "Delete my data" button wipes credentials, sessions, profile and history at once.
- Show a short privacy note at onboarding: what is stored, why, and how to delete it. You are holding third-party credentials, so GDPR consent matters.

## Reliability and observability

The two things that will break are the portal changing its pages and sessions dying. Watch both and alert before users notice.

- **Portal contract check**: a daily smoke test runs one test account through login check, activity list and bookings. A changed selector or endpoint alerts you the same day, not at the next registration.
- **Metrics to track**: share of accounts with an ACTIVE session, registration success rate, fire latency (p50 and p95), how often silent login hits a challenge, and queue lag.
- **Alerts**: a Cloud Monitoring uptime check on `/healthz`, the admin notified when the worker heartbeat is older than 2 min, and the user notified when their account enters `NEEDS_USER`.
- **Logging**: structured JSON to Cloud Logging, with a `job_id` and `user_id` on every line so one registration can be traced end to end.
- **Recovery**: all state is in Postgres, so a restarted worker reloads pending jobs and timers on boot. Use `restart: unless-stopped` and health checks in Docker Compose.
- **Testing**: build a small mock portal server (Express or FastAPI) that copies login, captcha and registration responses. It's used in CI for end-to-end tests without touching the real portal.

## Implementation phases

About 4–6 weeks part-time. Each phase ends with something that runs.

1. **Recon and MVP review** (2–3 days): map the login flow, captcha type, session lifetime and registration endpoints with DevTools; read the terms of service; review the MVP script.
2. **Backend skeleton**: monorepo, Neon schema and migrations, token auth, admin CLI to issue and revoke tokens, `AuthGuard`, audit log.
3. **Worker core**: port the MVP into `portal-client`, add pg-boss jobs, and build discovery, warm-up and precise firing against the mock portal.
4. **Session manager**: persistent profiles, keep-alive, silent re-login, preflight checks and the session state machine.
5. **Web UI**: login, dashboard with connection badge, activities, rules, history and settings.
6. **Assisted re-login**: Reconnect screen with a CDP screencast (or noVNC first), single-use tickets and notifications.
7. **Hardening and deploy**: KMS envelope encryption, Secret Manager, firewall and IAP, non-root containers, CI with image scanning, monitoring and alerts.
8. **Beta**: 2–3 trusted users for two weeks; watch fire latency and challenge rate; then invite the rest.

**Suggested stack**: TypeScript end to end, since the MVP is already JavaScript. NestJS for the API and worker, Playwright, pg-boss, Drizzle, Vue 3 with Vite, and Docker Compose on one GCE VM (e2-medium is enough for Chromium). FastAPI also works if you'd rather use Python for the backend.

## Open questions and MVP review

The answers to these change the design, mostly in the session section.

- [ ] Which captcha is on the login page: reCAPTCHA v2 or v3, hCaptcha, Turnstile, or a simple image? Does it show every time or only on risk?
- [ ] How long does a portal session last: idle timeout, absolute lifetime, and is there a "remember me" option or a refresh token?
- [ ] Is the session tied to IP or user agent? Does refresh break after the VM restarts or its IP changes?
- [ ] When does registration open, and how quickly do popular slots fill: minutes or seconds?
- [ ] How many users, all on the same portal and the same club or location?
- [ ] What do the portal's terms say about automated access?

**What to check in the MVP script once you share it**

- How cookies are saved and refreshed, and exactly which response fails when the refresh breaks.
- Whether rotated cookies or CSRF tokens from responses are saved back.
- Hardcoded credentials, tokens or URLs.
- Error handling and retries around the registration call, and how double registration is avoided.
