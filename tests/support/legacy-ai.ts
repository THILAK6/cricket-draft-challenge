// Verbatim copy of the AI pick as it stood in DraftRoom.executeAiPick before the rewrite (baseline for comparison).
import { canPickPlayer, type PickContext } from "../../src/core/validator";
import type { DraftState, PlayerWithStats } from "../../src/core/types";
import { legacyPlayerQuality } from "./legacy-quality";

export const LEGACY_STATS = { fallback: 0, spinnerPenaltyEvals: 0, spinnerPenaltyOnAR: 0 };

export class LegacyAi {
  constructor(public draftState: DraftState) {}
  poolContext(squad: (PlayerWithStats | null)[]): PickContext {
    const state = this.draftState;
    const opponentSquad = squad === state.aiPicks ? state.userPicks : state.aiPicks;
    return { pool: state.pool, opponentSquad };
  }
    executeAiPick() {
    if (!this.draftState || this.draftState.pool.length === 0) return;

    const squad = this.draftState.aiPicks;
    const challenge = this.draftState.challenge;
    const pitchType = challenge.venue.pitch_type;
    const format = challenge.format || "T20";
    const isTest = format === "TEST";
    const isOdi = format === "ODI";
    const isT20 = format === "T20";

    // Find all vacant slots
    const emptyIndices: number[] = [];
    for (let i = 0; i < 11; i++) {
      if (squad[i] === null) emptyIndices.push(i);
    }
    if (emptyIndices.length === 0) return;

    const nonNullAi = squad.filter((p): p is PlayerWithStats => p !== null);
    const hasKeeper = nonNullAi.some((p) => p.primary_role === "WK");
    const spinnerCount = nonNullAi.filter((p) => p.bowling_category === "SPIN").length;
    const pacerCount = nonNullAi.filter((p) => p.bowling_category === "PACE").length;
    const bowlingOptionsCount = nonNullAi.filter(
      (p) => p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0
    ).length;
    const openerCount = (squad[0] ? 1 : 0) + (squad[1] ? 1 : 0);

    // Strict Pitch Quotas:
    // Flat & Green tracks: Max 1 spinner in the entire XI!
    const disallowMoreSpinners =
      (pitchType === "HIGH_SCORING_FLAT" || pitchType === "GREEN_SEAMER") && spinnerCount >= 1;

    // Analyze User's Latest Draft Action for Counter-Sniping
    const userNonNull = this.draftState.userPicks.filter((p): p is PlayerWithStats => p !== null);
    const lastUserPick = userNonNull.length > 0 ? userNonNull[userNonNull.length - 1] : null;
    const userHasKeeper = userNonNull.some((p) => p.primary_role === "WK");
    const userBowlersCount = userNonNull.filter((p) => p.primary_role === "BOWL" || p.primary_role === "AR").length;

    // Evaluate every legal (candidate, slot) combination
    interface ScoredPair {
      player: PlayerWithStats;
      slotIndex: number;
      score: number;
      reason: string;
    }

    const candidatePairs: ScoredPair[] = [];

    // Stats-only quality for every available player. "Stars" are simply the top tier of what is
    // left in the pool, so the AI recognises elite players from their numbers, not their names.
    const qualityMap = new Map<string, number>();
    for (const q of this.draftState.pool) qualityMap.set(q.id, legacyPlayerQuality(q, format));
    const percentile = (values: number[], pct: number) => {
      if (values.length === 0) return Infinity;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(pct * sorted.length))];
    };
    const difficulty = this.draftState.difficulty ?? "normal";
    // Easy mode blurs the AI's read of the board with deterministic per-pick noise (no extra randomness source).
    if (difficulty === "easy") {
      const spread = Math.max(...qualityMap.values()) - Math.min(...qualityMap.values());
      let h = this.draftState.round * 2654435761;
      for (const [id, q] of qualityMap) {
        h = Math.imul(h ^ id.split("").reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7), 2246822519) >>> 0;
        qualityMap.set(id, q + ((h % 1000) / 1000 - 0.5) * spread * 1.6);
      }
    }
    const starCut = percentile([...qualityMap.values()], 0.85);
    const keeperStarCut = percentile(
      this.draftState.pool.filter((q) => q.primary_role === "WK").map((q) => qualityMap.get(q.id) ?? 0),
      0.5
    );

    for (const p of this.draftState.pool) {
      const isPacer = p.bowling_category === "PACE";
      const isSpinner = p.bowling_category === "SPIN";
      const isWK = p.primary_role === "WK";
      const isAR = p.primary_role === "AR";
      const isBat = p.primary_role === "BAT";
      const isBowl = p.primary_role === "BOWL";
      const matches = Math.max(1, p.stats.matches);

      // Pitch preference (soft): a second spinner on a flat or green track is unattractive, not illegal
      const spinnerPenalty = disallowMoreSpinners && isSpinner ? -80 : 0;
      if (spinnerPenalty) { LEGACY_STATS.spinnerPenaltyEvals++; if (isAR) LEGACY_STATS.spinnerPenaltyOnAR++; }

      const quality = qualityMap.get(p.id) ?? 0;

      // Pitch Synergy
      let pitchBonus = 0;
      if (pitchType === "GREEN_SEAMER" && isPacer) {
        pitchBonus += isTest ? 55 : 40; // Seamers rule green tops
      } else if (pitchType === "DUSTBOWL" && isSpinner) {
        pitchBonus += isTest ? 60 : 45; // Spinners dominate turners
      } else if (pitchType === "SLOW_LOW" && isSpinner) {
        pitchBonus += 35;
      } else if (pitchType === "HIGH_SCORING_FLAT") {
        if (isPacer && p.stats.bowl_economy > 0 && p.stats.bowl_economy <= (isT20 ? 7.6 : 5.0)) pitchBonus += 35;
        if (isBat && p.stats.bat_strike_rate >= (isT20 ? 140 : 95)) pitchBonus += 30;
      }

      // Test each vacant slot for positional legality and tactical fit
      for (const slotIdx of emptyIndices) {
        const legalCheck = canPickPlayer(p, squad, challenge, slotIdx); // cheap screen; pool reserve is checked on the chosen pair
        if (!legalCheck.allowed) continue;

        let slotFit = 0;

        if (slotIdx === 0 || slotIdx === 1) {
          // OPENERS
          const isTrueOpener =
            p.stats.top_order_innings >= 8 ||
            (p.stats.bat_innings >= 5 && p.stats.top_order_innings / Math.max(1, p.stats.bat_innings) >= 0.35);

          const isMiddleAnchorOrFinisher =
            p.stats.finisher_innings >= 4 ||
            (p.stats.middle_order_innings >= 12 && p.stats.top_order_innings < 6);

          if (isBowl) {
            slotFit -= 1500;
          } else if (isMiddleAnchorOrFinisher) {
            // Middle-order anchors and finishers (judged by innings played in those roles) must not open
            slotFit -= 1200;
          } else if (isTrueOpener && (isBat || isWK)) {
            slotFit += 80;
          } else if (isBat && p.stats.top_order_innings >= 3) {
            slotFit += 30;
          } else {
            slotFit -= 600; // Finishers/tailenders penalized
          }
        } else if (slotIdx === 2) {
          // #3 ANCHOR
          if (isBowl) {
            slotFit -= 1500;
          } else if (p.stats.bat_average >= (isTest ? 42.0 : 38.0) && (isBat || isWK)) {
            slotFit += 55;
          } else if (isBat || isWK) {
            slotFit += 30;
          } else {
            slotFit -= 350;
          }
        } else if (slotIdx === 3 || slotIdx === 4) {
          // MIDDLE ORDER (4 & 5)
          if (isBowl) {
            slotFit -= 1000;
          } else if (isBat || isWK || isAR) {
            slotFit += 50;
            if (p.stats.middle_order_innings >= 8) slotFit += 15;
          }
        } else if (slotIdx === 5 || slotIdx === 6) {
          // SLOTS 6 & 7: FORMAT SPECIFIC
          if (isTest) {
            // In Tests: all-rounders or a solid keeper-batter
            if (isAR) slotFit += 65;
            else if (isWK) slotFit += 60;
            else if (isBat && p.stats.bat_average >= 32.0) slotFit += 45;
            else slotFit -= 150;
          } else {
            // In T20 / ODI: Explosive Finishers
            if (p.stats.finisher_innings >= 5) {
              slotFit += 160; // Proven finishers (by innings played in that role) belong in Slots #6 and #7
            } else if (isAR) {
              slotFit += 60;
            } else if (p.stats.bat_strike_rate >= (isT20 ? 140 : 100)) {
              slotFit += 50;
            } else if (isWK) {
              slotFit += 45;
            } else if (isBat) {
              slotFit += 25;
            } else {
              slotFit -= 200;
            }
          }
        } else if (slotIdx === 7) {
          // LOWER ORDER / BOWLING AR (Slot 8)
          if (isAR) slotFit += 60;
          else if (isBowl && p.stats.bat_average >= 14.0) slotFit += 55;
          else if (isBowl) slotFit += 40;
          else slotFit -= 150;
        } else {
          // FRONTLINE BOWLERS (Slots 8, 9, 10 - #9, 10, 11)
          if (isBowl || isAR) {
            slotFit += 60;
            // Spearheads into slot 9/10
            if (p.stats.bowl_wickets >= (isTest ? 60 : 40)) slotFit += 20;
          } else {
            slotFit -= 2000; // Never pick pure batter at #9-11
          }
        }

        // Squad Need Urgency
        let urgency = 0;
        if (!hasKeeper && isWK) {
          urgency += emptyIndices.length <= 4 ? 200 : 80;
        }
        if (bowlingOptionsCount < 5 && (isBowl || isAR)) {
          urgency += emptyIndices.length <= 5 ? 160 : 70;
        }
        const isTrueOpenerCandidate =
          p.stats.top_order_innings >= 8 ||
          (p.stats.bat_innings >= 5 && p.stats.top_order_innings / Math.max(1, p.stats.bat_innings) >= 0.35);

        if (openerCount < 2 && (slotIdx === 0 || slotIdx === 1) && isTrueOpenerCandidate) {
          urgency += emptyIndices.length <= 4 ? 120 : 50;
        }

        // Strategic Counter-Sniping & Rival Anticipation
        let counterSnipeBonus = 0;
        let snipeReason = "";

        const isStar = quality >= starCut;
        const starTag = isStar ? "star " : "";
        if (lastUserPick) {
          // 1. Core denial: same country as the user's latest pick (stronger for true stars)
          if (p.country === lastUserPick.country) {
            counterSnipeBonus += isStar ? 110 : 40;
            snipeReason = isStar
              ? `AI took ${starTag}${p.name} so you can't build a ${p.country} core around ${lastUserPick.name}!`
              : `AI picked ${p.name} to limit your ${p.country} combinations.`;
          }

          // 2. Role rivalry: user took a batter/keeper -> AI takes a genuine strike bowler
          if (
            (lastUserPick.primary_role === "BAT" || lastUserPick.primary_role === "WK") &&
            isBowl &&
            (p.stats.bowl_wickets >= 30 || (p.stats.bowl_economy > 0 && p.stats.bowl_economy <= 5.2))
          ) {
            counterSnipeBonus += 90;
            if (!snipeReason) snipeReason = `AI took strike bowler ${p.name} to answer ${lastUserPick.name}.`;
          }

          // 3. Keeper starvation: user has no keeper yet, AI takes a top-half keeper
          if (!userHasKeeper && isWK && quality >= keeperStarCut) {
            counterSnipeBonus += 100;
            snipeReason = `AI took top wicketkeeper ${p.name} while you still need a keeper!`;
          }

          // 4. Bowling starvation: user is short of bowlers
          if (userBowlersCount < 3 && userNonNull.length >= 6 && isBowl) {
            counterSnipeBonus += 70;
            if (!snipeReason) snipeReason = `AI took ${p.name} while you are still short of bowlers.`;
          }
        } else if (isStar) {
          // Opening move: grab the best available player by the numbers
          counterSnipeBonus += 100;
          snipeReason = `AI opened by taking ${starTag}${p.name}, the strongest player on the board.`;
        }

        // Hard: pure best-value drafting. Counter-sniping spends picks on denial, which costs team quality.
        if (difficulty === "hard") counterSnipeBonus = 0;
        const totalScore = quality + pitchBonus + slotFit + urgency + counterSnipeBonus + spinnerPenalty;
        candidatePairs.push({
          player: p,
          slotIndex: slotIdx,
          score: totalScore,
          reason: snipeReason || `AI strategically secured ${p.name} for Slot #${slotIdx + 1}.`,
        });
      }
    }

    // Best-scoring pair that also keeps the shared pool completable for both squads
    candidatePairs.sort((a, b) => b.score - a.score);
    const poolCtx = this.poolContext(squad);
    const best = candidatePairs.find(
      (c) => canPickPlayer(c.player, squad, challenge, c.slotIndex, poolCtx).allowed
    );

    if (!best) {
      LEGACY_STATS.fallback++;
      // Fallback: pick first legal player into first empty slot
      const fallbackSlot = emptyIndices[0];
      const legal = this.draftState.pool.filter(
        (p) => canPickPlayer(p, squad, challenge, fallbackSlot, this.poolContext(squad)).allowed
      );
      const chosen = legal.length > 0 ? legal[0] : this.draftState.pool[0];
      const pIdx = this.draftState.pool.findIndex((p) => p.id === chosen.id);
      if (pIdx !== -1) {
        const [picked] = this.draftState.pool.splice(pIdx, 1);
        squad[fallbackSlot] = picked;
        this.draftState.lastAiSnipe = {
          player: picked,
          slotIndex: fallbackSlot,
          reason: `AI picked ${picked.name} into Slot #${fallbackSlot + 1}.`,
        };
        this.draftState.currentTurn = "USER";
        this.draftState.round += 1;
        this.draftState.lastActionTimestamp = Date.now();
      }
      return;
    }

    const pIdx = this.draftState.pool.findIndex((p) => p.id === best.player.id);
    if (pIdx !== -1) {
      const [picked] = this.draftState.pool.splice(pIdx, 1);
      squad[best.slotIndex] = picked;
      this.draftState.lastAiSnipe = {
        player: picked,
        slotIndex: best.slotIndex,
        reason: best.reason,
      };
      this.draftState.currentTurn = "USER";
      this.draftState.round += 1;
      this.draftState.lastActionTimestamp = Date.now();
    }
  }

}
