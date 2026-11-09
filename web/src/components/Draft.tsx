import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DraftState } from "../../../src/core/types";
import { canPickPlayer, rulesFor } from "../../../src/core/validator";
import { api } from "../api";
import { keyStats, PITCH_LABEL, plainReason, positionLine, ROLE_SHORT, roleKey, shortName, type Player, type RoleKey, type Squad } from "../format";
import { PlayerSheet } from "./PlayerSheet";
import { reorderXI, useDragOrder } from "./useDragOrder";
import { PERSONA_INFO } from "../../../src/core/personas";
import type { ShowToast } from "./Toast";

export interface RoomProps {
  state: DraftState;
  roomId: string;
  onState: (s: DraftState) => void;
  toast: ShowToast;
  onNewGame: () => void;
}

type Tab = "pool" | "you" | "ai" | "board";
type Filter = "ALL" | "NEEDED" | RoleKey;
type Sort = "role" | "avg" | "sr" | "wkts" | "econ" | "caps" | "name";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "NEEDED", label: "You need" },
  { key: "BAT", label: "Batters" },
  { key: "WK", label: "Keepers" },
  { key: "AR", label: "All-rounders" },
  { key: "PACE", label: "Pace" },
  { key: "SPIN", label: "Spin" },
];

/** A short version of a legality reason, for the row. The sheet shows the full sentence. */
function shortReason(reason: string): string {
  if (reason.startsWith("Country cap")) return "Country cap reached";
  const need = reason.match(/still need (.*)$/);
  if (need) return `Need ${need[1].split(",")[0].replace(/^\d+ more /, "")} first`;
  return "Not allowed";
}


