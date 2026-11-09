import { useEffect, useState } from "preact/hooks";
import type { MatchSummary } from "../../../src/core/match-snapshot";
import { api } from "../api";
import { FORMAT_LABEL, PITCH_LABEL, type Mode } from "../format";
import type { MatchFormat } from "../../../src/core/types";

const SHOW = 5;

/** This phone's finished matches, newest first; tap one to see its result again. */
export function MyMatches({ onOpen }: { onOpen: (id: string) => void }) {
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    api
      .matches()
      .then((r) => setMatches(r.matches))
      .catch(() => setMatches([]));
  }, []);
  if (!matches?.length) return null;
  const shown = all ? matches : matches.slice(0, SHOW);
  return (
    <div class="stack" style="gap:8px">
      <div class="label">My matches</div>
      <ul class="mymatches">
        {shown.map((m) => {
          const res = m.winner === "USER" ? "Won" : m.winner === "AI" ? "Lost" : m.winner === "DRAW" ? "Drawn" : "Tied";
          return (
            <li>
              <button type="button" onClick={() => onOpen(m.id)}>
                <span class={`res ${m.winner === "USER" ? "good" : m.winner === "AI" ? "bad" : ""}`}>{res}</span>
                <span class="grow">
                  <b>
                    {m.userScore} <span class="muted">v</span> {m.aiScore}
                  </b>
                  <span class="muted">
                    {FORMAT_LABEL[m.format as Mode] ?? m.format} · {m.venue.split(",")[0]} · {PITCH_LABEL[m.pitch] ?? m.pitch}
                  </span>
                </span>
                <span class="faint when">{new Date(m.playedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {matches.length > SHOW && !all && (
        <button type="button" class="btn btn-block" onClick={() => setAll(true)}>
          Show all {matches.length}
        </button>
      )}
    </div>
  );
}
