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
  with sensible defaults, and make "Play match" the main action. _Later:_ the plan was removed. The
  captain picks bowlers from their records (strike bowlers take the new ball, the tightest close the
  innings, T20 from real phase numbers), and the batting order is set by drag and drop.
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

## Phase 4 — AI opponent voice (Cloudflare Workers AI, free plan)

Switched from Claude Haiku to Workers AI to stay on the Cloudflare Free plan with no API key.

- [x] **4.1 Workers AI picks from a shortlist.** The rule-based AI proposes its 2–4 near-equal best legal
  players (within 6 rating points), and `@cf/meta/llama-3.1-8b-instruct-fp8-fast` chooses one in
  character, replying `PICK: n / LINE: ...` (checked; anything else is ignored).
- [x] **4.2 Banter line** shown with each AI pick in the banner (and on the toss screen when the AI picks first).
- [x] **4.3 Never stall.** 2.5 s timeout, errors, an unreadable reply, no binding, or the daily free
  allowance used up → the rule-based pick. The game works fully without it.
- [x] **4.4 No key needed.** It uses the Worker's `AI` binding.
- **Switched off by default after play-testing:** the free 8B model got facts wrong (Saeed Ajmal, an
  off-spinner, called "the leg spin master") and its puns wore thin. The banner shows the rules'
  accurate reasons again. `AI_VOICE=on` brings the voice back.
- [ ] **4.5 Optional:** Workers AI writes the post-match commentary in place of Gemini (about 1 call a game).
- Estimated use: about 2.4 Neurons a pick, 27 a game, so about 350 games a day inside the free 10,000
  Neurons. Check real numbers in the Cloudflare dashboard (Workers AI) or a room's `voiceUsage`.
- The unused `/api/challenges/generate` endpoint no longer calls Workers AI, so the allowance only goes
  to the voice.

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

## Phase 5b — No ratings, balance wins (from play-testing)

- [x] **Ratings removed from the game.** No rating column, sort or sheet line, and none in the data
  the server sends. Players are judged by their numbers (average, strike rate, wickets, economy,
  caps); the list is in role order with a sort for each stat. Ratings stay internal to the AI.
- [x] **Balance matters in the match.** A makeshift opener struggles against the new ball (most in
  Tests), an all-pace or all-spin attack is easier to line up once a batter is in, and non-hitters
  can't finish in the death overs. A balanced XI (Captain AI) now beats a "top-rated" XI 61% in T20
  (was 55%), 64.5% in ODIs (was 61.5%) and 53% in Tests (was 47%).

- [x] **Spinners judged against spinners (from play-testing).** In white-ball cricket a spinner's career
  economy is lower mainly because captains keep him away from the powerplay and the death (T20: 7.3
  against 8.2 for pacers). The T20 rating leaned on economy, so spinners rated about 20 points higher
  and the AI picked four or five on a flat track. Economy is now compared with bowlers of the same type
  (in the ratings and in the match engine), and the AI wants at least two pacers for the new ball and
  the death in T20 and ODIs. On flat T20 pitches the AI now takes about 3.8 pacers and 1.9 spinners
  (was 1.8 and 4.2). The "balanced v top-rated" edge fell to about 50% in T20 and 59% in ODIs: part of
  the old 61%/64.5% came from the top-rated drafter loading up on overrated spinners.

## Phase 6 — Result screen

- [x] **6.1 Head-to-head first.** Compare openers, middle order, keeper, all-rounders, pace attack, spin
  attack, batting depth and fit for the pitch, with a winner arrow for each. This is the school argument.
  Each player shows his own numbers with innings or wickets (so a short career is visible), not a
  pair's average.
- [x] **6.2 Series or win chance.** "Your XI wins X% of 200 replays" next to the featured match, with a
  plain reading ("Unlucky: yours is the better XI...").
- [x] **6.3 Draft awards.** Steal of the draft (a late pick who performed), biggest regret, best pick.
- [x] **6.4 Trim the screen.** Order: scoreline → win chance → head-to-head → 3 turning points → draft
  awards → full scorecards (collapsed). The 0–100 selection score and the team report are gone.

  _Found while building it:_ about 70 spinners were stored as medium pacers (Warne, Kumble, Lyon,
  MacGill, Kaneria, Panesar...), so the match, the pitch fit and the AI treated them as seamers. Fixed
  in `data/data-fixes.sql`. Tests also had a time bug: a side could "declare" while behind, and the
  other side won a one-run chase. Captains now only declare ahead (and with 40+ overs left to bowl), and
  otherwise bat on to a draw. Test draws went from 4% to 13%, and the better-drafted XI now wins 65% of
  Tests (was 56%).

