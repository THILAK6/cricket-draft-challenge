import { useState } from "preact/hooks";
import { api } from "../api";
import { keyStats, PITCH_LABEL, ROLE_SHORT, roleKey, shortName, type Player } from "../format";
import { XIList, type RoomProps } from "./Draft";
import { PlayerSheet } from "./PlayerSheet";

/** Between the draft and the match: set the batting order and (optionally) the bowling plan. */
export function Lineup(props: RoomProps) {
  const { state } = props;
  const format = state.challenge.format;
  const [busy, setBusy] = useState(false);
  const [newBall, setNewBall] = useState<[string, string]>(["", ""]);
  const [death, setDeath] = useState("");
  const [open, setOpen] = useState<Player | null>(null);
  const [view, setView] = useState<"you" | "ai">("you");
  const squad = state.userPicks;

  const move = async (from: number, to: number) => {
    if (to < 0 || to > 10 || busy) return;
    // Show the move straight away; the server's copy replaces it
    const optimistic = squad.slice();
    const [m] = optimistic.splice(from, 1);
    optimistic.splice(to, 0, m);
    props.onState({ ...state, userPicks: optimistic });
    try {
      const { state: next } = await api.reorder(props.roomId, from, to);
      props.onState(next);
    } catch (e) {
      props.onState(state);
      props.toast((e as Error).message, "error");
    }
  };

  const bowlers = squad.filter((p): p is Player => !!p && p.primary_role !== "WK" && (p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2));

  const play = async () => {
    setBusy(true);
    try {
      const plan = { newBall: newBall.filter(Boolean), death: death || undefined };
      const { state: next } = await api.play(props.roomId, plan);
      props.onState(next);
      window.scrollTo(0, 0);
    } catch (e) {
      props.toast((e as Error).message, "error");
      setBusy(false);
    }
  };

  const select = (value: string, onChange: (v: string) => void, exclude: string[] = []) => (
    <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
      <option value="">Auto</option>
      {bowlers
        .filter((b) => !exclude.includes(b.id) || b.id === value)
        .map((b) => (
          <option value={b.id}>
            {shortName(b)} · {ROLE_SHORT[roleKey(b)]}
          </option>
        ))}
    </select>
  );

  return (
    <div class="lineup">
      <div class="topbar">
        <div class="row">
          <span class="title grow ellipsis">{state.challenge.title}</span>
          <span class="pitch">{PITCH_LABEL[state.challenge.venue.pitch_type]}</span>
        </div>
        <div class="turn">
          <span class="who good">Draft complete</span>
          <span class="muted">Set your batting order, then play.</span>
        </div>
      </div>

      <div class="tabs2" style="margin:12px 16px 0">
        <button type="button" class={view === "you" ? "on" : ""} onClick={() => setView("you")}>
          Your batting order
        </button>
        <button type="button" class={view === "ai" ? "on" : ""} onClick={() => setView("ai")}>
          AI XI
        </button>
      </div>

      {view === "you" ? (
        <div class="xi" style="margin-top:6px">
          {squad.map((p, i) =>
            p ? (
              <div class="xrow">
                <span class="num">{i + 1}</span>
                <button type="button" class="who" style="background:none;border:0;padding:0;text-align:left" onClick={() => setOpen(p)}>
                  <b class="ellipsis" style="display:block">{shortName(p, 24)}</b>
                  <span class="sub">
                    <span class={`role role-${roleKey(p)}`}>{ROLE_SHORT[roleKey(p)]}</span> {keyStats(p, format)}
                  </span>
                </button>
                <span class="move">
                  <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${p.name} up`}>
                    ↑
                  </button>
                  <button type="button" onClick={() => move(i, i + 1)} disabled={i === 10} aria-label={`Move ${p.name} down`}>
                    ↓
                  </button>
                </span>
              </div>
            ) : null
          )}
        </div>
      ) : (
        <div style="margin-top:6px">
          <XIList squad={state.aiPicks} format={format} onOpen={setOpen} />
        </div>
      )}

      <details class="box">
        <summary>Bowling plan (optional)</summary>
        <div class="inner">
          <p class="muted" style="font-size:13px">Leave it on Auto and your captain picks from the conditions.</p>
          <div class="two">
            <label class="field">
              New ball
              {select(newBall[0], (v) => setNewBall([v, newBall[1]]), [newBall[1]])}
            </label>
            <label class="field">
              Other end
              {select(newBall[1], (v) => setNewBall([newBall[0], v]), [newBall[0]])}
            </label>
          </div>
          <label class="field">
            Death overs
            {select(death, setDeath)}
          </label>
        </div>
      </details>

      <div class="sticky-cta">
        <button type="button" class="btn btn-primary" disabled={busy} onClick={play}>
          {busy ? "Playing the match…" : "Play the match"}
        </button>
      </div>

      {open && <PlayerSheet player={open} format={format} canDraft={false} onClose={() => setOpen(null)} />}
    </div>
  );
}
