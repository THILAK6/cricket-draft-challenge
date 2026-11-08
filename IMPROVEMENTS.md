# Making the draft feel like the real thing

The goal: drafting against the AI should feel like the school game with a friend. Picks alternate
and are final, the big names go early, and at the end you argue position by position about whose
XI is better. The match result should reward the side that drafted better.

Items are grouped into phases and listed in the order they will be built. Tick each box when it is done.

---

## Phase 1 — Draft rules (make every pick count)

- [x] **1.1 Picks are final.** Remove the "remove player" action during the draft, and stop a pick
  into an occupied slot from swapping the old player back into the pool. After the draft, only the
  batting order can change (reorder stays).
  _Today:_ `/remove` returns a player to the pool at any time, and once the AI has 11 you can swap
  with the leftovers forever (`src/durable-objects/DraftRoom.ts`).
- [x] **1.2 Toss for first pick.** A coin toss decides who picks first, and the draft screen shows the result.
- [x] **1.3 Snake draft order.** The order is 1-2-2-2…-1, so the side that picks first doesn't get
  the better player in every round. The AI may make two picks in a row, and the UI must show both.
- [x] **1.4 Pick now, set the order later.** You choose a player, not a batting slot. The batting
  order is arranged once after the draft (the AI suggests an order you can change).
- [x] **1.5 Fewer hard rules.** Keep these as hard rules: 11 players, at least 1 keeper, at least 5
  bowling options. Batting-hand slot rules, strike-rate/economy minimums and slot-role locks become
  scoring nudges or are dropped. Keep at most one scenario twist (for example a country cap or "2 spinners").
- [x] **1.6 No "protect the opponent" block.** Stop refusing a pick because it hurts the other side
  (`validator.ts`, "would leave your opponent unable to complete…"). Instead, build each pool so both
  XIs can always be completed: enough keepers and bowlers for two sides plus spares.
- [x] **1.7 Bigger pool.** 40–44 players instead of 30, so the last picks are still real choices.

## Phase 1b — Mobile-first UI (built together with Phase 1)

Found by playing a full T20 draft on an emulated iPhone 13 (390 × 664 viewport).

- [x] **U.1 Fix the "+ Draft" button that lies.** The pool offered "+ Draft" on a player and then
  refused the pick ("Must pick a PACE player"), leaving the squad stuck at 10/11 until a different
  player was tried. The button must only appear when the server will accept the pick: one legality
  check, used by both the pool and the server.
- [x] **U.2 Compact player list.** Each pool card is about 133px tall, and the search box, filters and
  tips take about 40% of the screen, so only about 2½ players are visible and the 30-player pool is
  about 7 screens of scrolling. Use one row per player (name, country, role icon, the 2 stats that
  matter in this format), so 8–10 players fit on screen. Tapping a row opens a bottom sheet with the
  full stats and a "Draft" button.
- [x] **U.3 Sort and filter that fit.** One sticky row: search icon, role filter chips that scroll
  sideways, and a sort control (rating, batting, bowling, caps).
- [x] **U.4 Drop the "AI COUNTER-SNIPE!" pop-up.** It needs a tap after every AI pick (20 taps to make
  11 picks). Show the AI's pick as a short banner or ticker that doesn't block the screen, with the
  banter line when Phase 4 is on.
- [x] **U.5 Draft board.** A round-by-round pick log for both sides (the "list on paper" from school),
  plus need chips for each XI (Keeper ✓, Pace 2/3, Spin 0/1, Bowlers 4/5).
- [x] **U.6 One toast at a time.** Two toasts currently stack over the content above the tab bar.
- [x] **U.7 Your XI screen.** Rows are tall, with ▲▼ and × buttons on every player. Use a compact
  list during the draft, and a single "set batting order" step at the end (ties to 1.4).
- [x] **U.8 Pre-match screen.** Put the bowling plan (new ball, death bowler) in a simple bottom sheet
  with sensible defaults, and make "Play match" the main action.
- [x] **U.9 Result screen on mobile.** A sticky scoreline, collapsible sections, and scorecards closed by
  default (the layout itself is Phase 6).
- [x] **U.10 Plain language.** Replace jargon such as "selection points", "Venue & conditions
  telemetry" and "AI COUNTER-SNIPE!" with cricket language.
- [x] **U.11 Phone test in CI.** A Playwright test at 390px wide checks there is no horizontal scroll,
  and that a full draft can be finished with draft taps only (no refused picks, no pop-ups to dismiss).

## Phase 2 — Player pool and ratings

- [x] **2.1 Pool by stature, not caps.** "Top players" are chosen by a quality/peak rating, not by
  most matches, so the pool has recognisable stars.
- [x] **2.2 Fix rating distortions.** Shrink small samples harder (lightly capped players such as
  Corbin Bosch or Mahammad Bilal Zalmai currently rank near the top). Rate an all-rounder by their
  better skill plus part of the other, not both added together.
- [x] **2.2b Fix wrong countries.** Indonesian players are stored as India (`IND`), for example
  Danilson Hawoe and Apriliandi Abdillah Rahayu. Map country codes correctly in the ETL and re-seed.
  Also consider leaving associate-nation players out of the default pool.
- [x] **2.3 Roles per format.** A player's role can differ by format (Rahul Dravid is tagged as a
  keeper in Tests).
- [x] **2.4 Themed pools (optional draft mode).** Examples: All-time legends, a World Cup year,
  India vs Australia all-time, a single era. Random pool stays the default.

## Phase 3 — AI opponent (rule-based)

- [x] **3.1 Draft in phases.** Early rounds: best player available by stature. Middle rounds: balance
  the XI. Late rounds: fill the remaining holes.