## Phase 8 — T20 phase stats (powerplay, middle, death)

- [x] **8.1 Data.** `src/etl/phase-stats.ts` reads Cricsheet's T20I ball-by-ball data and writes
  `data/phase-stats.sql` (runs, balls, outs, and balls, runs, wickets bowled, per phase per player). The
  GitHub Action "Phase stats from Cricsheet" downloads the data, runs it and commits the file (3,638
  matches, 2,574 players; about 99% of each player's T20I career).
- [x] **8.2 Level.** Career numbers are put on an average phase mix before anything else uses them: a
  finisher's strike rate and a death bowler's economy come down, a middle-overs spinner's economy goes
  up. This replaces the flat spinner adjustment for T20.
- [x] **8.3 Shape.** In the match, each batter and bowler plays each phase as his numbers say, relative
  to his own level and pulled towards normal for small samples. Death and powerplay overs go to the
  bowlers who are actually good then (the old "finisher" rules of thumb only apply to players without
  phase data).
- [x] **8.4 Head-to-head.** T20 adds "Death bowling" (economy in overs 16-20) and "Finishers" (strike
  rate in overs 16-20, from #4-#8), each with the balls behind the number.
- Result: balanced v top-rated in T20 back up to 59% (from 50%), the better-drafted XI wins 66%, and
  real-player T20 totals average about 155.
- [x] **8.5 ODI phases** (1-10, 11-40, 41-50): the same data, level and shape as T20, plus "Death
  bowling" and "Finishers" (overs 41-50) in the ODI head-to-head.
- Production: `npx wrangler d1 execute cricdraft-db --remote --file=data/phase-stats.sql` (until then
  the game runs as before).

## Phase 9 — Situational records (all from Cricsheet ball-by-ball, one Action run)

`src/etl/splits.ts` (run by the "Player splits from Cricsheet" Action) writes `data/phase-stats.sql`,
`data/player-splits.sql` and `src/core/data-norms.generated.ts` (the typical international's numbers for
each split and par scores at the game's grounds). Each split is a "shape": how a player does in that
situation against his own level and against what a typical international does there, shrunk towards
normal for small samples (`src/core/splits.ts`).

- [x] **9.1 Batting position.** Record by position (opening, #3, #4-5, #6-7, #8+) in every format. The
  match uses it, and the batting-order screen shows each batter's record in the spot you drag him to
  ("at #3: avg 52.1 · SR 135 · 40 inns", or "hasn't batted at #3").
- [x] **9.2 ODI phases** (8.5 above).
- [x] **9.3 Home and away.** Record in Asia, in England/Australia/NZ/South Africa, and elsewhere, for
  batting and bowling; the match uses the region of the ground. Shown in the player sheet.
- [x] **9.4 Chasing.** Limited overs: record batting first v chasing (Kohli is dismissed less often
  chasing). Shown in the player sheet.
- [x] **9.5 Par scores.** Real first-innings averages at all 32 grounds (Wankhede ODI 301, Mirpur 230,
  Abu Dhabi T20 137, Adelaide Test 408). The ground sets the scoring level, on top of the day's pitch;
  shown on the toss screen and the result.
- Result (30 pools): the better-drafted XI wins 63% of T20s, 78% of ODIs, 62% of Tests; balanced v
  top-rated 53% / 59% / 58%. Totals: T20 163, ODI 256, Test innings 262.
- Production: apply `data/phase-stats.sql` and `data/player-splits.sql` (until then the game runs
  without them).

## Phase 10 — Saved matches (done)

- [x] 10.1 Every finished match is saved to D1 (`matches`, created on first use) as it was shown: scorecards, review, awards, both XIs and the pick log. Stored, not replayed, so engine changes never rewrite an old scorecard. About 30 KB and one write per match.
- [x] 10.2 "My matches" on the start screen: this phone's matches, newest first, by an anonymous id kept in the browser (no account). Tap one to reopen the full result.
- [x] 10.3 Share link per match (`/?match=<id>`, 10-character unguessable id): the phone's share sheet, or the link copied.
- [ ] 10.4 Later: a record page (wins by format, most-drafted players, record against each AI style) from the same rows.

## Phase 11 — Fairer ratings across eras (done)

- [x] 11.1 Era baselines from Full Member v Full Member matches only (ETL, `DATA_NORMS[fmt].era`). The old table counted every T20I, and since 2019 most are Associate matches, so the 2020s looked low-scoring: 2010s batters were marked down (Kohli's T20I average 48 to 39, rated 90) and 2010s bowlers up (Imran Tahir 104, Al-Amin Hossain 92). Now Kohli 110, Tahir 90, Al-Amin 81, and the Shark no longer opens a draft with a 30-match seamer.
- [x] 11.2 Ratings recalibrated; T20 base scoring re-tuned (rpb 1.42: average innings 161, the real Full Member par).
- [x] 11.3 Tested a ball-by-ball model (`src/etl/rating-model.ts`, `ratings.ts`, workflow "T20 ball-by-ball ratings"): runs and wicket chance per ball = situation (phase x innings, ground, era, position) + team + batter - bowler, ridge-fitted with penalties chosen on held-out matches. Judged on 2025-26 T20Is it had not seen (`data/rating-model-report.md`). On Full Member matches, the cut in runs-per-ball error: today's raw career numbers +0.98%, the model +1.02% (fitted on all matches) / +1.06% (Full Member matches only), and **raw career numbers with Associate matches left out +1.26%** (innings-total error 27.0 v 28.7 today and 29.3 for the model). The model only wins when Associate matches are in the test, and Associates (who barely meet Full Members) cannot be placed on the scale reliably. Not adopted. Wicket skill is too noisy to separate any of them.
- [ ] 11.4 Next: build each player's career numbers from Full Member v Full Member matches only (T20 first; ODI and Test the same way), and test a partial weight for Associate matches on held-out data.

## Phase 12 — Engine against real cricket (done)

- [x] 12.1 Scoring audit (`tests/scoring-audit.test.ts`): AI-v-AI drafts at every game ground and pitch, batting-first score against the real ground par, and every innings against real Full Member innings (`data-norms` `innings`, `results`, from the Cricsheet job). T20 (+9%) and ODI (+4%) were right: the game's XIs are stronger than the average side. **Tests were 23% low** (first innings 262 against 343; 91 overs against 102; draws 9% against 19%).
- [x] 12.2 Test rates re-fitted (runs per ball x1.14, wicket rate x0.86): first innings 340 in 105 overs (real 343 in 102), fourth innings 190 (real 185), draws 16% (real 19%), whole-ground ratio 1.00. Strong-v-weak drafting signal unchanged (56%).
- [x] 12.3 Head-to-head no longer counts rows won: on 1000 replayed pairs per format it picked the stronger side only 40%, 42% and 49% of the time (T20, ODI, Test). Fitted on those replays, the card now names what counts most (T20: finishers, pitch fit, death bowling; ODI: finishers, pitch fit; Test: middle order, batting depth) and who leads there. `tests/h2h-calibration.test.ts` refits the weights.
- [x] 12.4 Test third innings: the worn-pitch run penalty (x0.85) applied to both the third and fourth innings; real third innings score at nearly the first-innings rate. Now x0.97 for the third and x0.85 for the fourth: third innings 243 runs in 80 overs (real 252 in 77), fourth 201 (real 185), draws 16% (real 19%).
- [x] 12.5 Limited-overs chases: the target never changed how batters play, so chasers were bowled out far less than real (T20 9% against 21%, ODI 18% against 38%). A side behind the required rate now takes more risk (wicket rate up, runs up less): chasers bowled out 22% (T20) and 30% (ODI) with batting first winning 50.6% and 47.4%, exactly the real 50.6% and 47.3%. Drafting signal unchanged (T20 66%, ODI 68%).
- [x] 12.6 Flat pitches scoring about 20% above ground par: not an engine error. Half of it is strong XIs gaining more on a flat deck (average XIs: 1.16 in T20, 1.12 in ODI); the rest is that a ground's real par averages all its pitches while the game's flat is the high end. Averaged over the pitches each ground can have, the engine is on par. Left unchanged.
- [ ] 12.7 Remaining: Test fourth innings last about 10 overs longer than real (69 against 59); ODI first innings are all out 23% against 33% real.

## Phase 13 — The draft first (done)

- [x] 13.1 Result page order: the draft (awards and key decisions) first, then the replays, head to head, turning points, scorecards, then the player of the match.
- [x] 13.2 Key decisions (`buildDraftDecisions`): read from the draft itself by replaying the pick log against the full pool. Smart: the best keeper (or other scarce kind) left was taken ahead of a bigger name whose equals were still there or came to you later ("Buttler over Kohli: Buttler was the best keeper left, Root was still there"). Costly: a plentiful kind was taken ahead of the last good one of another kind, who went to the AI. One lesson per player passed over; no ratings shown.
- [x] 13.3 Head to head: every area starts closed with who leads on its line; "Open all" shows the players. "Played 200 times" became "Same match, 200 replays", with a sentence saying what it means.

- [x] 13.4 "Typical (200)" tab in Scorecards: every player's card averaged over the same 200 replays as the win chance (no extra simulations): runs, strike rate, how often out and best for batters; overs, runs, wickets and economy for bowlers; the side's average and middle 80% of scores. Tests are averaged per match across both innings. The real scorecard stays as it was.
- [x] 13.5 Drag landing follows where the rows really are (rows differ in height in a draft), not a fixed row height.

## Phase 14 — IPL mode (done)

- [x] 14.1 Data (`src/etl/ipl.ts`, `src/etl/league.ts`, workflow "IPL data from Cricsheet"): 1,209 IPL matches into the international data's columns for 475 players (10+ matches), plus phases, batting positions, chasing, the league's own norms by phase and season, and real par at 13 IPL grounds. 185 players new to the game are added (the international files place their country; Afghan players are placed by name). Pace/spin for new players is guessed from overs and stumpings (94% right on players whose type is known); known "pace" bowlers whose wickets are full of stumpings (Kumble, Kartik, Chawla) are spinners in the IPL.
- [x] 14.2 Design: IPL is the T20 engine with a league tag. `PlayerStats.league` and `Challenge.league` select the IPL's norms (phase, position, chase, seasons, ground par) and rating anchors; the 50-odd `format === "T20"` checks are untouched.
- [x] 14.3 Rules: `max_overseas` (at most 4 from outside India) in pick legality, the endgame lookahead, squad check and both feasibility searches. IPL grounds, IPL themes (all seasons, legends, recent, early years), IPL scenarios.
- [x] 14.4 Calibration to the real league (`tests/scoring-audit.test.ts`, AUDIT_IPL): runs x0.94, wickets x1.3, no catch-up boost for chasers. First innings 182 (real par 169, stronger XIs), all out 8% (7%), batting first wins 44% (45.5%). Better XI wins 58%+ of replays.
- [ ] 14.5 Still off: chasers are all out 20% of the time (real 12%); flat pitches run 20% above par; players with no international record are assumed Indian (a few IPL-only overseas players may be missing from the list in `KNOWN_ABROAD`); batting hand is RHB for players new to the game.
- [ ] 14.6 Next: franchise themes (one club's players), the auction as a draft format.

## Phase 7 — School rules: names, not numbers (proposed)

- [ ] **7.1 Names only by default.** During the draft each player shows country, role, bowling type
  (left-arm pace, leg-spin...) and batting spot (opener, middle order, finisher), but no averages, strike
  rates or wickets, so you pick from what you know about players, like at school.
- [ ] **7.2 "Show career numbers" switch** on the setup screen for anyone who wants them.
- [ ] **7.3 Numbers after the match.** The head-to-head on the result screen reveals the career numbers.

## Later

- [ ] **Play with a friend.** Second human seat via a share link, or pass-and-play on one phone. The
  draft room already supports live connections. The AI becomes the umpire and commentator.

---

## Working notes

- **Phase 6 done.** Production needs `npx wrangler d1 execute cricdraft-db --remote --file=data/data-fixes.sql`
  again for the spinner fix (the file is safe to re-run).
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
- No phase needs an API key: the AI's voice uses the Worker's Workers AI binding.
