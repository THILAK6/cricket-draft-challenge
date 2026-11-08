import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { generateRefereeReport } from "../src/core/gemini-referee";
import { DraftRoom } from "../src/durable-objects/DraftRoom";
import { checkChallengeFeasibility, checkDraftFeasibility, canPickPlayer, canCompleteSquad, validateSquad, rulesFor, DEFAULT_SEARCH_NODE_BUDGET } from "../src/core/validator";
import type { Challenge, DraftState, PlayerWithStats } from "../src/core/types";

function mockPlayer(
  id: string,
  country: string,
  role: "BAT" | "WK" | "AR" | "BOWL",
  hand: "LHB" | "RHB" = "RHB",
  bowling: "NONE" | "PACE" | "SPIN" = "NONE"
): PlayerWithStats {
  const bowls = role === "BOWL" || role === "AR";
  return {
    id,
    name: `Player ${id}`,
    country,
    batting_hand: hand,
    bowling_category: bowling,
    primary_role: role,
    stats: {
      player_id: id,
      format: "T20",
      matches: 40,
      bat_innings: 35,
      bat_runs: bowls ? 200 : 900,
      bat_average: bowls ? 12 : 30,
      bat_strike_rate: bowls ? 110 : 135,
      top_order_innings: role === "BAT" ? 20 : 0,
      middle_order_innings: 10,
      finisher_innings: role === "AR" ? 8 : 0,
      bowl_innings: bowls ? 35 : 0,
      bowl_overs: bowls ? 120 : 0,
      bowl_wickets: bowls ? 45 : 0,
      bowl_average: 24,
      bowl_economy: 7.6,
    },
  };
}

function buildPool(): PlayerWithStats[] {
  const pool: PlayerWithStats[] = [];
  for (const c of ["IND", "AUS", "ENG", "RSA", "NZL", "PAK", "WI", "SL", "BAN", "AFG"]) {
    pool.push(mockPlayer(`${c}_wk`, c, "WK"));
    pool.push(mockPlayer(`${c}_lhb`, c, "BAT", "LHB"));
    pool.push(mockPlayer(`${c}_rhb`, c, "BAT", "RHB"));
    pool.push(mockPlayer(`${c}_pace`, c, "BOWL", "RHB", "PACE"));
    pool.push(mockPlayer(`${c}_spin`, c, "BOWL", "RHB", "SPIN"));
    pool.push(mockPlayer(`${c}_ar`, c, "AR", "RHB", "PACE"));
  }
  return pool;
}

const challenge: Challenge = {
  id: "ch_room_test",
  title: "Room Test",
  format: "T20",
  venue: { name: "Test Ground", country: "IND", pitch_type: "HIGH_SCORING_FLAT" },
  narrative_intro: "Test",
  constraints: [
    { type: "max_per_country", value: 2 },
    { type: "batting_hand_order", positions: [1], hand: "LHB" },
  ],
};

function fakeState() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : undefined),
      put: async (k: string, v: unknown) => {
        store.set(k, structuredClone(v));
      },
    },
  } as any;
}

function initState(): DraftState {
  return {
    roomId: "room_test",
    challenge,
    pool: buildPool(),
    userPicks: Array(11).fill(null),
    aiPicks: Array(11).fill(null),
    currentTurn: "USER",
    round: 1,
    maxRounds: 11,
    status: "DRAFTING",
    lastActionTimestamp: 0,
    // Fixed toss so tests are deterministic; the room tosses when this is absent
    firstPick: "USER",
  };
}

async function call(room: DraftRoom, path: string, body?: unknown, raw?: string) {
  const res = await room.fetch(
    new Request(`http://internal${path}`, {
      method: body === undefined && raw === undefined && path.endsWith("/state") ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? (body === undefined ? (path.endsWith("/state") ? undefined : "{}") : JSON.stringify(body)),
    })
  );
  return { status: res.status, data: (await res.json()) as any };
}

