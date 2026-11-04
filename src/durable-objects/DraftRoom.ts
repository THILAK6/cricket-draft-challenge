import type { DraftState, PlayerWithStats } from "../core/types";

export class DraftRoom implements DurableObject {
  private state: DurableObjectState;
  private draftState: DraftState | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Load persisted state if not already in memory
    if (!this.draftState) {
      this.draftState = (await this.state.storage.get<DraftState>("draftState")) ?? null;
    }

    if (url.pathname.endsWith("/init") && request.method === "POST") {
      const body = await request.json<DraftState>();
      this.draftState = body;
      await this.state.storage.put("draftState", this.draftState);
      return Response.json({ success: true, state: this.draftState });
    }

    if (url.pathname.endsWith("/state") && request.method === "GET") {
      if (!this.draftState) {
        return Response.json({ error: "Draft not initialized" }, { status: 404 });
      }
      return Response.json({ state: this.draftState });
    }

    if (url.pathname.endsWith("/pick") && request.method === "POST") {
      if (!this.draftState || this.draftState.status !== "DRAFTING") {
        return Response.json({ error: "Draft not in drafting state" }, { status: 400 });
      }

      const { playerId, actor } = await request.json<{ playerId: string; actor: "USER" | "AI" }>();

      if (this.draftState.currentTurn !== actor) {
        return Response.json({ error: `Not ${actor}'s turn` }, { status: 403 });
      }

      const playerIndex = this.draftState.pool.findIndex((p) => p.id === playerId);
      if (playerIndex === -1) {
        return Response.json({ error: "Player not available in pool" }, { status: 400 });
      }

      const [pickedPlayer] = this.draftState.pool.splice(playerIndex, 1);

      if (actor === "USER") {
        this.draftState.userPicks.push(pickedPlayer);
        this.draftState.currentTurn = "AI";
      } else {
        this.draftState.aiPicks.push(pickedPlayer);
        this.draftState.currentTurn = "USER";
        this.draftState.round += 1;
      }

      // Check if draft phase is complete (e.g., each side drafted 6 players, rest chosen solo)
      if (this.draftState.round > this.draftState.maxRounds) {
        this.draftState.status = "SOLO_PICK";
      }

      this.draftState.lastActionTimestamp = Date.now();
      await this.state.storage.put("draftState", this.draftState);

      return Response.json({ success: true, state: this.draftState });
    }

    return new Response("Not found", { status: 404 });
  }
}