export function Draft(props: RoomProps) {
  const { state } = props;
  const { challenge } = state;
  const format = challenge.format;
  const [tab, setTab] = useState<Tab>("pool");
  const [side, setSide] = useState<"you" | "ai" | "board">("you");
  const [filter, setFilter] = useState<Filter>("ALL");
  // No ratings: the list is in role order, and every sort is a plain career number
  const [sort, setSort] = useState<Sort>("role");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Player | null>(null);
  const [busy, setBusy] = useState(false);
  const [bannerHidden, setBannerHidden] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);

  // Keep the pool toolbar stuck just under the header, whatever its height
  useEffect(() => {
    const el = topRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--topbar-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const yourTurn = state.status === "DRAFTING" && state.currentTurn === "USER";
  const ctx = { pool: state.pool, opponentSquad: state.aiPicks };

  // The same legality check the server runs, so a "Draft" button is only shown when the server will accept the pick
  const legality = useMemo(() => {
    const m = new Map<string, { ok: boolean; reason?: string }>();
    for (const p of state.pool) {
      const r = canPickPlayer(p, state.userPicks, challenge, undefined, ctx);
      m.set(p.id, { ok: r.allowed || !!state.userStuck, reason: r.allowed ? undefined : r.reason });
    }
    return m;
  }, [state.pool, state.userPicks, state.aiPicks, state.userStuck]);

  const mine = state.userPicks.filter((p): p is Player => !!p);
  const needs = useMemo(() => rulesFor(challenge, mine, state.pool), [state.userPicks, state.pool]);
  const openNeeds = needs.filter((n) => mine.filter(n.matches).length < n.required);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = state.pool.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q) && !p.country.toLowerCase().includes(q)) return false;
      if (filter === "ALL") return true;
      if (filter === "NEEDED") return openNeeds.some((n) => n.matches(p));
      return roleKey(p) === filter;
    });
    const ROLE_ORDER: Record<RoleKey, number> = { BAT: 0, WK: 1, AR: 2, PACE: 3, SPIN: 4 };
    const bowls = (p: Player) => p.stats.bowl_wickets > 0 && p.stats.bowl_economy > 0;
    // Higher first, except economy (lower is better); players who don't bowl go last on bowling sorts
    const key: Record<Sort, (p: Player) => number> = {
      role: (p) => -ROLE_ORDER[roleKey(p)],
      avg: (p) => p.stats.bat_average,
      sr: (p) => p.stats.bat_strike_rate,
      wkts: (p) => p.stats.bowl_wickets,
      econ: (p) => (bowls(p) ? -p.stats.bowl_economy : -99),
      caps: (p) => p.stats.matches,
      name: () => 0,
    };
    list = [...list].sort((a, b) => key[sort](b) - key[sort](a) || a.name.localeCompare(b.name));
    return list;
  }, [state.pool, query, filter, sort, openNeeds.length]);

  const pick = async (p: Player) => {
    if (!yourTurn || busy) return;
    setBusy(true);
    try {
      const { state: next } = await api.pick(props.roomId, p.id);
      setOpen(null);
      setBannerHidden(false);
      props.onState(next);
      const ai = next.lastAiPicks ?? [];
      if (next.status === "READY_TO_PLAY") props.toast("Both XIs are complete. Set your batting order.");
      else if (ai.length === 0 && next.currentTurn === "USER") props.toast(`${shortName(p)} is in. Your pick again.`);
    } catch (e) {
      props.toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  // Turn summary for the header
  const n = (state.pickIndex ?? 0) + 1;
  const order = state.pickOrder ?? [];
  // In a snake draft most turns are two picks in a row
  const pairLabel = !yourTurn ? "" : order[n] === "USER" ? " (1 of 2)" : order[n - 2] === "USER" ? " (2 of 2)" : "";
  const strip = order.slice(Math.max(0, n - 1), Math.max(0, n - 1) + 10);

  const aiPicks = state.lastAiPicks ?? [];
  const lastLog = state.pickLog ?? [];

  const poolPanel = (
    <div class={`panel pool ${tab === "pool" ? "m-on" : ""}`}>
      <div class="toolbar">
        <div class="search">
          <input type="search" placeholder="Search player or country" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} aria-label="Search players" />
          <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)} aria-label="Sort players">
            <option value="role">By role</option>
            <option value="avg">Batting average</option>
            <option value="sr">Strike rate</option>
            <option value="wkts">Wickets</option>
            <option value="econ">Economy</option>
            <option value="caps">Caps</option>
            <option value="name">Name</option>
          </select>
        </div>
        <div class="filters" role="tablist" aria-label="Filter by role">
          {FILTERS.map((f) => (
            <button type="button" class={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}>
              {f.label}
              {f.key === "NEEDED" && openNeeds.length > 0 ? ` (${openNeeds.length})` : ""}
            </button>
          ))}
        </div>
        <NeedChips needs={needs} mine={mine} />
      </div>

      {busy && (
        <div class="ai-banner thinking" role="status">
          <div class="who">{PERSONA_INFO[state.difficulty ?? "normal"].name} is thinking…</div>
        </div>
      )}

      {!busy && aiPicks.length > 0 && !bannerHidden && (
        <div class="ai-banner" role="status">
          <div class="grow">
            <div class="who">
              {PERSONA_INFO[state.difficulty ?? "normal"].name} picked {aiPicks.length === 2 ? "twice" : ""}
            </div>
            <div class="picks">{aiPicks.map((a) => `${shortName(a.player)} (${ROLE_SHORT[roleKey(a.player)]})`).join(" and ")}</div>
            {aiPicks.some((a) => a.line) ? (
              aiPicks.filter((a) => a.line).map((a) => <q class="line">{a.line}</q>)
            ) : (
              <div class="why">{plainReason(aiPicks[aiPicks.length - 1].reason)}</div>
            )}
          </div>
          <button type="button" class="x" onClick={() => setBannerHidden(true)} aria-label="Hide">
            ✕
          </button>
        </div>
      )}

      <div class="list">
        {rows.length === 0 && <div class="empty">No players match. Try another filter.</div>}
        {rows.map((p) => {
          const l = legality.get(p.id)!;
          const can = yourTurn && l.ok;
          const rk = roleKey(p);
          return (
            <div class={`prow ${l.ok ? "" : "dim"}`} key={p.id}>
              <button type="button" class="main" onClick={() => setOpen(p)} aria-label={`${p.name}, details`}>
                <span class="name ellipsis">
                  {shortName(p)}
                  <span class="cty">{p.country}</span>
                </span>
                <span class="sub">
                  <span class={`role role-${rk}`}>{ROLE_SHORT[rk]}</span>
                  <span class="ellipsis">{keyStats(p, format)}</span>
                </span>
              </button>
              {can ? (
                <button type="button" class="pick" disabled={busy} onClick={() => pick(p)} aria-label={`Draft ${p.name}`}>
                  Draft
                </button>
              ) : (
                <span class="blocked">{!l.ok ? shortReason(l.reason || "") : yourTurn ? "" : "AI's pick"}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const sidePanels = (
    <>
      <div class={`panel side-panel ${tab === "you" ? "m-on" : ""} ${side === "you" ? "d-on" : ""}`}>
        <div class="section-head">
          <b>Your XI</b>
          <span class="muted">{mine.length}/11 · drag ⠿ to set the batting order</span>
        </div>
        <XIList squad={state.userPicks} format={format} onOpen={setOpen} onMove={(from, to) => reorderXI(props, from, to)} />
        <div style="padding:10px 16px">
          <NeedChips needs={needs} mine={mine} />
        </div>
      </div>
      <div class={`panel side-panel ${tab === "ai" ? "m-on" : ""} ${side === "ai" ? "d-on" : ""}`}>
        <div class="section-head">
          <b class="ai">AI XI</b>
          <span class="muted">{state.aiPicks.filter(Boolean).length}/11</span>
        </div>
        <XIList squad={state.aiPicks} format={format} onOpen={setOpen} />
      </div>
      <div class={`panel side-panel ${tab === "board" ? "m-on" : ""} ${side === "board" ? "d-on" : ""}`}>
        <div class="section-head">
          <b>Pick board</b>
          <span class="muted">{lastLog.length}/22 picks</span>
        </div>
        <Board state={state} />
      </div>
    </>
  );

  return (
    <>
      <div class="topbar" ref={topRef}>
        <div class="row">
          <span class="title grow ellipsis">{challenge.title}</span>
          <span class="pitch">{PITCH_LABEL[challenge.venue.pitch_type]}</span>
          <button type="button" class="btn btn-sm btn-ghost" onClick={() => confirm("Leave this draft and start a new game?") && props.onNewGame()} aria-label="New game">
            New
          </button>
        </div>
        <div class="turn">
          <span class="muted">Pick {Math.min(n, 22)}/22</span>
          <span class={`who ${yourTurn ? "you" : "ai"}`}>{yourTurn ? `Your pick${pairLabel}` : "AI is picking…"}</span>
          <span class="order-strip" aria-hidden="true">
            {strip.map((w, i) => (
              <i class={`${w === "USER" ? "u" : "a"} ${i === 0 ? "now" : ""}`} />
            ))}
          </span>
        </div>
      </div>

      <div class="draft">
        {poolPanel}
        <div class="side">
          <div class="side-tabs">
            {(["you", "ai", "board"] as const).map((k) => (
              <button type="button" class={side === k ? "on" : ""} onClick={() => setSide(k)}>
                {k === "you" ? `Your XI ${mine.length}/11` : k === "ai" ? `AI XI ${state.aiPicks.filter(Boolean).length}/11` : "Board"}
              </button>
            ))}
          </div>
          {sidePanels}
        </div>
      </div>

      <nav class="tabbar" aria-label="Draft sections">
        {(
          [
            ["pool", "Pool", state.pool.length],
            ["you", "Your XI", `${mine.length}/11`],
            ["ai", "AI XI", `${state.aiPicks.filter(Boolean).length}/11`],
            ["board", "Board", `${lastLog.length}`],
          ] as [Tab, string, string | number][]
        ).map(([k, label, v]) => (
          <button type="button" class={tab === k ? "on" : ""} onClick={() => setTab(k)} aria-current={tab === k}>
            <b>{v}</b>
            {label}
          </button>
        ))}
      </nav>

      {open && (
        <PlayerSheet
          player={open}
          format={format}
          canDraft={yourTurn && !!legality.get(open.id)?.ok}
          reason={state.pool.some((p) => p.id === open.id) ? (legality.get(open.id)?.ok ? undefined : legality.get(open.id)?.reason) : undefined}
          busy={busy}
          onDraft={state.pool.some((p) => p.id === open.id) ? () => pick(open) : undefined}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function NeedChips({ needs, mine }: { needs: ReturnType<typeof rulesFor>; mine: Player[] }) {
  return (
    <div class="needs" aria-label="Your XI needs">
      {needs.map((n) => {
        const have = mine.filter(n.matches).length;
        const label = n.key === "WK" ? "Keeper" : n.key === "BOWL" ? "Bowlers" : n.key === "PACE" ? "Pace" : n.key === "SPIN" ? "Spin" : "All-rounders";
        const done = have >= n.required;
        return (
          <span class={`chip ${n.waived ? "waived" : done ? "ok" : "need"}`} title={n.waived ? "The pool has run out: this rule only asks for what's left" : undefined}>
            {done && !n.waived ? "✓ " : ""}
            {label} {Math.min(have, n.required)}/{n.required}
            {n.waived ? " · pool ran out" : ""}
          </span>
        );
      })}
    </div>
  );
}

export function XIList({ squad, format, onOpen, onMove }: { squad: Squad; format: DraftState["challenge"]["format"]; onOpen?: (p: Player) => void; onMove?: (from: number, to: number) => void }) {
  // With onMove, each player has a handle to drag him to another batting spot (empty spots too)
  const order = useDragOrder(onMove ?? (() => {}), !!onMove);
  const { drag } = order;
  return (
    <div class={`xi ${onMove ? "lineup-list" : ""} ${drag ? "dragging" : ""}`}>
      {squad.map((p, i) =>
        p && onMove ? (
          <div class={`xrow ${drag?.from === i ? "lifted" : ""}`} style={order.rowStyle(i)} key={p.id}>
            <span class="num">{order.landing(i) + 1}</span>
            <button type="button" class="who" style="background:none;border:0;padding:0;text-align:left" onClick={() => onOpen?.(p)}>
              <b class="ellipsis" style="display:block">{shortName(p, 26)}</b>
              <span class="sub">
                <span class={`role role-${roleKey(p)}`}>{ROLE_SHORT[roleKey(p)]}</span> {p.country} · {keyStats(p, format)}
              </span>
              {positionLine(p, order.landing(i) + 1, format) && <span class="posrec">{positionLine(p, order.landing(i) + 1, format)}</span>}
            </button>
            <button type="button" class="grip" {...order.gripProps(i, p.name)}>
              ⠿
            </button>
          </div>
        ) : p ? (
          <button type="button" class="xrow" style="background:none;border-left:0;border-right:0;border-top:0;text-align:left;width:100%" onClick={() => onOpen?.(p)}>
            <span class="num">{i + 1}</span>
            <span class="who">
              <b class="ellipsis" style="display:block">{shortName(p, 26)}</b>
              <span class="sub">
                <span class={`role role-${roleKey(p)}`}>{ROLE_SHORT[roleKey(p)]}</span> {p.country} · {keyStats(p, format)}
              </span>
            </span>
          </button>
        ) : (
          <div class="xrow empty-slot" style={onMove ? order.rowStyle(i) : undefined} key={`empty${i}`}>
            <span class="num">{onMove ? order.landing(i) + 1 : i + 1}</span>
            <span class="who">{i < 2 ? "Opener to pick" : i < 6 ? "Batter to pick" : i < 8 ? "All-rounder or keeper to pick" : "Bowler to pick"}</span>
          </div>
        )
      )}
    </div>
  );
}

function Board({ state }: { state: DraftState }) {
  const log = state.pickLog ?? [];
  const rounds = Array.from({ length: 11 }, (_, r) => {
    const inRound = log.filter((e) => Math.ceil(e.n / 2) === r + 1);
    return { r: r + 1, you: inRound.find((e) => e.by === "USER"), ai: inRound.find((e) => e.by === "AI") };
  });
  return (
    <div class="board">
      <div class="hdr">
        <span>Rd</span>
        <span class="you">You</span>
        <span class="ai">AI</span>
      </div>
      {rounds.map(({ r, you, ai }) => (
        <div class="rnd">
          <span class="r">{r}</span>
          {[you, ai].map((e) => (
            <span class="cell">
              {e ? (
                <>
                  <span class="ellipsis">{shortName(e, 20)}</span>
                  <span class="n">
                    #{e.n} · {e.role}
                  </span>
                </>
              ) : (
                <span class="faint">–</span>
              )}
            </span>
          ))}
        </div>
      ))}
      <p class="faint" style="font-size:12px;margin-top:6px">
        {state.firstPick === "AI" ? "The AI won the toss and picked first." : "You won the toss and picked first."} After that, each side picks twice in a row.
      </p>
    </div>
  );
}