/** Picks the first legal pool player into the first empty user slot until both XIs are full. */
async function draftToCompletion(room: DraftRoom) {
  let state: DraftState = (await call(room, "/state")).data.state;
  while (state.userPicks.filter(Boolean).length < 11) {
    const slot = state.userPicks.findIndex((p) => p === null);
    let placed = false;
    for (const p of state.pool) {
      const res = await call(room, "/pick", { playerId: p.id, targetIndex: slot });
      if (res.data.success) {
        state = res.data.state;
        placed = true;
        break;
      }
    }
    if (!placed) throw new Error(`No legal pick for slot ${slot + 1}`);
  }
  return state;
}

describe("DraftRoom endpoint hardening", () => {
  let room: DraftRoom;

  beforeEach(async () => {
    room = new DraftRoom(fakeState(), {});
    const res = await call(room, "/init", initState());
    expect(res.status).toBe(200);
  });

  it("refuses to re-initialize an existing room", async () => {
    const res = await call(room, "/init", { ...initState(), pool: [] });
    expect(res.status).toBe(409);
    const state = (await call(room, "/state")).data.state;
    expect(state.pool.length).toBeGreaterThan(0);
  });

  it("returns 400 (not 500) for malformed JSON", async () => {
    const res = await call(room, "/pick", undefined, "not json");
    expect(res.status).toBe(400);
  });

  it("does not give the AI a pick when the user's pick is rejected", async () => {
    const res = await call(room, "/pick", { playerId: "does_not_exist", targetIndex: 0 });
    expect(res.status).toBe(400);
    const state = (await call(room, "/state")).data.state as DraftState;
    expect(state.aiPicks.filter(Boolean)).toHaveLength(0);
    expect(state.currentTurn).toBe("USER");
  });

  it("rejects reorder requests with missing or non-integer indices", async () => {
    expect((await call(room, "/reorder", {})).status).toBe(400);
    expect((await call(room, "/reorder", { fromIndex: 0.5, toIndex: 1 })).status).toBe(400);
    expect((await call(room, "/reorder", { fromIndex: "0", toIndex: 1 })).status).toBe(400);
  });

  it("lets the user set the batting order only between the draft and the match", async () => {
    await call(room, "/pick", { playerId: "IND_lhb" });
    expect((await call(room, "/reorder", { fromIndex: 0, toIndex: 1 })).status).toBe(409);
    const drafted = await draftToCompletion(room);
    expect(drafted.status).toBe("READY_TO_PLAY");
    const movedId = drafted.userPicks[10]!.id;
    const res = await call(room, "/reorder", { fromIndex: 10, toIndex: 0 });
    expect(res.status).toBe(200);
    expect(res.data.state.userPicks[0].id).toBe(movedId);
    await call(room, "/start-match");
    expect((await call(room, "/reorder", { fromIndex: 0, toIndex: 1 })).status).toBe(409);
  });

  it("refuses to simulate (via /referee or /start-match) before both squads are full", async () => {
    expect((await call(room, "/referee")).status).toBe(400);
    expect((await call(room, "/start-match")).status).toBe(400);
  });

  it("cannot re-roll a completed match", async () => {
    const drafted = await draftToCompletion(room);
    expect(drafted.status).toBe("READY_TO_PLAY");

    const first = await call(room, "/start-match");
    expect(first.status).toBe(200);
    const again = await call(room, "/start-match");
    const viaReferee = await call(room, "/referee");
    expect(again.data.results.winner).toBe(first.data.results.winner);
    expect(again.data.results.simulation.summary).toBe(first.data.results.simulation.summary);
    expect(viaReferee.data.results.simulation.summary).toBe(first.data.results.simulation.summary);

    // Picks are final: nothing can be sent back to the pool to re-roll the match
    expect((await call(room, "/remove", { slotIndex: 10 })).status).toBe(409);
    expect((await call(room, "/start-match")).data.results.simulation.summary).toBe(first.data.results.simulation.summary);
  });
});

