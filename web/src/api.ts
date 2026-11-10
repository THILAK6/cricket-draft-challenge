import type { DraftState, MatchFormat } from "../../src/core/types";
import type { MatchSnapshot, MatchSummary } from "../../src/core/match-snapshot";

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
  start: (format: MatchFormat, difficulty: Difficulty, theme: string, league?: "IPL", auction?: "calculated" | "impulsive") =>
    request<{ roomId: string; theme: string }>("/api/draft/start", { format, difficulty, theme, league, ...(auction ? { draftMode: "auction", auctionStyle: auction } : {}), deviceId: deviceId() }),
  bid: (roomId: string, action: "bid" | "pass") => request<{ state: DraftState }>(`/api/room/${roomId}/bid`, { action }),
  state: (roomId: string) => request<{ state: DraftState }>(`/api/room/${roomId}/state`),
  pick: (roomId: string, playerId: string) => request<{ state: DraftState }>(`/api/room/${roomId}/pick`, { playerId }),
  reorder: (roomId: string, fromIndex: number, toIndex: number) =>
    request<{ state: DraftState }>(`/api/room/${roomId}/reorder`, { fromIndex, toIndex }),
  play: (roomId: string, plan: { newBall?: string[]; death?: string }) =>
    request<{ state: DraftState }>(`/api/room/${roomId}/start-match`, plan),
  matches: () => {
    const id = deviceId();
    return id ? request<{ matches: MatchSummary[] }>(`/api/matches?device=${encodeURIComponent(id)}`) : Promise.resolve({ matches: [] });
  },
  match: (id: string) => request<{ match: MatchSnapshot }>(`/api/match/${encodeURIComponent(id)}`),
};

/** The share link for a saved match. */
export const matchLink = (id: string) => `${location.origin}/?match=${id}`;

/**
 * This phone's anonymous id, made here and kept in the browser: it is how "My matches" knows which
 * matches are yours. No account, nothing personal. Without storage there is no list (sharing still works).
 */
export function deviceId(): string | null {
  try {
    let id = localStorage.getItem("cricket-draft-device");
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("cricket-draft-device", id);
    }
    return id;
  } catch {
    return null;
  }
}

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