- [x] **3.2 Scarcity-aware sniping.** The AI takes a player to deny you only when the role is genuinely
  scarce (for example the last good spinner on a turner while you have none), not by default.
- [x] **3.3 Personalities replace Easy/Normal/Hard.**
  - *Fanboy (easy):* over-rates famous names and its home country, and leaves the keeper late.
  - *Sensible Captain (normal):* balanced, best player available.
  - *Shark (hard):* reads your gaps and snipes them.
- [x] **3.4 Talk like a cricketer.** Pick reasons in cricket language, not "+1.3 selection points".
- [x] **3.5 Sanity checks.** Tests that the AI's first picks are stars (for example, it never opens with
  de Grandhomme when Kallis or Muralitharan is available), and that personalities behave differently.

- [ ] **2.5 Afghanistan is missing from the data.** No AFG players were seeded (no Rashid Khan, no
  Nabi) even though the ETL lists AFG. Needs the raw Cricsheet data, which this environment can't
  download (cricsheet.org is blocked), so re-run `npm run etl:download` and `npm run etl:process`
  somewhere with access.

## Phase 4 — AI opponent voice (Claude Haiku, optional)

- [ ] **4.1 Haiku picks from a shortlist.** The rule-based AI proposes the 3–5 best legal players, and
  Claude Haiku 5.5 (`claude-haiku-5-5`, low effort) chooses one in character and returns
  `{ playerId, line }` as structured output.
- [ ] **4.2 Banter line** shown with each AI pick ("Murali on a Chepauk turner? Mine.").
- [ ] **4.3 Never stall.** Timeout, error, invalid ID or no API key → use the rule-based pick. The game
  works fully without a key.
- [ ] **4.4 Key as a secret.** `ANTHROPIC_API_KEY` is stored as a Worker secret
  (`wrangler secret put ANTHROPIC_API_KEY`) and never committed.
- [ ] **4.5 Optional:** Haiku writes the post-match commentary in place of Gemini.
- Estimated cost: about $0.006 per draft (under 1 cent per game). Check the real numbers from `usage` after launch.

## Phase 5 — Match engine (reward good drafting)

- [x] **5.1 Stronger skill signal in the simulator.** Use bowler wicket-taking ability (strike rate and
  average, not only economy cut-offs), give batter quality a larger effect, and reduce the share of the
  result that comes from base randomness.
  _Today:_ the higher-rated XI wins only 53% (T20), 54% (ODI) and 60% (Test) of simulations. An XI
  drafted first from the full pool beats the leftovers only 64% / 75% / 80% of the time.
- [x] **5.2 Calibration target.** Run a harness to show the better-drafted XI wins clearly more often
  (aim for roughly 70%+ in T20 for a clear gap) while upsets still happen.
- [x] **5.3 Small fixes.** Sixes in Test matches are currently scored as fours.

  _Result (fair harness: a Captain-drafted XI v one drafted from the leftovers, 30 pools):_ the
  better XI now wins 66% in T20 (was 57%), 71% in ODIs (was 68%) and 56% in Tests (realistic Tests
  with declarations and follow-ons; the two XIs a 44-player pool produces are close in Test terms).
  Evenly drafted XIs stay near 50/50. Players perform close to their real records against average
  opposition, so stars aren't inflated. Re-measure with `SKILL=<file> npx vitest run tests/skill-signal.test.ts`.

## Phase 6 — Result screen

- [ ] **6.1 Head-to-head first.** Compare openers, middle order, keeper, all-rounders, pace attack, spin
  attack and batting depth, with a winner arrow for each. This is the school argument.
- [ ] **6.2 Series or win chance.** Play a best-of-3 series, or show "your XI wins X% of 500 simulated
  matches" next to the featured match.
- [ ] **6.3 Draft awards.** Steal of the draft (a late pick who performed), biggest regret, best pick.
- [ ] **6.4 Trim the screen.** Order: scoreline → head-to-head → 3 turning points → draft awards →
  full scorecards (collapsed). Remove the 0–100 rating headline that can contradict the result.

## Later

- [ ] **Play with a friend.** Second human seat via a share link, or pass-and-play on one phone. The
  draft room already supports live connections. The AI becomes the umpire and commentator.

---

## Working notes

- **Phases 2 and 3 done.** Production needs one database step before (or right after) deploying:
  `npx wrangler d1 execute cricdraft-db --remote --file=src/db/schema.sql` then
  `npx wrangler d1 execute cricdraft-db --remote --file=data/data-fixes.sql`. Until then the game
  still works (the pool query falls back), but without the country and keeper fixes.
- The AI is now about as strong as a human who always takes the highest-rated player
  (Fanboy < Captain < Shark, roughly 44-57% wins). Its strength should be re-tuned after Phase 5,
  once the match engine rewards good drafting; today the dice decide too much to tune against.

- **Phase 1 + 1b done.** The UI is now Preact + Vite + TypeScript in `web/` (builds to `dist/`),
  sharing the rule code with the server. Picks are slotless: each XI is put into a natural batting
  order automatically (`src/core/batting-order.ts`), and the user sets the final order between the
  draft and the match. A rule the pool can no longer meet (for example when the other side has
  taken every all-rounder) is waived for that side instead of blocking the draft; the need chips
  show it as "pool ran out". Each pool player carries a 1-99 pool rating, used for "Best" sorting.
  U.9 covers the mobile layout only; the result content itself is Phase 6.

- Work happens directly on `main`.
- Each phase ends with `npm test` and `npm run build` passing. Tests that encode the old rules are
  updated to the new rules, never skipped.
- Phases 1–3 need no API key. Phase 4 needs `ANTHROPIC_API_KEY`.
