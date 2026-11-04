import type { Challenge, DraftState, PlayerWithStats, ScoringBreakdown } from "../core/types";
import { validateSquad, canPickPlayer } from "../core/validator";
import { calculateDeterministicScore, applyBoundedAdjustment } from "../core/scoring";
import { evaluateGroundConditionsWithGemini } from "../core/gemini-referee";

export class DraftRoom implements DurableObject {
  private state: DurableObjectState;
  private env: any;
  private draftState: DraftState | null = null;
  private sockets: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Load persisted state if not in memory
    if (!this.draftState) {
      this.draftState = (await this.state.storage.get<DraftState>("draftState")) ?? null;
    }

    if (url.pathname.endsWith("/init") && request.method === "POST") {
      const body = await request.json<DraftState>();
      this.draftState = body;
      await this.state.storage.put("draftState", this.draftState);
      this.broadcast({ type: "INIT", state: this.draftState });
      return Response.json({ success: true, state: this.draftState });
    }

    if (url.pathname.endsWith("/state") && request.method === "GET") {
      if (!this.draftState) {
        return Response.json({ error: "Draft room not initialized" }, { status: 404 });
      }
      return Response.json({ state: this.draftState });
    }

    if (url.pathname.endsWith("/pick") && request.method === "POST") {
      if (!this.draftState || this.draftState.status !== "DRAFTING") {
        return Response.json({ error: "Draft not in drafting state" }, { status: 400 });
      }

      const { playerId } = await request.json<{ playerId: string }>();

      if (this.draftState.currentTurn !== "USER") {
        return Response.json({ error: "Not user turn" }, { status: 403 });
      }

      const userPickResult = this.executePick(playerId, "USER");
      if (!userPickResult.success) {
        return Response.json({ error: userPickResult.error }, { status: 400 });
      }

      // Check if draft complete
      if (this.draftState.userPicks.length >= 11 && this.draftState.aiPicks.length >= 11) {
        await this.finishDraft();
      } else {
        // Trigger AI Pick
        this.executeAiPick();
        if (this.draftState.userPicks.length >= 11 && this.draftState.aiPicks.length >= 11) {
          await this.finishDraft();
        }
      }

      await this.state.storage.put("draftState", this.draftState);
      this.broadcast({ type: "UPDATE", state: this.draftState });

      return Response.json({ success: true, state: this.draftState });
    }

    if (url.pathname.endsWith("/referee") && request.method === "POST") {
      if (!this.draftState) {
        return Response.json({ error: "Draft room not initialized" }, { status: 400 });
      }

      const apiKey = this.env?.GEMINI_API_KEY;
      const evaluation = await evaluateGroundConditionsWithGemini(
        this.draftState.userPicks,
        this.draftState.aiPicks,
        this.draftState.challenge,
        apiKey
      );

      const userBreakdown = calculateDeterministicScore(this.draftState.userPicks, this.draftState.challenge);
      const aiBreakdown = calculateDeterministicScore(this.draftState.aiPicks, this.draftState.challenge);

      const results = {
        userScore: evaluation.user_score,
        aiScore: evaluation.ai_score,
        userAdjustment: evaluation.user_adjustment,
        aiAdjustment: evaluation.ai_adjustment,
        winner: evaluation.winner,
        groundConditionsAnalysis: evaluation.ground_conditions_analysis,
        verdictSummary: evaluation.verdict_summary,
        userBreakdown,
        aiBreakdown,
      };

      (this.draftState as any).results = results;
      await this.state.storage.put("draftState", this.draftState);
      this.broadcast({ type: "COMPLETED", results });

      return Response.json({ success: true, results });
    }

    if (url.pathname.endsWith("/remove") && request.method === "POST") {
      if (!this.draftState) {
        return Response.json({ error: "Draft room not initialized" }, { status: 400 });
      }

      const { playerId } = await request.json<{ playerId: string }>();

      const pIdx = this.draftState.userPicks.findIndex((p) => p.id === playerId);
      if (pIdx === -1) {
        return Response.json({ error: "Player not found in your squad" }, { status: 400 });
      }

      // Return player to available pool
      const [removed] = this.draftState.userPicks.splice(pIdx, 1);
      this.draftState.pool.unshift(removed);

      // Revert from completed state if necessary
      if (this.draftState.status === "COMPLETED") {
        this.draftState.status = "DRAFTING";
      }

      // Set turn back to user so they can pick their replacement
      this.draftState.currentTurn = "USER";
      this.draftState.lastActionTimestamp = Date.now();

      await this.state.storage.put("draftState", this.draftState);
      this.broadcast({ type: "UPDATE", state: this.draftState });

      return Response.json({ success: true, state: this.draftState });
    }

