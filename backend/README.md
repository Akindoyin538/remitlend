# Backend

Node.js service for the lending platform. It exposes the REST API, runs database
migrations, and hosts the scheduled jobs.

## Supported toolchain

| Tool | Supported version |
| --- | --- |
| Node.js | 20.x LTS (18.x works, 22.x untested) |
| npm | 10.x (ships with Node 20) |
| PostgreSQL | 15.x or 16.x |
| Docker | 24.x+ (only needed for the container workflow) |

If `node --version` reports anything older than 18, install Node 20 LTS before
continuing. The scripts below assume `npm`; `yarn` and `pnpm` are not supported.

## Clean-checkout quick start

These are the exact commands a fresh clone needs. They are executed on every
pull request by `.github/workflows/verify-contributor-setup.yml`, so if a step
here drifts from `package.json` the workflow fails and points at this section.

```bash
# 1. Install dependencies (uses the committed lockfile)
npm ci

# 2. Create your local environment file from the checked-in example
cp .env.example .env

# 3. Run database migrations
npm run migrate

# 4. Seed development data
npm run seed

# 5. Run the focused test suite
npm test
```

Every script referenced above (`migrate`, `seed`, `test`) must exist in
`package.json`. The verification workflow parses this file and fails with the
section name and the missing script if one is renamed or removed.

## Environment variables

Copy `.env.example` to `.env` and fill in local values. The verification
workflow checks that every variable documented here also appears in
`.env.example`, so add new variables to both places.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string, e.g. `postgres://user:pass@localhost:5432/lending` |
| `PORT` | no | HTTP port, defaults to `3000` |
| `NODE_ENV` | no | `development`, `test`, or `production` |
| `JWT_SECRET` | yes | Signing key for session tokens; use any local-only value |

Never commit real credentials. The workflow only uses throwaway local values and
performs no external or value-bearing transactions.

## Container workflow

```bash
docker compose up --build
```

This starts PostgreSQL and the API together. Run the migration and seed steps
from inside the API container if you use this path instead of a local database.

## Troubleshooting

**`npm ci` fails with `EUSAGE` or lockfile errors.**
Your `package-lock.json` is out of sync or you are on the wrong Node version.
Run `node --version` and confirm 20.x, then `git checkout package-lock.json` and
retry. Do not run `npm install` to "fix" it — that rewrites the lockfile.

**`npm run migrate` cannot reach the database.**
PostgreSQL is not running or `DATABASE_URL` is wrong. Start it with
`docker compose up -d db`, then verify the host/port in `.env` match the
container. On macOS with Homebrew, `brew services start postgresql@16`.

**`npm run seed` fails with duplicate key errors.**
The database already contains seeded rows. Reset it with
`npm run migrate:reset` (development only) and run `npm run seed` again.

**`npm test` fails on a fresh checkout but passes locally.**
You likely have stale build output or a dirty `.env`. Remove `node_modules` and
`.env`, then repeat the quick start from step 1. Tests must pass without any
network access or external services.

**A documented command no longer exists.**
The verification workflow reports the file, section, and missing script. Update
this README and `package.json` together in the same pull request.