describe("Feasibility search safeguards", () => {
  it("fails impossible constraints at the root instead of searching", () => {
    const impossible: Challenge = {
      ...challenge,
      constraints: [{ type: "min_strike_rate_top_order", threshold: 999 }],
    };
    const result = checkChallengeFeasibility(buildPool(), impossible, 1);
    expect(result.isFeasible).toBe(false);
    expect(result.nodesVisited).toBeLessThanOrEqual(2);
  });

  it("stops at the node budget instead of exhausting CPU", () => {
    const easy: Challenge = { ...challenge, constraints: [{ type: "max_per_country", value: 2 }] };
    const result = checkChallengeFeasibility(buildPool(), easy, 50, 25);
    expect(result.isFeasible).toBe(false);
    expect(result.reasons[0]).toMatch(/budget/);
    expect(result.nodesVisited).toBeLessThanOrEqual(26);
  });

  it("finds a realistic challenge well inside the free-plan CPU budget", () => {
    const result = checkDraftFeasibility(buildPool(), { ...challenge, constraints: [{ type: "max_per_country", value: 2 }] }, 1);
    expect(result.isFeasible).toBe(true);
    expect(result.nodesVisited).toBeLessThan(DEFAULT_SEARCH_NODE_BUDGET);
  });

  it("rejects pools that can only support one XI in a head-to-head draft", () => {
    // Only one wicketkeeper in the pool: one XI is possible, two disjoint XIs are not.
    const pool = buildPool().filter((p) => p.primary_role !== "WK" || p.id === "IND_wk");
    const noHandRule: Challenge = { ...challenge, constraints: [{ type: "max_per_country", value: 2 }] };
    expect(checkChallengeFeasibility(pool, noHandRule, 5).isFeasible).toBe(true);
    const draft = checkDraftFeasibility(pool, noHandRule, 5);
    expect(draft.isFeasible).toBe(false);
    expect(draft.reasons[0]).toMatch(/two disjoint XIs/);
  });
});

describe("Draft order and final picks", () => {
  it("follows the snake order: the AI answers the first pick with two picks in a row", async () => {
    const room = new DraftRoom(fakeState(), {});
    await call(room, "/init", initState());
    let st = (await call(room, "/pick", { playerId: "IND_lhb" })).data.state as DraftState;
    expect(st.aiPicks.filter(Boolean)).toHaveLength(2);
    expect(st.lastAiPicks).toHaveLength(2);
    expect(st.currentTurn).toBe("USER");
    // Picks 4 and 5 are both the user's
    st = (await call(room, "/pick", { playerId: "AUS_rhb" })).data.state;
    expect(st.aiPicks.filter(Boolean)).toHaveLength(2);
    expect(st.currentTurn).toBe("USER");
    st = (await call(room, "/pick", { playerId: "ENG_wk" })).data.state;
    expect(st.aiPicks.filter(Boolean)).toHaveLength(4);
    expect(st.pickLog!.map((e) => e.by).join(",")).toBe("USER,AI,AI,USER,USER,AI,AI");
  });

  it("lets the AI open the draft when it wins the toss", async () => {
    const room = new DraftRoom(fakeState(), {});
    const st = (await call(room, "/init", { ...initState(), firstPick: "AI" })).data.state as DraftState;
    expect(st.aiPicks.filter(Boolean)).toHaveLength(1);
    expect(st.currentTurn).toBe("USER");
    const drafted = await draftToCompletion(room);
    expect(drafted.pickLog).toHaveLength(22);
    expect(drafted.pickLog![21].by).toBe("USER");
  });

  it("tosses for first pick when none is given", async () => {
    const room = new DraftRoom(fakeState(), {});
    const { firstPick, ...rest } = initState();
    const st = (await call(room, "/init", rest)).data.state as DraftState;
    expect(["USER", "AI"]).toContain(st.firstPick);
    expect(st.pickOrder).toHaveLength(22);
  });

  it("puts every pick into a natural batting order", async () => {
    const room = new DraftRoom(fakeState(), {});
    await call(room, "/init", initState());
    const st = (await call(room, "/pick", { playerId: "IND_pace" })).data.state as DraftState;
    // A bowler drafted first bats at 11, not at 1
    expect(st.userPicks[10]?.id).toBe("IND_pace");
    expect(st.userPicks[0]).toBeNull();
  });

  it("allows a third wicketkeeper (as a batter)", () => {
    const pool = buildPool();
    const open: Challenge = { ...challenge, constraints: [{ type: "max_per_country", value: 2 }] };
    const squad = [pool.find((p) => p.id === "IND_wk")!, pool.find((p) => p.id === "AUS_wk")!, ...Array(9).fill(null)];
    expect(canPickPlayer(pool.find((p) => p.id === "ENG_wk")!, squad, open).allowed).toBe(true);
  });

  it("never refuses a pick to protect the opponent; the opponent's rule is waived if the pool runs dry", () => {
    const all = buildPool();
    const byId = (id: string) => all.find((p) => p.id === id)!;
    const open: Challenge = { ...challenge, constraints: [{ type: "max_per_country", value: 2 }] };
    const mine = ["IND_pace", "AUS_pace", "ENG_pace", "RSA_spin", "NZL_spin", "PAK_wk"].map(byId);
    const squad = [...mine, ...Array(5).fill(null)];
    const opp = [byId("SL_wk"), ...Array(10).fill(null)];
    const bowlers = ["WI_pace", "WI_spin", "SL_pace", "SL_spin", "BAN_pace", "BAN_spin"].map(byId);
    const pool = [...bowlers, byId("AFG_rhb"), byId("AFG_lhb")];
    // A 6th bowler for me leaves the opponent short of five: allowed anyway
    expect(canPickPlayer(bowlers[0], squad, open, undefined, { pool, opponentSquad: opp }).allowed).toBe(true);
    // ...and the opponent's bowling rule then only asks for what the pool can still give them
    // Say the AI takes two more: four bowlers are left, so the opponent's "five bowlers" becomes four
    const oppNeeds = rulesFor(open, [byId("SL_wk")], pool.slice(2));
    const bowl = oppNeeds.find((n) => n.key === "BOWL")!;
    expect(bowl.waived).toBe(true);
    expect(bowl.required).toBe(4);
  });

  it("never strands a naive drafter", async () => {
    const room = new DraftRoom(fakeState(), {});
    await call(room, "/init", initState());
    const drafted = await draftToCompletion(room);
    expect(drafted.userPicks.filter(Boolean)).toHaveLength(11);
    expect(drafted.aiPicks.filter(Boolean)).toHaveLength(11);
  });
});

