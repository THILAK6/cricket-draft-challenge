import type { Challenge, PlayerWithStats } from "./types";
import { calculateDeterministicScore } from "./scoring";

export interface RefereeEvaluationResult {
  user_score: number;
  ai_score: number;
  user_adjustment: number;
  ai_adjustment: number;
  winner: "USER" | "AI" | "TIE";
  ground_conditions_analysis: string;
  verdict_summary: string;
}

export async function evaluateGroundConditionsWithGemini(
  userSquad: PlayerWithStats[],
  aiSquad: PlayerWithStats[],
  challenge: Challenge,
  apiKey?: string
): Promise<RefereeEvaluationResult> {
  const userBreakdown = calculateDeterministicScore(userSquad, challenge);
  const aiBreakdown = calculateDeterministicScore(aiSquad, challenge);

  // Fallback if no Gemini API key provided
  if (!apiKey) {
    return {
      user_score: userBreakdown.deterministic_total,
      ai_score: aiBreakdown.deterministic_total,
      user_adjustment: 0,
      ai_adjustment: 0,
      winner: userBreakdown.deterministic_total > aiBreakdown.deterministic_total ? "USER" : userBreakdown.deterministic_total < aiBreakdown.deterministic_total ? "AI" : "TIE",
      ground_conditions_analysis: `Match judged on ${challenge.venue.pitch_type} at ${challenge.venue.name} based on core deterministic cricket analytics.`,
      verdict_summary: "Deterministic stats assessment completed. Connect Gemini API for ground and venue history analysis.",
    };
  }

  const prompt = `You are an elite ICC Hall-of-Fame cricket match referee, conditions analyst, and pitch curator.
Evaluate a drafted match between "USER XI" and "AI XI".

MATCH CONTEXT:
- Format: ${challenge.format}
- Venue: ${challenge.venue.name}
- Host Country: ${challenge.venue.country}
- Pitch Condition: ${challenge.venue.pitch_type}
- Match Narrative: ${challenge.narrative_intro}

USER XI:
${userSquad.map((p, i) => `${i + 1}. ${p.name} (${p.country}) - ${p.primary_role}, Bat: ${p.batting_hand}, Bowl: ${p.bowling_category} (${p.bowling_style || "N/A"})`).join("\n")}

AI XI:
${aiSquad.map((p, i) => `${i + 1}. ${p.name} (${p.country}) - ${p.primary_role}, Bat: ${p.batting_hand}, Bowl: ${p.bowling_category} (${p.bowling_style || "N/A"})`).join("\n")}

STATISTICAL BASELINES:
- User Team Baseline: ${userBreakdown.deterministic_total} / 100
- AI Team Baseline: ${aiBreakdown.deterministic_total} / 100

CRITICAL EVALUATION MANDATE:
1. GROUND & VENUE SUITABILITY (HISTORICAL CONDITIONS):
   Evaluate how individual players from each team perform specifically in ${challenge.venue.country} on ${challenge.venue.pitch_type} tracks.
   - Ground familiarity: Consider local country conditions (e.g. Dale Steyn or Kagiso Rabada in South Africa with steep pace and bounce vs James Anderson who historically lacked impact in SA due to missing English swing).
   - Surface dynamics: Assess turning subcontinental dustbowls (e.g. Chennai, Mirpur) vs true bounce decks (Wankhede, Centurion, Perth).
   - Spin liability vs Pace advantage: Heavily punish teams that field excessive spin on green seamers, or lack spinners on crumbling dustbowls.
2. TACTICAL ADJUSTMENTS:
   - Provide an integer adjustment between -10 and +10 for USER XI.
   - Provide an integer adjustment between -10 and +10 for AI XI.
   - Determine the winner ("USER" or "AI").

Return JSON in this exact structure:
{
  "user_adjustment": number (-10 to 10),
  "ai_adjustment": number (-10 to 10),
  "winner": "USER" | "AI",
  "ground_conditions_analysis": string (2-3 sentences explaining how this specific ground and pitch suitability decided individual matchups),
  "verdict_summary": string (3-4 sentences delivering the broadcast referee match report)
}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });

    if (!res.ok) {
      throw new Error(`Gemini API HTTP ${res.status}`);
    }

    const data: any = await res.json();
    const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawJson) throw new Error("Empty Gemini response");

    const parsed = JSON.parse(rawJson);
    const userAdj = Math.max(-10, Math.min(10, Math.round(parsed.user_adjustment || 0)));
    const aiAdj = Math.max(-10, Math.min(10, Math.round(parsed.ai_adjustment || 0)));

    const finalUser = Math.max(0, Math.min(100, userBreakdown.deterministic_total + userAdj));
    const finalAi = Math.max(0, Math.min(100, aiBreakdown.deterministic_total + aiAdj));

    return {
      user_score: finalUser,
      ai_score: finalAi,
      user_adjustment: userAdj,
      ai_adjustment: aiAdj,
      winner: parsed.winner || (finalUser > finalAi ? "USER" : finalUser < finalAi ? "AI" : "TIE"),
      ground_conditions_analysis: parsed.ground_conditions_analysis || "Conditions analysis completed.",
      verdict_summary: parsed.verdict_summary || "Match completed successfully.",
    };
  } catch (err: any) {
    console.warn("[Gemini Referee] Evaluation failed, using deterministic baseline:", err.message);
    return {
      user_score: userBreakdown.deterministic_total,
      ai_score: aiBreakdown.deterministic_total,
      user_adjustment: 0,
      ai_adjustment: 0,
      winner: userBreakdown.deterministic_total > aiBreakdown.deterministic_total ? "USER" : userBreakdown.deterministic_total < aiBreakdown.deterministic_total ? "AI" : "TIE",
      ground_conditions_analysis: `Analyzed for ${challenge.venue.pitch_type} at ${challenge.venue.name}.`,
      verdict_summary: "Baseline score applied. Referee commentary defaulted to factual statistics.",
    };
  }
}
