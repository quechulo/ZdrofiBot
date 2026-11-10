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

## Layout

| Path | Purpose |
| --- | --- |
| `apps/api` | HTTP API |
| `apps/fire-worker` | Fires registrations. Must never depend on Playwright |
| `apps/session-worker` | Discovery, keep-alive, logins and alerts |
| `libs/portal` | The only code that knows the portal's URLs and markup |
| `libs/scheduling` | Opening times and job states |
| `libs/db` | Schema and migrations |
| `test/mock-portal` | Fake portal for tests, rendering real markup from `fixtures/` |
| `recon/` | Throwaway probes. See `recon/README.md` |

Regenerate fixtures with `node recon/make-fixtures.mjs`. It fails if anything personal or a real token gets through.
