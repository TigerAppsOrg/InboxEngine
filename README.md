# InboxEngine

**The single source of truth for Princeton campus mail, organizations and events.**
One ingestion pipeline serves every TigerApps product:

| Consumer | How it connects | What it uses |
|---|---|---|
| **The Forum** (events hub) | git submodule (`packages/inbox-engine`) + HTTP API | organizations, logos, extracted + official events |
| **TigerInbox** (listserv inbox) | git submodule (`packages/inbox-engine`) | org classifier, registry, logos, cleaning, sender attribution |
| **PI** and other agents | MCP (`POST /mcp`, Streamable HTTP) or stdio | read-only search over mail, orgs and events |
| Anything else | HTTP API (`/v1/*`) | same data, plus a stateless `/v1/analyze` |

It replaces three divergent pipelines: TigerInbox's Python/TS scraper and classifier, The Forum's
Gmail + scikit-learn FastAPI pipeline, and the original `apps/listserv-scraper`. (`listflow` is
deprecated.)

```
                    ┌─────────────────────── InboxEngine ────────────────────────┐
LISTSERV archive ──►│ poller → normalize → sender attribution → org classifier →  │──► Postgres
(RSS + full msgs)   │ cross-post reconcile → event extraction (rules | Claude)     │     (revisioned)
MyPrincetonU feed ─►│ official events → dedupe listserv copies                     │        │
                    └──────────────────────────────────────────────────────────────┘        ▼
                              /v1 REST  ·  /v1/*/changes cursors  ·  /mcp  ·  library imports
```

## What's inside