describe("Endgame lookahead", () => {
  // Two picks that must each be both a pace bowler and an all-rounder
  const tight: Challenge = {
    ...challenge,
    constraints: [
      { type: "min_category", category: "PACE", count: 2 },
      { type: "min_category", category: "AR", count: 2 },
    ],
  };
  const all = buildPool();
  const byId = (id: string) => all.find((p) => p.id === id)!;
  const spinAr = (id: string, c: string) => ({ ...mockPlayer(id, c, "AR", "RHB", "SPIN") });
  // 8 picks: keeper, 4 batters, 3 spinners (3 bowling options, no pace, no all-rounder)
  const base = () => [byId("IND_wk"), byId("IND_rhb"), byId("AUS_rhb"), byId("ENG_rhb"), byId("RSA_rhb"), byId("NZL_spin"), byId("PAK_spin"), byId("WI_spin")];

  it("detects a squad that can no longer be completed", () => {
    const squad = [...base(), byId("SL_rhb"), null, null];
    // Two picks left, needing two pace bowlers and two all-rounders: only pace all-rounders would do
    expect(canCompleteSquad(squad, [byId("BAN_pace"), spinAr("x1", "AFG"), byId("AFG_pace"), spinAr("x2", "ZIM")], tight)).toBe(false);
    expect(canCompleteSquad(squad, [byId("BAN_ar"), byId("AFG_ar"), byId("AFG_pace")], tight)).toBe(true);
  });

  it("stops a pick that would strand the last picks", () => {
    const squad = [...base(), null, null, null];
    const pool = [byId("BAN_ar"), spinAr("x1", "AFG"), byId("AFG_pace"), byId("SL_rhb")];
    const ctx = { pool };
    // A batter now leaves two picks that would each have to be a pace all-rounder
    const res = canPickPlayer(byId("SL_rhb"), squad, tight, undefined, ctx);
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/couldn't finish/);
    // The pace all-rounder keeps the XI completable
    expect(canPickPlayer(byId("BAN_ar"), squad, tight, undefined, ctx).allowed).toBe(true);
  });

  it("never stalls: with no legal pick left, the user may take any player", async () => {
    const squad = [...base(), byId("SL_rhb"), null, null];
    const pool = [byId("BAN_pace"), byId("AFG_pace"), spinAr("x1", "ZIM"), spinAr("x2", "SCO")];
    const r = new DraftRoom(fakeState(), {});
    await call(r, "/init", { ...initState(), challenge: tight, userPicks: squad, pool });
    const st = (await call(r, "/pick", { playerId: "BAN_pace" })).data;
    expect(st.success).toBe(true);
  });
});

