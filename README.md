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
├── public/                    # Static UI & front-end assets
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
```

### 3. Run Dev Server
```bash
npm run dev
```

### 4. Run Tests
```bash
npm run test
```