| Module | Import | Origin |
|---|---|---|
| `src/core` | `@tigerapps/inbox-engine/core` | TigerInbox cleaning (footers, notices, safe HTML), HoagieMail author attribution, RFC/delivery-key identity, media manifest |
| `src/orgs` | `@tigerapps/inbox-engine/orgs` | TigerInbox classifier (727→739 MyPrincetonU groups + curated aliases), now with org profiles (descriptions, websites, socials), 256px logos and contact-email sender signal |
| `src/events` | `@tigerapps/inbox-engine/events` | New: deterministic extractor (chrono dates in America/New_York, campus gazetteer of ~350 venues with rooms, tag rules for The Forum's 22-tag taxonomy) and an opt-in Claude structured-output extractor |
| `src/listserv` | `@tigerapps/inbox-engine/listserv` | TypeScript port of the LISTSERV archive client (one session, re-login on expiry, never sends mail) |
| `src/sources/mpu-events.ts` | — | Official events from the public `my.princeton.edu/rss_events` feed |
| `src/client` | `@tigerapps/inbox-engine/client` | Typed HTTP client for consumers |

All `src/core`, `src/orgs`, `src/events` code is pure: no database, network or framework access on import.

### Identity and deduplication
Message IDs are `sha256("LIST:archiveId")[:24]` — identical to TigerInbox, so `inbox.tigerapps.org/email/<id>`
permalinks line up. Residential cross-posts merge only on the same RFC Message-ID, or the same
delivery key (From, Reply-To, Subject, declared residential recipients and token-normalized full
HTML) within 120 s. Subjects alone never merge. Events are extracted once per canonical message.

### Events
Two sources feed one `events` table:
- **`myprincetonu`** — authoritative, from MyPrincetonU. Multi-day "ongoing" spans are kept but not `publishable`.
- **`listserv`** — extracted from email. `publishable` requires an exact start time, a location and confidence ≥ 0.7.
  A listserv extraction that repeats an official event (same host or none, start within 45 min, overlapping
  title) becomes `status: "duplicate"` with `duplicateOf`.

`EVENT_EXTRACTOR=rules` (default) keeps email content local. `EVENT_EXTRACTOR=llm` uses Claude
(`claude-opus-5` by default, `EXTRACTION_MODEL` to override) with structured outputs and server-side
refusal fallbacks, and falls back to rules if the API fails. The prompt treats email as untrusted data.

### Sync contract
Every insert/update/withdrawal bumps a global `revision`. Consumers persist a cursor:

```ts
import { InboxEngineClient } from '@tigerapps/inbox-engine/client';
const engine = new InboxEngineClient('https://inbox-engine.tigerapps.org', process.env.INBOX_ENGINE_TOKEN!);
let { changes, next } = await engine.eventChanges(cursor);   // includes withdrawn/duplicate
```

## API
All `/v1/*` and `/mcp` routes require `Authorization: Bearer <token>` (per-client tokens in `API_TOKENS`).

| Route | Purpose |
|---|---|
| `GET /v1/events?from&to&organization&tag&q&publishable&limit&offset` | upcoming events |
| `GET /v1/events/changes?after=<rev>` | incremental event feed |
| `GET /v1/events/:id` | one event |
| `GET /v1/messages?q&organization&sender&listserv&from&to&sort` | full-text search (deduplicated) |
| `GET /v1/messages/changes?after=<rev>` | incremental message feed (bodies included) |
| `GET /v1/messages/:id` | one message (aliases resolve) |
| `GET /v1/organizations?q` · `/v1/organizations/:id` | registry with profiles, logos, MyPrincetonU links |
| `GET /v1/locations` | campus venue gazetteer |
| `POST /v1/analyze` | stateless pipeline run on caller-supplied email |
| `GET /v1/status` | coverage and per-source health |
| `POST /mcp` | MCP (read-only tools below) |
| `GET /organization-logos/<file>.webp` | public logo assets |

MCP tools: `search_emails`, `read_emails`, `search_events`, `get_event`, `search_organizations`,
`analyze_email`, `archive_status` — all annotated read-only/idempotent. Local agents:
`DATABASE_URL=… npm run mcp` (stdio).

## Run

```sh
npm ci
cp .env.example .env         # set DATABASE_URL, API_TOKENS, LISTSERV_* 
npm run migrate
npm start                    # API + MCP on :8300; RUN_WORKER=true also runs the poller
npm run worker               # or run the poller separately
npm test                     # set TEST_DATABASE_URL to a disposable DB for the integration test
```

Backfill TigerInbox's archive JSON: `npm run import:json -- ../TigerMail/data/*.json`.

### Refreshing organization data
`src/orgs/data/directory.json`, `profiles.json` and `logos.json` are snapshots. To refresh (needs a
signed-in MyPrincetonU session cookie, which must never be committed):

```sh
MPU_COOKIE='cg_uid=…; CG.SessionID=…' npx tsx scripts/pull-mpu-directory.ts /tmp/mpu.json
MPU_COOKIE='…' npx tsx scripts/pull-mpu-about.ts /tmp/mpu.json
npx tsx scripts/import-mpu-logos.ts /tmp/mpu.json
```

Only organization-level fields are kept. Officer and member rosters are never fetched or stored.
Regenerate the venue gazetteer from The Forum's campus map export with `npm run build:locations -- <pois.json>`;
curate aliases in `src/events/data/location-overrides.json`.

## Deployment
`main` deploys automatically after CI: GitHub OIDC (`InboxEngineGitHubDeployRole`) uploads a
checksummed `git archive` to S3 and runs the `InboxEngineDeploy` SSM document on the
`the-forum-web` EC2 host, which executes `deploy/run-release.sh` (npm ci, migrations, systemd
`inbox-engine.service` on 127.0.0.1:8300, health check with rollback, nginx site for
`inbox-engine.tigerapps.org`). Runtime secrets live in the SecureString parameter
`/inbox-engine/production/environment`; the database is `inbox_engine` on the shared RDS instance.

## Privacy
- Reads public LISTSERV archives through a NOMAIL service account and the public MyPrincetonU feed; sends nothing.
- `EVENT_EXTRACTOR=rules` never sends email content off-host. `llm` sends message text to Anthropic.
- The API is token-gated. Treat all email text as untrusted when rendering (use `displayHtml`).