describe("Single source of truth for the result", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes the winner from the simulated match, not from a rating or Gemini", async () => {
    const room = new DraftRoom(fakeState(), {});
    await call(room, "/init", initState());
    await draftToCompletion(room);
    const { data } = await call(room, "/start-match");
    const r = data.results;
    expect(r.winner).toBe(r.simulation.winner);
    expect(r.verdictSummary).toBe(r.simulation.summary);
    expect(r.refereeReport).toBeNull(); // no Gemini key: commentary is optional, result is unaffected
    expect(r).not.toHaveProperty("userRating"); // no 0-100 rating that could contradict the result
    expect(r.review.headToHead.rows).toHaveLength(10); // T20: death bowling and finishers too
    expect(r.review.winChance.played).toBe(200);
    expect(r).not.toHaveProperty("userAdjustment");
  });

  it("falls back to null on Gemini errors and pauses after a 429", async () => {
    const room = new DraftRoom(fakeState(), {});
    await call(room, "/init", initState());
    await draftToCompletion(room);
    const sim = (await call(room, "/start-match")).data.results.simulation;
    const st: DraftState = (await call(room, "/state")).data.state;

    const fetchMock = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await generateRefereeReport(st.userPicks, st.aiPicks, st.challenge, sim, "key");
    expect(first).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Cooling down: no further network call
    expect(await generateRefereeReport(st.userPicks, st.aiPicks, st.challenge, sim, "key")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("AI drafting is stats-driven and fair", () => {
  async function aiSquadFor(names: (id: string) => string, pitch: Challenge["venue"]["pitch_type"] = "HIGH_SCORING_FLAT") {
    const room = new DraftRoom(fakeState(), {});
    const st = initState();
    st.pool = buildPool().map((p) => ({ ...p, name: names(p.id) }));
    st.challenge = { ...challenge, venue: { ...challenge.venue, pitch_type: pitch }, constraints: [{ type: "max_per_country", value: 2 }] };
    await call(room, "/init", st);
    const drafted = await draftToCompletion(room);
    return drafted.aiPicks.map((p) => p!.id);
  }

  it("makes identical picks whether or not players carry famous names", async () => {
    const plain = await aiSquadFor((id) => `Player ${id}`);
    const famous = await aiSquadFor((id) =>
      ["Virat Kohli", "Rohit Sharma", "MS Dhoni", "Jasprit Bumrah", "Steve Smith", "Joe Root"][id.length % 6] + ` ${id}`
    );
    expect(famous).toEqual(plain);
  });

  it("always assembles a valid XI, even when told a second spinner is unattractive", async () => {
    for (const pitch of ["HIGH_SCORING_FLAT", "GREEN_SEAMER", "DUSTBOWL", "SLOW_LOW"] as const) {
      const room = new DraftRoom(fakeState(), {});
      const st = initState();
      st.challenge = {
        ...challenge,
        venue: { ...challenge.venue, pitch_type: pitch },
        constraints: [{ type: "max_per_country", value: 2 }, { type: "min_category", category: "SPIN", count: 3 }],
      };
      await call(room, "/init", st);
      const drafted = await draftToCompletion(room);
      const ai = drafted.aiPicks.filter(Boolean) as PlayerWithStats[];
      expect(ai).toHaveLength(11);
      expect(validateSquad(drafted.aiPicks, st.challenge).valid, `${pitch}: ${validateSquad(drafted.aiPicks, st.challenge).violations}`).toBe(true);
    }
  });
});
