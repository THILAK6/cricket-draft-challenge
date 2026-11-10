import { useState } from "preact/hooks";
import { api } from "../api";
import { canPickPlayer, rulesFor } from "../../../src/core/validator";
import { affordable, MIN_PRICE, nextBid } from "../../../src/core/auction";
import { keyStats, PITCH_LABEL, ROLE_SHORT, roleKey, shortName, type Player } from "../format";
import { NeedChips, XIList, type RoomProps } from "./Draft";
import { PlayerSheet } from "./PlayerSheet";
import { reorderXI } from "./useDragOrder";

/** Crore, without trailing zeros: 7.5, 12, 0.25. */
const cr = (x: number) => `₹${Number(x.toFixed(2))} cr`;

/** The auction: one player on the block at a time, a bid or a pass, and the squads and sales so far. */
export function Auction(props: RoomProps) {
  const { state } = props;
  const a = state.auction!;
  const format = state.challenge.format;
  const [tab, setTab] = useState<"you" | "ai" | "sold">("you");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Player | null>(null);
  const lot = a.lot;
  const player = lot ? state.pool.find((p) => p.id === lot.playerId) : undefined;
  const mine = state.userPicks.filter((p): p is Player => !!p);
  const theirs = state.aiPicks.filter((p): p is Player => !!p);
  const slots = 11 - mine.length;
  const sold = a.log.length;
  const left = a.queue.length + (lot ? 1 : 0);

  // May you bid the next step? Mirrors the room's check (the room decides).
  const price = lot ? nextBid(lot) : 0;
  const cap = affordable(a.purse.USER, slots);
  let blocked: string | undefined;
  if (lot && player) {
    if (slots === 0) blocked = "Your XI is full";
    else if (price > cap) blocked = `You can spend at most ${cr(cap)} here and still fill your XI`;
    else {
      const ctx = { pool: state.pool, opponentSquad: state.aiPicks };
      const check = canPickPlayer(player, state.userPicks, state.challenge, undefined, ctx);
      if (!check.allowed && state.pool.some((q) => canPickPlayer(q, state.userPicks, state.challenge, undefined, ctx).allowed)) blocked = check.reason;
    }
  }
  const myTurn = !!lot && lot.turn === "USER";

  const act = async (action: "bid" | "pass") => {
    if (busy) return;
    setBusy(true);
    try {
      const { state: next } = await api.bid(props.roomId, action);
      props.onState(next);
      if (next.status === "READY_TO_PLAY") props.toast("Both XIs are complete. Set your batting order.");
      window.scrollTo(0, 0);
    } catch (e) {
      props.toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const prices = new Map((state.pickLog ?? []).map((e) => [e.playerId, e.price] as const));
  const last = a.log[a.log.length - 1];
  const needs = rulesFor(state.challenge, mine, state.pool);
  const holder = lot?.holder === "USER" ? "You" : lot?.holder === "AI" ? "The AI" : null;
  const pad = (n: number) => String(n);

  return (
    <div class="auction">
      <div class="topbar">
        <div class="row">
          <span class="title grow ellipsis">{state.challenge.title}</span>
          <span class="pitch">{PITCH_LABEL[state.challenge.venue.pitch_type]}</span>
        </div>
        <div class="turn">
          <span class="who good">Auction</span>
          <span class="muted">
            {sold} sold or passed · {pad(left)} to come{a.accelerated ? " · last chance round" : ""}
          </span>
        </div>
      </div>

      <div class="purses">
        <div class={`purse you ${myTurn ? "now" : ""}`}>
          <span class="muted">You</span>
          <b>{cr(a.purse.USER)}</b>
          <span class="faint">{mine.length}/11 in your XI</span>
        </div>
        <div class="purse ai">
          <span class="muted">AI XI</span>
          <b>{cr(a.purse.AI)}</b>
          <span class="faint">{theirs.length}/11 in its XI</span>
        </div>
      </div>

      {lot && player && (
        <div class="card lot">
          <div class="row" style="justify-content:space-between">
            <span class="chip">{lot.set}</span>
            <span class="muted" style="font-size:13px">Opens at {cr(lot.base)}</span>
          </div>
          <button type="button" class="lot-who" onClick={() => setOpen(player)}>
            <b>{shortName(player, 28)}</b>
            <span class="sub">
              <span class={`role role-${roleKey(player)}`}>{ROLE_SHORT[roleKey(player)]}</span> {player.country} · {keyStats(player, format)}
            </span>
            <span class="faint" style="font-size:12px">Tap for his full record</span>
          </button>
          <div class={`bid ${lot.holder === "USER" ? "mine" : lot.holder === "AI" ? "theirs" : ""}`}>
            {lot.bid === null ? (
              <span class="muted">No bid yet</span>
            ) : (
              <>
                <span class="muted">Highest bid</span>
                <b>{cr(lot.bid)}</b>
                <span class={lot.holder === "USER" ? "you" : "ai"}>{holder}</span>
              </>
            )}
          </div>
          {last && (
            <p class="muted" style="font-size:13px">
              Last lot: {last.name} {last.price === null ? "went unsold" : `to ${last.to === "USER" ? "you" : "the AI"} for ${cr(last.price)}`}.
            </p>
          )}
          {blocked && <p class="blocked-note">{blocked}</p>}
        </div>
      )}

      <div class="tabs2" style="margin:12px 16px 0">
        <button type="button" class={tab === "you" ? "on" : ""} onClick={() => setTab("you")}>Your XI {mine.length}/11</button>
        <button type="button" class={tab === "ai" ? "on" : ""} onClick={() => setTab("ai")}>AI XI {theirs.length}/11</button>
        <button type="button" class={tab === "sold" ? "on" : ""} onClick={() => setTab("sold")}>Sales {sold}</button>
      </div>

      {tab === "you" && (
        <div style="padding-bottom:110px">
          <div class="section-head">
            <b>Your XI</b>
            <span class="muted">drag ⠿ to set the batting order</span>
          </div>
          <XIList squad={state.userPicks} format={format} onOpen={setOpen} onMove={(f, t) => reorderXI(props, f, t)} priceOf={(p) => prices.get(p.id)} />
          <div style="padding:10px 16px">
            <NeedChips needs={needs} mine={mine} />
          </div>
        </div>
      )}
      {tab === "ai" && (
        <div style="padding-bottom:110px">
          <div class="section-head">
            <b class="ai">AI XI</b>
            <span class="muted">{theirs.length}/11</span>
          </div>
          <XIList squad={state.aiPicks} format={format} onOpen={setOpen} priceOf={(p) => prices.get(p.id)} />
        </div>
      )}
      {tab === "sold" && (
        <ul class="sales" style="padding-bottom:110px">
          {[...a.log].reverse().map((e, i) => (
            <li key={`${e.playerId}${i}`}>
              <span class="grow">
                <b>{e.name}</b> <span class="faint">{e.set}</span>
              </span>
              {e.price === null ? <span class="faint">unsold</span> : <b class={e.to === "USER" ? "you" : "ai"}>{e.to === "USER" ? "You" : "AI"} {cr(e.price)}</b>}
            </li>
          ))}
          {!a.log.length && <li class="faint">Nothing sold yet.</li>}
        </ul>
      )}

      {myTurn && (
        <div class="bid-bar">
          <button type="button" class="btn" disabled={busy} onClick={() => act("pass")}>
            Pass
          </button>
          <button type="button" class="btn btn-primary" disabled={busy || !!blocked} onClick={() => act("bid")}>
            {lot?.bid === null ? `Bid ${cr(price)}` : `Raise to ${cr(price)}`}
          </button>
        </div>
      )}

      {open && <PlayerSheet player={open} format={format} canDraft={false} onClose={() => setOpen(null)} />}
    </div>
  );
}
void MIN_PRICE;