    return new Response("Not found", { status: 404 });
  }

  private handleWebSocket(ws: WebSocket) {
    ws.accept();
    this.sockets.add(ws);

    if (this.draftState) {
      ws.send(JSON.stringify({ type: "SYNC", state: this.draftState }));
    }

    ws.addEventListener("close", () => {
      this.sockets.delete(ws);
    });

    ws.addEventListener("message", async (msg) => {
      try {
        const data = JSON.parse(msg.data as string);
        if (data.type === "PICK" && this.draftState?.currentTurn === "USER") {
          this.executePick(data.playerId, "USER");
          if (this.draftState.userPicks.length >= 11 && this.draftState.aiPicks.length >= 11) {
            this.finishDraft();
          } else {
            this.executeAiPick();
          }
          await this.state.storage.put("draftState", this.draftState);
          this.broadcast({ type: "UPDATE", state: this.draftState });
        }
      } catch (err) {
        // ignore malformed socket payload
      }
    });
  }

  private broadcast(message: any) {
    const raw = JSON.stringify(message);
    for (const ws of this.sockets) {
      try {
        ws.send(raw);
      } catch (e) {
        this.sockets.delete(ws);
      }
    }
  }

  private executePick(playerId: string, actor: "USER" | "AI"): { success: boolean; error?: string } {
    if (!this.draftState) return { success: false, error: "No state" };

    const pIdx = this.draftState.pool.findIndex((p) => p.id === playerId);
    if (pIdx === -1) {
      return { success: false, error: "Player not in available pool" };
    }

    const candidate = this.draftState.pool[pIdx];
    const currentSquad = actor === "USER" ? this.draftState.userPicks : this.draftState.aiPicks;

    const check = canPickPlayer(candidate, currentSquad, this.draftState.challenge);
    if (!check.allowed) {
      return { success: false, error: check.reason || "Illegal pick" };
    }

    const [picked] = this.draftState.pool.splice(pIdx, 1);

    if (actor === "USER") {
      this.draftState.userPicks.push(picked);
      this.draftState.currentTurn = "AI";
    } else {
      this.draftState.aiPicks.push(picked);
      this.draftState.currentTurn = "USER";
      this.draftState.round += 1;
    }

    this.draftState.lastActionTimestamp = Date.now();
    return { success: true };
  }

  /**
   * AI Draft Logic: picks intelligently according to challenge conditions and missing slots.
   */
  private executeAiPick() {
    if (!this.draftState || this.draftState.pool.length === 0) return;

    const squad = this.draftState.aiPicks;
    const challenge = this.draftState.challenge;

    // Filter strictly to legal candidates
    const legalCandidates = this.draftState.pool.filter(
      (p) => canPickPlayer(p, squad, challenge).allowed
    );

    const candidatesToScore = legalCandidates.length > 0 ? legalCandidates : this.draftState.pool;

    // Check needed roles
    const needsKeeper = squad.length >= 8 && !squad.some((p) => p.primary_role === "WK");
    const needsBowlers = squad.filter((p) => p.primary_role === "BOWL" || p.primary_role === "AR").length < 4;

    // Candidate ranking
    const scoredCandidates = candidatesToScore.map((p) => {
      let weight = p.stats.bat_average * 0.4 + (p.stats.bat_strike_rate / 130) * 20;
      if (p.primary_role === "BOWL" || p.primary_role === "AR") {
        weight += (7.5 / Math.max(5.5, p.stats.bowl_economy || 8)) * 30 + (p.stats.bowl_wickets / Math.max(1, p.stats.matches)) * 15;
      }

      // Priority boosts
      if (needsKeeper && p.primary_role === "WK") weight += 50;
      if (needsBowlers && (p.primary_role === "BOWL" || p.primary_role === "AR")) weight += 30;

      // Pitch match bonus
      if (challenge.venue.pitch_type === "DUSTBOWL" && p.bowling_category === "SPIN") weight += 20;
      if (challenge.venue.pitch_type === "GREEN_SEAMER" && p.bowling_category === "PACE") weight += 20;

      return { player: p, weight };
    });

    scoredCandidates.sort((a, b) => b.weight - a.weight);

    // Pick top legal candidate
    const topPick = scoredCandidates[0]?.player || candidatesToScore[0];
    this.executePick(topPick.id, "AI");
  }

  private async finishDraft() {
    if (!this.draftState) return;

    this.draftState.status = "COMPLETED";

    // Compute base deterministic scores
    const userBreakdown = calculateDeterministicScore(this.draftState.userPicks, this.draftState.challenge);
    const aiBreakdown = calculateDeterministicScore(this.draftState.aiPicks, this.draftState.challenge);

    // Call Gemini for Ground Conditions & Historical Venue Suitability
    const apiKey = this.env?.GEMINI_API_KEY;
    const evaluation = await evaluateGroundConditionsWithGemini(
      this.draftState.userPicks,
      this.draftState.aiPicks,
      this.draftState.challenge,
      apiKey
    );

    const completedResults = {
      userScore: evaluation.user_score,
      aiScore: evaluation.ai_score,
      userAdjustment: evaluation.user_adjustment,
      aiAdjustment: evaluation.ai_adjustment,
      winner: evaluation.winner,
      groundConditionsAnalysis: evaluation.ground_conditions_analysis,
      verdictSummary: evaluation.verdict_summary,
      userBreakdown,
      aiBreakdown,
    };

    (this.draftState as any).results = completedResults;

    await this.state.storage.put("draftState", this.draftState);
    this.broadcast({
      type: "COMPLETED",
      results: completedResults,
    });
  }
}
