import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { keyStats, PITCH_LABEL, ROLE_SHORT, roleKey, shortName, type Player } from "../format";
import { XIList, type RoomProps } from "./Draft";
import { PlayerSheet } from "./PlayerSheet";

/** Between the draft and the match: set the batting order and (optionally) the bowling plan. */
export function Lineup(props: RoomProps) {
  const { state } = props;
  const format = state.challenge.format;
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Player | null>(null);
  const [view, setView] = useState<"you" | "ai">("you");
  const squad = state.userPicks;
  // Dragging a row by its handle: where it started, where it would land, and how far it has moved
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number } | null>(null);
  const dragRef = useRef<{ from: number; to: number; startY: number; rowH: number } | null>(null);
  // Open at the top: the draft list may have been scrolled far down
  useEffect(() => window.scrollTo(0, 0), []);

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

  const onGrab = (i: number, e: PointerEvent) => {
    if (busy || e.button > 0) return;
    const row = (e.currentTarget as HTMLElement).closest(".xrow") as HTMLElement | null;
    if (!row) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { from: i, to: i, startY: e.clientY, rowH: row.getBoundingClientRect().height };
    setDrag({ from: i, to: i, dy: 0 });
    e.preventDefault();
  };
  const onDrag = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    d.to = Math.max(0, Math.min(10, d.from + Math.round(dy / d.rowH)));
    setDrag({ from: d.from, to: d.to, dy });
  };
  const onDrop = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (d && d.to !== d.from) move(d.from, d.to);
  };
  /** The batting spot a row will have if the dragged row is dropped where it is now. */
  const landing = (i: number) => {
    if (!drag) return i;
    if (i === drag.from) return drag.to;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return i - 1;
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return i + 1;
    return i;
  };
  /** Rows between the start and the landing spot make room for the dragged one. */
  const rowStyle = (i: number) => {
    if (!drag || !dragRef.current) return undefined;
    const h = dragRef.current.rowH;
    if (i === drag.from) return { transform: `translateY(${drag.dy}px)` };
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return { transform: `translateY(${-h}px)` };
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return { transform: `translateY(${h}px)` };
    return { transform: "translateY(0)" };
  };

  const play = async () => {
    setBusy(true);
    try {
      // Who bowls when is the captain's call, from each bowler's record
      const { state: next } = await api.play(props.roomId, {});
      props.onState(next);
      window.scrollTo(0, 0);
    } catch (e) {
      props.toast((e as Error).message, "error");
      setBusy(false);
    }
  };

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
        <div class={`xi lineup-list ${drag ? "dragging" : ""}`} style="margin-top:6px">
          <p class="faint" style="font-size:12px;padding:0 16px 4px">Drag ⠿ to change the order. Your captain picks who bowls when, from their records.</p>
          {squad.map((p, i) =>
            p ? (
              <div class={`xrow ${drag?.from === i ? "lifted" : ""}`} style={rowStyle(i)} key={p.id}>
                <span class="num">{landing(i) + 1}</span>
                <button type="button" class="who" style="background:none;border:0;padding:0;text-align:left" onClick={() => setOpen(p)}>
                  <b class="ellipsis" style="display:block">{shortName(p, 24)}</b>
                  <span class="sub">
                    <span class={`role role-${roleKey(p)}`}>{ROLE_SHORT[roleKey(p)]}</span> {keyStats(p, format)}
                  </span>
                </button>
                <button
                  type="button"
                  class="grip"
                  aria-label={`Move ${p.name}, batting at ${i + 1}: drag, or use the arrow keys`}
                  onPointerDown={(e) => onGrab(i, e as unknown as PointerEvent)}
                  onPointerMove={(e) => onDrag(e as unknown as PointerEvent)}
                  onPointerUp={onDrop}
                  onPointerCancel={() => {
                    dragRef.current = null;
                    setDrag(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" && i > 0) (e.preventDefault(), move(i, i - 1));
                    if (e.key === "ArrowDown" && i < 10) (e.preventDefault(), move(i, i + 1));
                  }}
                >
                  ⠿
                </button>
              </div>
            ) : null
          )}
        </div>
      ) : (
        <div style="margin-top:6px">
          <XIList squad={state.aiPicks} format={format} onOpen={setOpen} />
        </div>
      )}


      <div class="sticky-cta">
        <button type="button" class="btn btn-primary" disabled={busy} onClick={play}>
          {busy ? "Playing the match…" : "Play the match"}
        </button>
      </div>

      {open && <PlayerSheet player={open} format={format} canDraft={false} onClose={() => setOpen(null)} />}
    </div>
  );
}
