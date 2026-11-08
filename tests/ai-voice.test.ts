import { describe, it, expect } from "vitest";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { chooseAiPick, SHORTLIST_MARGIN, SHORTLIST_SIZE } from "../src/core/ai-draft";
import { askVoice, parseVoice, voicePrompt, VOICE_MODEL, type VoiceUsage } from "../src/core/ai-voice";
import { DraftRoom } from "../src/durable-objects/DraftRoom";
import { playerQuality } from "../src/core/player-quality";
import type { DraftState, PlayerWithStats } from "../src/core/types";

const empty = () => Array(11).fill(null) as (PlayerWithStats | null)[];

describe("shortlist", () => {
  it("offers only near-equal legal picks, the rules' own choice first", async () => {
    for (let d = 0; d < 6; d++) {
      const { challenge, pool } = await buildRandomDraft(d1, "T20", lcg(60 + d));
      const r = chooseAiPick({ pool, squad: empty(), opponentSquad: empty(), challenge, difficulty: "normal", noiseSeed: 1, round: 0 })!;
      expect(r.shortlist[0].player.id).toBe(r.player.id);
      expect(r.shortlist.length).toBeLessThanOrEqual(SHORTLIST_SIZE);
      expect(new Set(r.shortlist.map((o) => o.player.id)).size).toBe(r.shortlist.length);
      for (const o of r.shortlist) {
        expect(pool.some((p) => p.id === o.player.id)).toBe(true);
        expect(o.reason).toContain(o.player.name);
      }
      // Near-equal: nobody far below the pick on quality alone gets in on the first pick
      for (const o of r.shortlist) expect(playerQuality(o.player, "T20")).toBeGreaterThan(playerQuality(r.player, "T20") - 25 - SHORTLIST_MARGIN);
    }
  });
});

describe("reading the reply", () => {
  it("takes the pick and the line, leniently", () => {
    expect(parseVoice("PICK: 2\nLINE: Murali on a turner? Mine.", 3)).toEqual({ index: 1, line: "Murali on a turner? Mine." });
    expect(parseVoice("**PICK:** 1\n**LINE:** \"Too good to leave.\"", 2)).toEqual({ index: 0, line: "Too good to leave." });
    expect(parseVoice("3", 4)).toEqual({ index: 2, line: "" });
  });

  it("rejects anything it can't trust", () => {
    expect(parseVoice("PICK: 5\nLINE: hi", 3)).toBeNull();
    expect(parseVoice("I'd go for Warne", 3)).toBeNull();
    expect(parseVoice(undefined, 3)).toBeNull();
    expect(parseVoice("PICK: 1\nLINE: see https://example.com", 2)).toEqual({ index: 0, line: "" });
    expect(parseVoice(`PICK: 1\nLINE: ${"word ".repeat(60)}`, 2)!.line.length).toBeLessThanOrEqual(140);
  });

  it("keeps the prompt small (the free allowance is counted in tokens)", async () => {
    const { challenge, pool } = await buildRandomDraft(d1, "TEST", lcg(8));
    const r = chooseAiPick({ pool, squad: empty(), opponentSquad: empty(), challenge, difficulty: "hard", noiseSeed: 1, round: 0 })!;
    const mine = empty().map((_, i) => pool[i + 20]);
    const { system, user } = voicePrompt({ difficulty: "hard", challenge, mine, theirs: mine, options: r.shortlist, pickNumber: 21 });
    // About 4 characters a token: well under 600 tokens even with two full XIs listed
    expect((system.length + user.length) / 4).toBeLessThan(600);
  });
});

describe("asking Workers AI", () => {
  const input = async () => {
    const { challenge, pool } = await buildRandomDraft(d1, "ODI", lcg(9));
    const r = chooseAiPick({ pool, squad: empty(), opponentSquad: empty(), challenge, difficulty: "easy", noiseSeed: 1, round: 0 })!;
    return { difficulty: "easy" as const, challenge, mine: empty(), theirs: empty(), options: r.shortlist, pickNumber: 1 };
  };
  const usage = (): VoiceUsage => ({ calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 });

  it("uses the cheap fast model and counts the tokens", async () => {
    let model = "";
    const u = usage();
    const reply = await askVoice({ run: async (m) => ((model = m), { response: "PICK: 1\nLINE: Big name, big pick.", usage: { prompt_tokens: 300, completion_tokens: 12 } }) }, await input(), u);
    expect(model).toBe(VOICE_MODEL);
    expect(reply).toEqual({ index: 0, line: "Big name, big pick." });
    expect(u).toEqual({ calls: 1, failures: 0, inputTokens: 300, outputTokens: 12 });
  });

  it("never stalls: no binding, an error, the daily allowance used up, or a slow reply all give null", async () => {
    const i = await input();
    const u = usage();
    expect(await askVoice(undefined, i, u)).toBeNull();
    expect(await askVoice({ run: async () => { throw new Error("4006: you have used up your daily free allocation of 10,000 neurons"); } }, i, u)).toBeNull();
    const t = Date.now();
    expect(await askVoice({ run: () => new Promise(() => {}) }, i, u, VOICE_MODEL, 50)).toBeNull();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(await askVoice({ run: async () => ({ response: "Warne obviously" }) }, i, u)).toBeNull();
    expect(u.failures).toBe(3);
  });
});

describe("in the draft room", () => {
  const store = () => {
    const m = new Map<string, unknown>();
    return { storage: { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)), setAlarm: async () => {} } } as any;
  };
  async function room(ai: unknown) {
    const { challenge, pool } = await buildRandomDraft(d1, "T20", lcg(21));
    const r = new DraftRoom(store(), { AI: ai });
    const state: Partial<DraftState> = {
      roomId: "room_voice", challenge, pool, userPicks: empty(), aiPicks: empty(), currentTurn: "USER", round: 1, maxRounds: 11,
      status: "DRAFTING", lastActionTimestamp: 0, difficulty: "hard", firstPick: "USER",
    };
    await r.fetch(new Request("http://internal/init", { method: "POST", body: JSON.stringify(state) }));
    return r;
  }
  const pick = async (r: DraftRoom) => {
    const st: DraftState = (await (await r.fetch(new Request("http://internal/state"))).json() as any).state;
    const res = await r.fetch(new Request("http://internal/pick", { method: "POST", body: JSON.stringify({ playerId: st.pool[0].id }) }));
    return (await res.json()) as any;
  };

  it("shows the AI's line with its picks, and its choice comes from the shortlist", async () => {
    let calls = 0;
    const r = await room({ run: async () => (calls++, { response: "PICK: 2\nLINE: You wanted him? Too slow." }) });
    const out = await pick(r);
    expect(out.aiPicks).toHaveLength(2);
    expect(calls).toBe(2);
    for (const a of out.aiPicks) expect(a.line).toBe("You wanted him? Too slow.");
    expect(out.state.voiceUsage.calls).toBe(2);
  });

  it("drafts on with the rules' picks when Workers AI fails", async () => {
    const quiet = await room(undefined);
    const broken = await room({ run: async () => { throw new Error("down"); } });
    const a = await pick(quiet);
    const b = await pick(broken);
    expect(b.aiPicks.map((x: any) => x.player.id)).toEqual(a.aiPicks.map((x: any) => x.player.id));
    for (const x of b.aiPicks) expect(x.line).toBeUndefined();
  });
});
