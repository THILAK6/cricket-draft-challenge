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

`db:seed:local` loads the player pool from `data/seed.sql`, then applies `data/career-overrides.sql` and `data/data-fixes.sql` (country and per-format role corrections); without it there are no players to draft. For the production database, apply `src/db/schema.sql` and `data/data-fixes.sql` with `--remote`.

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

