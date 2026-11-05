import type { InningsScorecard } from "../../src/core/simulator";

const bat = (playerId: string, name: string, runs: number, balls: number, isOut: boolean, bowlerId?: string) =>
  ({ playerId, name, runs, balls, fours: 0, sixes: 0, isOut, bowlerId, dismissal: isOut ? "b x" : undefined, strikeRate: 0 });
const bowl = (playerId: string, name: string, overs: string, runs: number, wickets: number) =>
  ({ playerId, name, overs, runs, wickets, maidens: 0, economy: 0 });

/** Scorecard rebuilt from the Gabba ODI report: Your XI 254/10 beat AI XI 59/10 (AI used 125 of 300 balls). */
export const userInnings = {
  teamName: "Your XI", totalRuns: 254, totalWickets: 10, totalBalls: 297, oversString: "49.3", oversCompleted: 49, maxOvers: 50,
  batters: [
    bat("jay", "Jayasuriya", 0, 1, true), bat("sang", "Sangakkara", 38, 40, true), bat("tend", "Tendulkar", 104, 95, true),
    bat("dhon", "Dhoni", 30, 35, true), bat("shak", "Shakib", 25, 25, true), bat("hbj", "Harbhajan", 4, 6, true),
    bat("mcg", "McGrath", 2, 5, true), bat("desi", "de Silva", 1, 5, true), bat("flow", "Flower", 15, 18, true),
    bat("malk", "Malik", 10, 14, true), bat("camp", "Campher", 25, 54, false),
  ],
  bowlers: [], fielders: [], phaseRuns: { powerplay: 50, middle: 150, death: 54 },
} as unknown as InningsScorecard;

export const aiInnings = {
  teamName: "AI XI", totalRuns: 59, totalWickets: 10, totalBalls: 125, oversString: "20.5", oversCompleted: 20, maxOvers: 50,
  batters: [
    bat("a0", "A0", 8, 20, true, "hbj"), bat("a1", "A1", 5, 12, true, "desi"), bat("a2", "A2", 12, 25, true, "malk"),
    bat("a3", "A3", 3, 6, true, "hbj"), bat("a4", "A4", 0, 3, true, "hbj"), bat("a5", "A5", 9, 15, true, "desi"),
    bat("a6", "A6", 7, 10, true, "hbj"), bat("a7", "A7", 6, 12, true, "desi"), bat("a8", "A8", 4, 8, true, "malk"),
    bat("a9", "A9", 2, 5, true, "mcg"), bat("a10", "A10", 3, 9, false),
  ],
  bowlers: [
    bowl("hbj", "Harbhajan", "4.5", 7, 4), bowl("desi", "de Silva", "4.0", 20, 3), bowl("malk", "Malik", "3.0", 11, 2),
    bowl("mcg", "McGrath", "5.0", 12, 1), bowl("flow", "Flower", "4.0", 9, 0),
  ],
  fielders: [], phaseRuns: { powerplay: 20, middle: 39, death: 0 },
} as unknown as InningsScorecard;
