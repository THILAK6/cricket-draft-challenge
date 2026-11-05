import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { generateRefereeReport } from "../src/core/gemini-referee";
import { DraftRoom } from "../src/durable-objects/DraftRoom";
import { checkChallengeFeasibility, checkDraftFeasibility, canPickPlayer, canCompleteSquad, validateSquad, DEFAULT_SEARCH_NODE_BUDGET } from "../src/core/validator";
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

  it("rejects a reorder that breaks a slot rule", async () => {
    // Slot 1 must be LHB; put an LHB there and an RHB in slot 2, then try to swap them.
    expect((await call(room, "/pick", { playerId: "IND_lhb", targetIndex: 0 })).data.success).toBe(true);
    expect((await call(room, "/pick", { playerId: "AUS_rhb", targetIndex: 1 })).data.success).toBe(true);
    const res = await call(room, "/reorder", { fromIndex: 0, toIndex: 1 });
    expect(res.status).toBe(400);
    const state = (await call(room, "/state")).data.state as DraftState;
    expect(state.userPicks[0]?.id).toBe("IND_lhb");
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

    // Removing and re-adding the same player reproduces the identical match (fixed room seed)
    const removedId = drafted.userPicks[10]!.id;
    await call(room, "/remove", { slotIndex: 10 });
    expect((await call(room, "/pick", { playerId: removedId, targetIndex: 10 })).data.success).toBe(true);
    const replay = await call(room, "/start-match");
    expect(replay.data.results.simulation.summary).toBe(first.data.results.simulation.summary);
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

describe("Role rules while drafting", () => {
  const open: Challenge = { ...challenge, constraints: [{ type: "max_per_country", value: 2 }] };

  it("rejects a third wicketkeeper", () => {
    const pool = buildPool();
    const squad = [pool.find((p) => p.id === "IND_wk")!, pool.find((p) => p.id === "AUS_wk")!, ...Array(9).fill(null)];
    const res = canPickPlayer(pool.find((p) => p.id === "ENG_wk")!, squad, open, 2);
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/wicketkeepers/);
  });

  it("won't hoard the last bowlers the opponent still needs", () => {
    const all = buildPool();
    const byId = (id: string) => all.find((p) => p.id === id)!;
    // I already have 5 bowling options; the opponent has none and needs 5.
    const mine = ["IND_pace", "AUS_pace", "ENG_pace", "RSA_spin", "NZL_spin", "PAK_wk"].map(byId);
    const squad = [...mine, ...Array(5).fill(null)];
    const opp = [byId("SL_wk"), ...Array(10).fill(null)];
    const bowlers = ["WI_pace", "WI_spin", "SL_pace", "SL_spin", "BAN_pace", "BAN_spin"].map(byId);
    const pool = [...bowlers, byId("AFG_rhb"), byId("AFG_lhb")];
    const ctx = { pool, opponentSquad: opp };
    // A 6th bowler for me would leave only 4 for an opponent who needs 5
    const hoard = canPickPlayer(bowlers[0], squad, open, 6, ctx);
    expect(hoard.allowed).toBe(false);
    expect(hoard.reason).toMatch(/Not enough|too few/);
    // A batter is fine
    expect(canPickPlayer(byId("AFG_rhb"), squad, open, 6, ctx).allowed).toBe(true);
  });

  it("never strands a naive batter-first drafter", async () => {
    const room = new DraftRoom(fakeState(), {});
    await call(room, "/init", initState());
    const drafted = await draftToCompletion(room);
    expect(drafted.userPicks.filter(Boolean)).toHaveLength(11);
    expect(drafted.aiPicks.filter(Boolean)).toHaveLength(11);
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
    expect(typeof r.userRating).toBe("number");
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

describe("Endgame lookahead", () => {
  const lhbOpener: Challenge = { ...challenge, constraints: [{ type: "batting_hand_order", positions: [1], hand: "LHB" }] };

  function almostFullSquad(all: PlayerWithStats[], missingSlot: number) {
    const ids = ["IND_rhb", "AUS_rhb", "ENG_wk", "RSA_rhb", "NZL_rhb", "PAK_ar", "WI_pace", "SL_spin", "BAN_pace", "AFG_spin", "IND_ar"];
    const squad: (PlayerWithStats | null)[] = ids.map((id) => all.find((p) => p.id === id)!);
    squad[missingSlot] = null;
    return squad;
  }

  it("detects a squad whose last slot can no longer be filled legally", () => {
    const all = buildPool();
    const squad = almostFullSquad(all, 0); // slot 1 must be an LHB opener
    const onlyRhb = all.filter((p) => p.batting_hand === "RHB" && !squad.includes(p));
    expect(canCompleteSquad(squad, onlyRhb, lhbOpener)).toBe(false);
    const withLhb = [...onlyRhb, all.find((p) => p.id === "PAK_lhb")!];
    expect(canCompleteSquad(squad, withLhb, lhbOpener)).toBe(true);
  });

  it("stops a pick that would strand the last slot", () => {
    const all = buildPool();
    const squad = almostFullSquad(all, 0); // hole at slot 1 (needs an LHB opener)
    squad[4] = null; // and a middle-order hole at slot 5
    const lhb = all.find((p) => p.id === "PAK_lhb")!;
    const rhb = all.find((p) => p.id === "PAK_rhb")!;
    // Opponent already has a full XI, so only my own squad can be stranded
    const fullOpp = almostFullSquad(all, 0).map((p) => p ?? all.find((x) => x.id === "IND_lhb")!);
    const ctx = { pool: [lhb, rhb], opponentSquad: fullOpp };
    // Spending the only LHB on slot 5 would leave slot 1 impossible to fill
    const stranding = canPickPlayer(lhb, squad, lhbOpener, 4, ctx);
    expect(stranding.allowed).toBe(false);
    expect(stranding.reason).toMatch(/too few|unable to complete/);
    // The RHB in the middle is fine, and so is the LHB at the top
    expect(canPickPlayer(rhb, squad, lhbOpener, 4, ctx).allowed).toBe(true);
    expect(canPickPlayer(lhb, squad, lhbOpener, 0, ctx).allowed).toBe(true);
  });
});
