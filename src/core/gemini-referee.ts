import type { Challenge, PlayerWithStats } from "./types";
import { calculateDeterministicScore } from "./scoring";

export interface RefereeEvaluationResult {
  user_score: number;
  ai_score: number;
  user_adjustment: number;
  ai_adjustment: number;
  winner: "USER" | "AI" | "TIE";
  decisive_difference: string;
  why_winner_won: string[];
  why_loser_lost: string[];
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

  const fallbackWinner =
    userBreakdown.deterministic_total > aiBreakdown.deterministic_total
      ? "USER"
      : userBreakdown.deterministic_total < aiBreakdown.deterministic_total
      ? "AI"
      : "TIE";

  // Fallback if no Gemini API key provided
  if (!apiKey) {
    return {
      user_score: userBreakdown.deterministic_total,
      ai_score: aiBreakdown.deterministic_total,
      user_adjustment: 0,
      ai_adjustment: 0,
      winner: fallbackWinner,
      decisive_difference: `Statistical baseline differential on ${challenge.venue.pitch_type} surface determined the winner.`,
      why_winner_won: [
        "Superior aggregate player career averages and strike rates.",
        "Better role balance matching standard T20 requirements.",
        "Higher batting depth in the lower order.",
      ],
      why_loser_lost: [
        "Lower aggregate bowling economy and strike rates.",
        "Lacking optimal pitch suitability for this venue.",
        "Thin lower-order batting capacity under pressure.",
      ],
      ground_conditions_analysis: `Match played on ${challenge.venue.pitch_type} at ${challenge.venue.name} (${challenge.venue.country}). Baseline statistical models evaluated player roles and batting depth.`,
      verdict_summary: "Deterministic analytics determined the outcome. Add Gemini API key for in-depth conditions and player venue history analysis.",
    };
  }

  const slotNames = [
    "Opener (Slot 1)",
    "Opener (Slot 2)",
    "Top Order Anchor (Slot 3)",
    "Middle Order (Slot 4)",
    "Middle Order (Slot 5)",
    "Finisher / AR (Slot 6)",
    "Finisher / AR (Slot 7)",
    "Lower Order / Bowling AR (Slot 8)",
    "Bowler (Slot 9)",
    "Bowler (Slot 10)",
    "Bowler (Slot 11)",
  ];

  function formatSquadLineup(squad: PlayerWithStats[]) {
    return squad
      .map((p, i) => {
        const slot = slotNames[i] || `Position ${i + 1}`;
        const caps = `${p.stats.matches} caps`;
        const batInfo = `Avg ${p.stats.bat_average}, SR ${p.stats.bat_strike_rate}`;
        const bowlInfo =
          p.stats.bowl_overs > 0
            ? ` | Bowl: ${p.stats.bowl_wickets} wkts, Econ ${p.stats.bowl_economy}`
            : "";
        return `${i + 1}. [${slot}] ${p.name} (${p.country}) - ${p.primary_role} (${caps}) | Bat: ${p.batting_hand} (${batInfo})${bowlInfo}`;
      })
      .join("\n");
  }

  const prompt = `You are an elite ICC Hall-of-Fame cricket match referee, conditions analyst, and pitch curator.
Evaluate a drafted match between "USER XI" and "AI XI".

MATCH CONTEXT:
- Format: ${challenge.format}
- Venue: ${challenge.venue.name}
- Host Country: ${challenge.venue.country}
- Pitch Condition: ${challenge.venue.pitch_type}
- Match Narrative: ${challenge.narrative_intro}

USER XI (BATTING ORDER 1 TO 11):
${formatSquadLineup(userSquad)}

AI XI (BATTING ORDER 1 TO 11):
${formatSquadLineup(aiSquad)}

STATISTICAL BASELINES:
- User Team Baseline: ${userBreakdown.deterministic_total} / 100
- AI Team Baseline: ${aiBreakdown.deterministic_total} / 100

CRITICAL EVALUATION MANDATE:
1. BATTING ORDER & POSITIONAL FIT (SLOTS 1 TO 11):
   - Evaluate the exact batting positions chosen by each team.
   - Slots 1-2: Did they pick proven openers? Heavily penalize putting a tailender or pure bowler in the top order.
   - Slots 3-4: Are there solid anchors capable of stabilizing the innings?
   - Slots 5-7 (FINISHERS): Did they select genuine death-overs finishers with high strike rates (140+) or proven finishing experience? If a team selected NO FINISHERS in slots 5-7, punish them severely for stalling in overs 16-20.
2. EXPERIENCE WEIGHTING (MATCHES PLAYED):
   - Weigh proven international longevity: 100+ and 60+ cap veterans (e.g. Rohit, Kohli, Warner, Bumrah) possess battle-tested temperament under pressure.
   - Treat small sample sizes (under 15 matches) with skepticism—a player with 6 matches and high average cannot outperform an established world champion.
3. GROUND & VENUE SUITABILITY (HISTORICAL CONDITIONS):
   Evaluate how individual players from each team perform specifically in ${challenge.venue.country} on ${challenge.venue.pitch_type} tracks.
   - Ground familiarity: Consider local country conditions (e.g. Dale Steyn or Kagiso Rabada in South Africa with steep pace and bounce vs James Anderson who historically lacked impact in SA due to missing English swing).
   - Surface dynamics: Assess turning subcontinental dustbowls (e.g. Chennai, Mirpur) vs true bounce decks (Wankhede, Centurion, Perth).
   - Spin liability vs Pace advantage: Heavily punish teams that field excessive spin on green seamers, or lack spinners on crumbling dustbowls.
4. TACTICAL FACTORS:
   - Identify what made the decisive difference between the two squads.
   - Detail exactly why the winning team won (2-3 concrete bullet points).
   - Detail exactly why the losing team lost (2-3 concrete bullet points).
5. TACTICAL ADJUSTMENTS:
   - Provide an integer adjustment between -10 and +10 for USER XI.
   - Provide an integer adjustment between -10 and +10 for AI XI.
   - Determine the winner ("USER" or "AI").

Return JSON in this exact structure:
{
  "user_adjustment": number (-10 to 10),
  "ai_adjustment": number (-10 to 10),
  "winner": "USER" | "AI",
  "decisive_difference": string (1-2 sentences capturing the single biggest factor that decided the match),
  "why_winner_won": [string, string, string],
  "why_loser_lost": [string, string, string],
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
      decisive_difference: parsed.decisive_difference || "Tactical condition fit decided the outcome.",
      why_winner_won: Array.isArray(parsed.why_winner_won) ? parsed.why_winner_won : ["Better condition adaptation."],
      why_loser_lost: Array.isArray(parsed.why_loser_lost) ? parsed.why_loser_lost : ["Sub-optimal team balance for pitch."],
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
      winner: fallbackWinner,
      decisive_difference: `Statistical baseline differential on ${challenge.venue.pitch_type} surface determined the winner.`,
      why_winner_won: [
        "Stronger overall statistical ratings across core batting and bowling roles.",
        "Higher batting depth across lower-order positions.",
      ],
      why_loser_lost: [
        "Lower aggregate bowling economy and strike rates in key overs.",
        "Lacking bowling firepower tailored for this pitch type.",
      ],
      ground_conditions_analysis: `Analyzed for ${challenge.venue.pitch_type} at ${challenge.venue.name}.`,
      verdict_summary: "Baseline score applied. Referee commentary defaulted to factual statistics.",
    };
  }
}
