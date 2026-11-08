import type { Challenge, PlayerWithStats } from "./types";
import type { Difficulty } from "./ai-draft";
import { PERSONA_INFO } from "./personas";

/**
 * The AI opponent's voice: Cloudflare Workers AI chooses one of the rule-based AI's shortlisted
 * picks (all legal, all nearly as good as each other) in character, and says one line about it.
 *
 * It never decides anything that matters on its own: the shortlist is built by the rules, the
 * reply is checked, and on any problem (no binding, timeout, error, daily free allowance used up,
 * a reply that doesn't parse) the rule-based pick stands. The game works fully without it.
 *
 * Free plan: 10,000 Neurons a day. This model costs about 4,119 Neurons per million input tokens and
 * 34,868 per million output tokens; a pick is about 330 tokens in and 30 out, so about 2.4 Neurons,
 * about 27 a game (11 picks): roughly 350 games a day for free. Past the allowance, calls fail and
 * the rules take over until midnight UTC (no charge on the Free plan).
 */
export const VOICE_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
/** Longest the draft waits for a line; the rules pick instantly otherwise. */
export const VOICE_TIMEOUT_MS = 2500;
const MAX_LINE = 140;

export interface VoiceOption {
  player: PlayerWithStats;
  reason: string;
}

export interface VoiceInput {
  difficulty: Difficulty;
  challenge: Challenge;
  /** The AI's XI so far and the user's. */
  mine: (PlayerWithStats | null)[];
  theirs: (PlayerWithStats | null)[];
  /** Best first. */
  options: VoiceOption[];
  pickNumber: number;
}

export interface VoiceReply {
  /** Index into the options. */
  index: number;
  line: string;
}

const CHARACTER: Record<Difficulty, string> = {
  easy: "an excitable fan who loves big names and players from his favourite country, and talks like he is at the ground",
  normal: "a calm, sharp captain who talks about balance, conditions and the job each player does",
  hard: "a competitive, needling rival who loves taking the player you wanted and lets you know it",
};

const PITCH: Record<string, string> = {
  GREEN_SEAMER: "a green seamer",
  DUSTBOWL: "a dry, turning pitch",
  SLOW_LOW: "a slow, low pitch",
  HIGH_SCORING_FLAT: "a flat batting pitch",
};

const ROLE: Record<string, string> = { BAT: "batter", WK: "keeper", AR: "all-rounder", BOWL: "bowler" };

/** "Shane Warne (AUS, spin bowler, 708 wkts, econ 2.7)": just enough to talk about. */
function card(p: PlayerWithStats): string {
  const s = p.stats;
  const kind = p.primary_role === "BOWL" || p.primary_role === "AR" ? `${p.bowling_category === "SPIN" ? "spin" : p.bowling_category === "PACE" ? "pace" : ""} ${ROLE[p.primary_role]}`.trim() : ROLE[p.primary_role];
  const bat = s.bat_innings > 0 && p.primary_role !== "BOWL" ? `bat avg ${Math.round(s.bat_average)}` : "";
  const bowl = s.bowl_wickets > 0 && p.primary_role !== "BAT" && p.primary_role !== "WK" ? `${s.bowl_wickets} wkts, econ ${s.bowl_economy.toFixed(1)}` : "";
  return `${p.name} (${p.country}, ${kind}${bat ? `, ${bat}` : ""}${bowl ? `, ${bowl}` : ""})`;
}

const names = (xs: (PlayerWithStats | null)[]) => {
  const ps = xs.filter((p): p is PlayerWithStats => !!p);
  return ps.length ? ps.map((p) => `${p.name} (${ROLE[p.primary_role]})`).join(", ") : "nobody yet";
};

export function voicePrompt(input: VoiceInput): { system: string; user: string } {
  const c = input.challenge;
  const system = [
    `You are ${PERSONA_INFO[input.difficulty].name}, ${CHARACTER[input.difficulty]}.`,
    "You are drafting a cricket XI against a friend, taking turns to pick players from a shared pool.",
    "Choose ONE of the numbered options and say one short line to your friend about the pick: friendly banter, cricket language, at most 20 words, no hashtags or emojis.",
    "Reply in exactly this format and nothing else:",
    "PICK: <option number>",
    "LINE: <your line>",
  ].join("\n");
  const user = [
    `${c.format} match at ${c.venue.name}, ${PITCH[c.venue.pitch_type] ?? "a good pitch"}. Pick ${input.pickNumber} of 22.`,
    `Your XI so far: ${names(input.mine)}.`,
    `Your friend's XI so far: ${names(input.theirs)}.`,
    "Options:",
    ...input.options.map((o, i) => `${i + 1}. ${card(o.player)}: ${o.reason}`),
  ].join("\n");
  return { system, user };
}

/** Reads "PICK: 2 / LINE: ..." leniently; null when it can't be trusted. */
export function parseVoice(text: unknown, optionCount: number): VoiceReply | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const pick = text.match(/PICK\s*[:=-]?\s*\**\s*(\d+)/i) ?? text.match(/^\s*(\d+)\b/);
  const n = pick ? Number(pick[1]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > optionCount) return null;
  const lineMatch = text.match(/LINE\s*[:=-]?\s*(.+)/i);
  let line = (lineMatch?.[1] ?? "").split("\n")[0].trim();
  line = line.replace(/^["'*\s]+|["'*\s]+$/g, "").replace(/\s+/g, " ");
  // No links, markup or anything long: it goes straight onto the screen
  if (!line || /https?:|www\.|<|>|#/i.test(line)) line = "";
  if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE - 1).replace(/\s+\S*$/, "") + "…";
  return { index: n - 1, line };
}

export interface VoiceUsage {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
}

/** Asks Workers AI for a pick and a line; null on anything unexpected (the rules then decide). */
export async function askVoice(
  ai: { run: (model: string, input: unknown) => Promise<unknown> } | undefined,
  input: VoiceInput,
  usage?: VoiceUsage,
  model = VOICE_MODEL,
  timeoutMs = VOICE_TIMEOUT_MS
): Promise<VoiceReply | null> {
  if (!ai || typeof ai.run !== "function" || input.options.length === 0) return null;
  if (usage) usage.calls++;
  const { system, user } = voicePrompt(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = (await Promise.race([
      ai.run(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 60,
        temperature: 0.8,
      }),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), timeoutMs))),
    ])) as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (usage && out?.usage) {
      usage.inputTokens += out.usage.prompt_tokens ?? 0;
      usage.outputTokens += out.usage.completion_tokens ?? 0;
    }
    const reply = parseVoice(out?.response, input.options.length);
    if (!reply && usage) usage.failures++;
    return reply;
  } catch {
    if (usage) usage.failures++;
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
