import type { DraftState, MatchFormat } from "../../src/core/types";

export type Difficulty = "easy" | "normal" | "hard";

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // fall through to the status check
  }
  if (!res.ok || (data && data.error)) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  start: (format: MatchFormat, difficulty: Difficulty, theme: string) =>
    request<{ roomId: string; theme: string }>("/api/draft/start", { format, difficulty, theme }),
  state: (roomId: string) => request<{ state: DraftState }>(`/api/room/${roomId}/state`),
  pick: (roomId: string, playerId: string) => request<{ state: DraftState }>(`/api/room/${roomId}/pick`, { playerId }),
  reorder: (roomId: string, fromIndex: number, toIndex: number) =>
    request<{ state: DraftState }>(`/api/room/${roomId}/reorder`, { fromIndex, toIndex }),
  play: (roomId: string, plan: { newBall?: string[]; death?: string }) =>
    request<{ state: DraftState }>(`/api/room/${roomId}/start-match`, plan),
};

/** Remembers the current room so a reload resumes the draft. Storage can be unavailable; that's fine. */
export const savedRoom = {
  get(): string | null {
    try {
      return localStorage.getItem("cricket-draft-room");
    } catch {
      return null;
    }
  },
  set(id: string | null) {
    try {
      if (id) localStorage.setItem("cricket-draft-room", id);
      else localStorage.removeItem("cricket-draft-room");
    } catch {
      // ignore
    }
  },
};
