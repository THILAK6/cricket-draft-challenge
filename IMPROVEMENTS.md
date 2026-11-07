# Making the draft feel like the real thing

The goal: drafting against the AI should feel like the school game with a friend. Picks alternate
and are final, the big names go early, and at the end you argue position by position about whose
XI is better. The match result should reward the side that drafted better.

Items are grouped into phases and listed in the order they will be built. Tick each box when it is done.

---

## Phase 1 — Draft rules (make every pick count)

- [ ] **1.1 Picks are final.** Remove the "remove player" action during the draft, and stop a pick
  into an occupied slot from swapping the old player back into the pool. After the draft, only the
  batting order can change (reorder stays).
  _Today:_ `/remove` returns a player to the pool at any time, and once the AI has 11 you can swap
  with the leftovers forever (`src/durable-objects/DraftRoom.ts`).
- [ ] **1.2 Toss for first pick.** A coin toss decides who picks first, and the draft screen shows the result.
- [ ] **1.3 Snake draft order.** The order is 1-2-2-2…-1, so the side that picks first doesn't get
  the better player in every round. The AI may make two picks in a row, and the UI must show both.
- [ ] **1.4 Pick now, set the order later.** You choose a player, not a batting slot. The batting
  order is arranged once after the draft (the AI suggests an order you can change).
- [ ] **1.5 Fewer hard rules.** Keep these as hard rules: 11 players, at least 1 keeper, at least 5
  bowling options. Batting-hand slot rules, strike-rate/economy minimums and slot-role locks become
  scoring nudges or are dropped. Keep at most one scenario twist (for example a country cap or "2 spinners").
- [ ] **1.6 No "protect the opponent" block.** Stop refusing a pick because it hurts the other side
  (`validator.ts`, "would leave your opponent unable to complete…"). Instead, build each pool so both
  XIs can always be completed: enough keepers and bowlers for two sides plus spares.
- [ ] **1.7 Bigger pool.** 40–44 players instead of 30, so the last picks are still real choices.

## Phase 2 — Player pool and ratings

- [ ] **2.1 Pool by stature, not caps.** "Top players" are chosen by a quality/peak rating, not by
  most matches, so the pool has recognisable stars.
- [ ] **2.2 Fix rating distortions.** Shrink small samples harder (lightly capped players such as
  Corbin Bosch or Mahammad Bilal Zalmai currently rank near the top). Rate an all-rounder by their
  better skill plus part of the other, not both added together.
- [ ] **2.3 Roles per format.** A player's role can differ by format (Rahul Dravid is tagged as a
  keeper in Tests).
- [ ] **2.4 Themed pools (optional draft mode).** Examples: All-time legends, a World Cup year,
  India vs Australia all-time, a single era. Random pool stays the default.

## Phase 3 — AI opponent (rule-based)

- [ ] **3.1 Draft in phases.** Early rounds: best player available by stature. Middle rounds: balance
  the XI. Late rounds: fill the remaining holes.
- [ ] **3.2 Scarcity-aware sniping.** The AI takes a player to deny you only when the role is genuinely
  scarce (for example the last good spinner on a turner while you have none), not by default.
- [ ] **3.3 Personalities replace Easy/Normal/Hard.**
  - *Fanboy (easy):* over-rates famous names and its home country, and leaves the keeper late.
  - *Sensible Captain (normal):* balanced, best player available.
  - *Shark (hard):* reads your gaps and snipes them.
- [ ] **3.4 Talk like a cricketer.** Pick reasons in cricket language, not "+1.3 selection points".
- [ ] **3.5 Sanity checks.** Tests that the AI's first picks are stars (for example, it never opens with
  de Grandhomme when Kallis or Muralitharan is available), and that personalities behave differently.

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

- [ ] **5.1 Stronger skill signal in the simulator.** Use bowler wicket-taking ability (strike rate and
  average, not only economy cut-offs), give batter quality a larger effect, and reduce the share of the
  result that comes from base randomness.
  _Today:_ the higher-rated XI wins only 53% (T20), 54% (ODI) and 60% (Test) of simulations. An XI
  drafted first from the full pool beats the leftovers only 64% / 75% / 80% of the time.
- [ ] **5.2 Calibration target.** Run a harness to show the better-drafted XI wins clearly more often
  (aim for roughly 70%+ in T20 for a clear gap) while upsets still happen.
- [ ] **5.3 Small fixes.** Sixes in Test matches are currently scored as fours.

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

- Work happens directly on `main`.
- Each phase ends with `npm test` and `npm run build` passing. Tests that encode the old rules are
  updated to the new rules, never skipped.
- Phases 1–3 need no API key. Phase 4 needs `ANTHROPIC_API_KEY`.
