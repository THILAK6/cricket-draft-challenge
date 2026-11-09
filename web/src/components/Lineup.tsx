import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { reorderXI, useDragOrder } from "./useDragOrder";
import { keyStats, PITCH_LABEL, positionLine, ROLE_SHORT, roleKey, shortName, type Player } from "../format";
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
  // Open at the top: the draft list may have been scrolled far down
  useEffect(() => window.scrollTo(0, 0), []);

  const order = useDragOrder((from, to) => reorderXI(props, from, to), !busy);
  const { drag } = order;

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
          <p class="faint" style="font-size:12px;padding:0 16px 4px">Drag ⠿ to change the order. Under each batter: his record in that spot.</p>
          {squad.map((p, i) =>
            p ? (
              <div class={`xrow ${drag?.from === i ? "lifted" : ""}`} style={order.rowStyle(i)} key={p.id}>
                <span class="num">{order.landing(i) + 1}</span>
                <button type="button" class="who" style="background:none;border:0;padding:0;text-align:left" onClick={() => setOpen(p)}>
                  <b class="ellipsis" style="display:block">{shortName(p, 24)}</b>
                  <span class="sub">
                    <span class={`role role-${roleKey(p)}`}>{ROLE_SHORT[roleKey(p)]}</span> {keyStats(p, format)}
                  </span>
                  {positionLine(p, order.landing(i) + 1, format) && <span class="posrec">{positionLine(p, order.landing(i) + 1, format)}</span>}
                </button>
                <button type="button" class="grip" {...order.gripProps(i, p.name)}>
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
