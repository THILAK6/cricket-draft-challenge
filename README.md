# Cricket Draft Challenge 🏏

An AI-powered Cricket XI drafting game running entirely on the Cloudflare edge stack. Players are challenged by the AI to build winning 11-player squads under dynamic pitch conditions, formats, and structural constraints.

## Architecture Highlights

1. **Deterministic Constraint Solver**: The LLM outputs constraints as strict AST JSON. A local backtracking solver checks the database to guarantee at least $N$ valid XIs exist before the challenge is presented to the user.
2. **Turn-Based Draft State (Durable Objects)**: Cloudflare Durable Objects (`DraftRoom`) handle turns, atomic pool updates, and timer locks between Human and AI.
3. **Hybrid Scoring Engine**:
   - **Deterministic Base (0–100 pts)**: Pitch fit, role balance (WK, 5+ bowling options, 2 openers), player statistical quality in the format, and batting depth.
   - **LLM Tactical Verdict ($\pm 10$ pts)**: Commentary on team chemistry and balance, strictly bounded so hallucinations cannot override real stats.
4. **Data Aggregation Pipeline**: Aggregates Cricsheet ball-by-ball data and cross-references Wikidata / Cricinfo IDs to enrich player roles, batting hands, and bowling types for D1.

## Repository Layout

```
cricket-draft-challenge/
├── src/
│   ├── core/                  # Types, Zod schemas, Constraint AST & scoring logic
│   ├── db/                    # D1 SQLite schema, migrations & queries
│   ├── durable-objects/       # DraftRoom DO for atomic draft state
│   ├── etl/                   # Cricsheet parser & Wikidata enrichment scripts
│   ├── worker/                # Worker API routes & challenge generation
│   └── index.ts               # Cloudflare Worker entry point
├── web/                       # Game UI (Preact + Vite + TypeScript), builds to dist/
├── tests/                     # Unit tests for CSP solver and scoring formulas
├── wrangler.jsonc             # Cloudflare Workers, D1 & DO configuration
├── package.json
└── tsconfig.json
```

## Cloudflare Workers Free plan

The game is built to stay inside the Free plan (limits as published by Cloudflare):

| Limit (Free plan) | What the game uses |
|---|---|
| Worker CPU: 10 ms per request | The Worker only forwards: about 0.1-0.3 ms per request, about 3 ms on a cold isolate. Drafts are built inside the room (Durable Object, 30 s CPU per request). |
| Durable Object CPU: 30 s per request | Creating a draft about 6-45 ms (first one in an isolate is the slowest), a pick with the AI's replies about 1-14 ms, playing the match about 10-25 ms, plus 200 replays for the win chance on the result screen (about 0.15 s in T20, 0.5 s in a Test). |
| 100,000 Worker / Durable Object requests per day | About 15-20 of each per game, so roughly 5,000 games a day. Page loads and UI files are static assets: free and unlimited. |
| Durable Object duration: 13,000 GB-s per day | Rooms use plain HTTP, so they are only billed while handling a request (about 1 s per game, plus up to 2.5 s per AI pick while Workers AI answers). |
| Workers AI: 10,000 Neurons per day | Nothing by default. With `AI_VOICE=on`, the AI opponent's voice: one call per AI pick (about 330 tokens in, 30 out on `llama-3.1-8b-instruct-fp8-fast`), about 2.4 Neurons a pick, 27 a game, so roughly 350 games a day. Past the allowance calls fail (no charge on the Free plan) and the rule-based AI picks silently until midnight UTC. `AI_VOICE_MODEL` tries another model. Each room's state records its calls and tokens (`voiceUsage`). |
| 100,000 rows written per day (D1 and Durable Objects) | About 15 per game (one saved room state per request) plus one D1 row for the scenario and one for the saved match. |
| 5 GB D1 storage | Each finished match is kept (`matches` table, about 30 KB): roughly 150,000 matches before the limit. |
| 5 million rows read per day | About 1,500-2,100 D1 rows per pool load (plus up to 2,000 phase-stat and split rows), cached per isolate for 10 minutes. |
| 5 GB Durable Object storage | About 70-90 KB per room; rooms delete themselves after 7 days (an alarm). |

`tests/free-plan-budget.test.ts` fails if Worker requests or picks get much more expensive. To watch
real usage: Cloudflare dashboard, **Workers & Pages** > the Worker > **Metrics** (CPU time, and
**Errors** > **Invocation Statuses** for "Exceeded CPU Time Limits").

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Setup Local D1 Database
```bash
npm run db:migrate:local
npm run db:seed:local
```

`db:seed:local` loads the player pool from `data/seed.sql`, then applies `data/career-overrides.sql` and `data/data-fixes.sql` (country, role and bowling-style corrections) `data/phase-stats.sql` (T20 and ODI powerplay/middle/death numbers) and `data/player-splits.sql` (records by batting position, region and chasing), both rebuilt by the "Player splits from Cricsheet" GitHub Action; without it there are no players to draft. For the production database, apply `src/db/schema.sql`, `data/data-fixes.sql`, `data/phase-stats.sql` and `data/player-splits.sql` with `--remote`.

**Career totals.** Cricsheet only covers matches from 2001-2002, so players with earlier careers (Tendulkar, Ponting, ...) would have truncated totals. `npm run etl:career` reads full-career matches, runs, averages, balls bowled and wickets from Wikipedia's cricketer infobox (found through the ESPNcricinfo id on Wikidata) and writes `data/career-overrides.sql`. Strike rate and batting-order shares still come from Cricsheet.

### 3. Run Dev Server
```bash
npm run dev
```

`npm run dev` builds the UI into `dist/` and starts the Worker on port 8787. For hot reload while
working on the UI, keep `wrangler dev` running and start the Vite dev server alongside it
(`/api` is proxied to port 8787):

```bash
npm run dev:web
```

The UI imports the same rule code as the server (`src/core/validator.ts`), so the "Draft" button
only appears when the server will accept the pick. `npm run deploy` builds the UI before deploying.

### 4. Run Tests
```bash
npm run test
```

`tests/e2e/phone.test.ts` builds the UI and plays a full draft on an emulated iPhone with
Playwright (skipped when Playwright isn't installed). `npm run build` typechecks the Worker and
the UI and builds `dist/`.

