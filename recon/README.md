# Portal recon

Short-lived probes that answer the recon questions in the implementation plan. They run against your own account. Delete this folder after cutover.

## Safety

- Stop the MVP first, so two logins don't interfere with each other.
- `recon/.out/` is gitignored and holds live session data and browser profiles. Never share `state-*`, `profile-*` or `pages/`.
- The `*.jsonl` files hold fingerprints instead of values. Those are the results to share.
- Only `book-probe.mjs` changes anything on the portal, and it needs `--i-will-cancel`.
- Cancel any test booking at least 2 hours before class. Three no-shows in 21 days block online booking for 7 days.
- Run long probes under `caffeinate -i`, or a sleeping laptop will look like a session timeout.

## Already answered

Taken from one anonymous request to the public schedule on 2026-11-06.

| # | Result |
| --- | --- |
| R7 | Plain HTTP returns the whole schedule with no login: 124 classes over 8 days, with `data-full`, seats taken and capacity. Discovery needs no browser and no session |
| R2 | The login form has no remember-me field. Fields: `email`, `password`, `recaptcharesponse`, `_token`, `_redirect`, `submit` |
| R3 | Visible "I'm not a robot" checkbox (reCAPTCHA v2). It's still unknown how often an image challenge follows |
| R1 (partly) | Polled every 5 min, a session stayed alive for at least 343 min with no cookie changes |
| R3 (partly) | `api2/anchor` with `size=normal` confirms the checkbox. 1 of 2 logins appeared to show an image challenge |
| R6 (partly) | `/moje-konto/` and `/moje-konto/profil` exist |
| R4 (partly) | A not-open class page has no form or token, and an open one does. The token is re-masked per load, but the value underneath stays the same within a session. Compare `tokenCoreFp`, not `tokenFp` |
| R4 (open classes) | The token core matched across 4 classes, and a real POST with another class's token booked. POST took 5.6 s |
| R1 update | Valid after 10h35m, including 2h54m idle |
| R6 update | Cancel is a separate form: `schedule_unregister_form` on `/kluby-fitness/<club>/grafik-zajec/<id>/zapisz`, posting to `/grafik-zajec/<id>/wypisz` with its own token |
| Booking state | A session's class page can lag by up to about 12 min after a change made elsewhere. Its own POST shows at once |
| Sessions | A new web login doesn't end an existing session. Tokens are per session and per form |
| Idle expiry | Session `a` died after at most about 4 days idle. A logged-out page still offers a token, so `book-probe` now refuses to POST unless logged in |
| R8 (partly) | The site sits behind CloudFront. Requests take 0.75–1.25 s, nearly all server time. A cold DNS lookup can add about 3 s on this Mac |

## Your runbook

Use `warszawa-zoliborz-szamocka` as `<club>`.

**1. Session lifetime (R1), the deciding test.** Log in, and tick the checkbox by hand.

```sh
node recon/login.mjs a
node recon/account-map.mjs a        # R6, while the session is alive
caffeinate -i node recon/session-watch.mjs a --every 5
```

It stops when the session dies and prints `lifetimeMinBetween`.

Then repeat with sessions nobody touches, one at a time, since a new login might end the previous one:

```sh
node recon/login.mjs b && caffeinate -i node recon/session-watch.mjs b --at 60
node recon/login.mjs c && caffeinate -i node recon/session-watch.mjs c --at 120
```

| Polled (`a`) | Untouched (`b`, `c`) | Meaning |
| --- | --- | --- |
| Dies near 70 min | Dead by 120 min | Absolute lifetime |
| Lives for hours | Dead at 60 or 120 min | Idle timeout, so keep-alive works |
| Lives for hours | Alive at 120 min | Long lifetime. The Oct 26 death was probably the lost POST response |

**2. Token before opening (R4).** Log in fresh, then list classes:

```sh
node recon/schedule-probe.mjs --club <club> --list
node recon/token-probe.mjs a --club <club> --id <not-open id> --id <open id>
```

To see the moment the form appears, start this a few minutes before a class opens, with a session under an hour old:

```sh
node recon/token-probe.mjs a --club <club> --id <id> --around 2026-11-08T18:00:00+01:00
```

**3. Response shapes and cross-class token (R4, R5).** These make real bookings, so pick classes you can cancel, and don't use one you're relying on:

```sh
node recon/book-probe.mjs a --club <club> --id <open id> --i-will-cancel
node recon/book-probe.mjs a --club <club> --id <open id 2> --token-from <open id 3> --i-will-cancel
```

Each booking also logs cookie changes and re-checks the session, including after a POST that times out, to test what ended the Oct 26 session. If the session survives that check, run `session-watch` afterwards to see whether it dies later.

A class with an open form tests the token. The last command shows whether a token from one class works on another, which decides whether we can fire a single POST at T. Repeat on a full class and an already booked class if you can.

**4. Share the results.** Send the contents of `recon/.out/*.jsonl`.

## Google Cloud test (R8)

This checks whether the portal treats a Warsaw datacenter IP differently from your home connection. It costs a few cents an hour until you run `down.sh`, and needs billing enabled on the project.

```sh
sh recon/gce/up.sh <gcp-project>
```

It prints an SSH command. Run that, then on the VM:

```sh
sh recon/timing-probe.sh
node recon/schedule-probe.mjs --club warszawa-zoliborz-szamocka --repeat 5
sh recon/gce/vm-login.sh gce
```

The last command shows a login browser at <http://localhost:6080/vnc.html> on your Mac. Log in by hand, and note whether an image challenge appears and how many rounds it takes. You're typing your password into the temporary VM, so run `down.sh` when you're done. Then:

```sh
node recon/token-probe.mjs gce --club warszawa-zoliborz-szamocka --id <open id>
timeout 2h node recon/session-watch.mjs gce --every 15
```

Print the results on the VM with `cat recon/.out/*.jsonl`, and paste them here. They hold fingerprints, not cookie values. Then, back on your Mac:

```sh
sh recon/gce/down.sh <gcp-project>
```
