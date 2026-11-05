import type { Challenge, PlayerWithStats } from "./types";
import type { MatchSimulationResult } from "./simulator";

/** Override per deployment with the GEMINI_MODEL var when Google retires a model. */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/**
 * Gemini's free tier is rate limited (requests per minute and per day). After a 429 we skip
 * the API for a cooldown instead of hammering a closed door.
 *
 * Gemini never decides anything: the simulator owns the winner, margin and explanations.
 * This only adds an optional broadcast-style referee report that narrates the real result.
 */
const GEMINI_RATE_LIMIT_COOLDOWN_MS = 60_000;
const GEMINI_TIMEOUT_MS = 8_000;
let geminiBackoffUntil = 0;

function describeResult(sim: MatchSimulationResult): string {
  const inn = (i?: { totalRuns: number; totalWickets: number; oversString: string }) =>
    i ? `${i.totalRuns}/${i.totalWickets} (${i.oversString} ov)` : "-";
  const user = [inn(sim.userInnings), sim.userSecondInnings ? inn(sim.userSecondInnings) : ""].filter(Boolean).join(" & ");
  const ai = [inn(sim.aiInnings), sim.aiSecondInnings ? inn(sim.aiSecondInnings) : ""].filter(Boolean).join(" & ");
  const outcome =
    sim.winner === "USER" ? "Your XI won"
    : sim.winner === "AI" ? "AI XI won"
    : sim.winner === "DRAW" ? "Match drawn"
    : "Match tied";
  return `${outcome}. ${sim.summary}\nYour XI: ${user}\nAI XI: ${ai}\nPlayer of the match: ${sim.playerOfTheMatch.name} (${sim.playerOfTheMatch.performance})`;
}

function lineup(squad: (PlayerWithStats | null)[]): string {
  return squad.map((p, i) => `${i + 1}. ${p ? `${p.name} (${p.country}, ${p.primary_role})` : "(vacant)"}`).join("; ");
}

/**
 * Returns a short referee report that explains the simulated result, or null when Gemini is
 * unavailable (no key, cooling down, timeout, bad response). Callers must treat null as normal.
 */
export async function generateRefereeReport(
  userSquad: (PlayerWithStats | null)[],
  aiSquad: (PlayerWithStats | null)[],
  challenge: Challenge,
  simulation: MatchSimulationResult,
  apiKey?: string,
  model: string = DEFAULT_GEMINI_MODEL
): Promise<string | null> {
  if (!apiKey || Date.now() < geminiBackoffUntil) return null;

  const moments = simulation.keyMoments
    .slice(0, 5)
    .map((m) => `- Over ${m.over}: ${m.title} (${m.impactTeam === "USER" ? "Your XI" : "AI XI"})`)
    .join("\n");

  const prompt = `You are a cricket match referee writing a short broadcast report.
The match has ALREADY been played and the result below is final. Do not change, question or re-decide it; explain it.

MATCH: ${challenge.format} at ${challenge.venue.name}, ${challenge.venue.country} (${challenge.venue.pitch_type} pitch)
RESULT: ${describeResult(simulation)}
KEY MOMENTS:
${moments || "- (none recorded)"}
YOUR XI: ${lineup(userSquad)}
AI XI: ${lineup(aiSquad)}

Write 3-4 sentences on how the squads, the pitch and the key moments produced this result.
Return JSON: {"verdict_summary": string}`;

  try {
    // Key goes in a header, not the query string, so it never lands in URL logs.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });

    if (res.status === 429) geminiBackoffUntil = Date.now() + GEMINI_RATE_LIMIT_COOLDOWN_MS;
    if (!res.ok) throw new Error(`Gemini API HTTP ${res.status}`);

    const data: any = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error("Empty Gemini response");
    const report = JSON.parse(raw).verdict_summary;
    return typeof report === "string" && report.trim() ? report.trim() : null;
  } catch (err: any) {
    console.warn("[Gemini Referee] Report unavailable, continuing without it:", err.message);
    return null;
  }
}
