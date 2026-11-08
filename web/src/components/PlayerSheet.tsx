import { useEffect } from "preact/hooks";
import type { MatchFormat } from "../../../src/core/types";
import { ROLE_LABEL, roleKey, type Player } from "../format";

const fmt = (x: number, d = 1) => (Number.isFinite(x) && x > 0 ? x.toFixed(d) : "–");

/** Full stats for one player in a bottom sheet, with the Draft action. */
export function PlayerSheet(props: {
  player: Player;
  format: MatchFormat;
  canDraft: boolean;
  reason?: string;
  busy?: boolean;
  onDraft?: () => void;
  onClose: () => void;
}) {
  const { player: p, format } = props;
  const s = p.stats;
  const rk = roleKey(p);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const innings = Math.max(1, s.top_order_innings + s.middle_order_innings + s.finisher_innings);
  const bowls = s.bowl_overs > 0 && s.bowl_wickets > 0;
  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={`${p.name} details`}>
        <div class="grab" />
        <div class="row" style="align-items:flex-start">
          <div class="grow">
            <h2 style="font-size:20px">{p.name}</h2>
            <p class="muted" style="font-size:14px;margin-top:2px">
              {p.country} · <span class={`role role-${rk}`}>{ROLE_LABEL[rk]}</span> · {p.batting_hand === "LHB" ? "Left" : "Right"}-hand bat
              {p.bowling_style ? ` · ${p.bowling_style}` : ""}
            </p>
            <p class="faint" style="font-size:13px;margin-top:2px">
              {s.matches} {format === "TEST" ? "Tests" : format === "ODI" ? "ODIs" : "T20Is"}
            </p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {p.primary_role !== "BOWL" || s.bat_runs > 300 ? (
          <div style="margin-top:12px">
            <div class="label">Batting</div>
            <div class="stats">
              <div class="stat"><b>{s.bat_runs}</b><span>Runs</span></div>
              <div class="stat"><b>{fmt(s.bat_average)}</b><span>Average</span></div>
              <div class="stat"><b>{fmt(s.bat_strike_rate)}</b><span>Strike rate</span></div>
            </div>
            <div class="bars">
              {(
                [
                  ["Top order", s.top_order_innings],
                  ["Middle", s.middle_order_innings],
                  ["Finisher", s.finisher_innings],
                ] as [string, number][]
              ).map(([label, n]) => (
                <>
                  <span class="muted">{label}</span>
                  <span class="bar"><i style={`width:${Math.round((n / innings) * 100)}%`} /></span>
                  <span class="faint" style="text-align:right">{n}</span>
                </>
              ))}
            </div>
          </div>
        ) : null}

        {bowls && (
          <div style="margin-top:12px">
            <div class="label">Bowling</div>
            <div class="stats">
              <div class="stat"><b>{s.bowl_wickets}</b><span>Wickets</span></div>
              <div class="stat"><b>{fmt(s.bowl_economy, 2)}</b><span>Economy</span></div>
              <div class="stat"><b>{fmt(s.bowl_average)}</b><span>Average</span></div>
            </div>
          </div>
        )}

        {props.reason && <div class="reason">{props.reason}</div>}

        {props.onDraft && (
          <button type="button" class="btn btn-primary btn-block" style="margin-top:14px;min-height:50px;font-size:16px" disabled={!props.canDraft || props.busy} onClick={props.onDraft}>
            {props.canDraft ? `Draft ${p.name.split(" ").slice(-1)[0]}` : "Can't draft right now"}
          </button>
        )}
      </div>
    </div>
  );
}
