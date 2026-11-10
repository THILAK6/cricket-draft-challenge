import type { DraftState } from "../../../src/core/types";
import { BASE_RULES, matchLabel, parLine, PITCH_LABEL, PITCH_TIP, scenarioRules, shortName } from "../format";
import { themesFor } from "../../../src/core/themes";

export function Briefing(props: { state: DraftState; busy: boolean; onBack: () => void; onReroll: () => void; onStart: () => void }) {
  const { challenge, firstPick, lastAiPicks, pool } = props.state;
  const aiFirst = firstPick === "AI";
  const aiOpener = aiFirst ? lastAiPicks?.[0]?.player : undefined;
  return (
    <div class="wizard">
      <div class="steps" aria-hidden="true">
        <span class="on" />
        <span class="on" />
        <span />
      </div>
      <div class="stack" style="gap:6px">
        <h1>{challenge.title}</h1>
        <p class="muted">
          {matchLabel(challenge)} at {challenge.venue.name}
        </p>
      </div>

      <div class="card stack" style="gap:8px">
        <div class="row" style="justify-content:space-between">
          <div class="label">Pitch</div>
          <span class="pitch">{PITCH_LABEL[challenge.venue.pitch_type]}</span>
        </div>
        <p>{challenge.narrative_intro}</p>
        <p class="muted" style="font-size:14px">{PITCH_TIP[challenge.venue.pitch_type]}</p>
        {parLine(challenge.format, challenge.venue.name, challenge.league) && <p class="muted" style="font-size:14px">{parLine(challenge.format, challenge.venue.name, challenge.league)}.</p>}
      </div>

      <div class="card">
        <div class="label">Rules for both XIs</div>
        <ul class="rules">
          {scenarioRules(challenge).map((r) => (
            <li class="house">{r}</li>
          ))}
          {BASE_RULES.map((r) => (
            <li>{r}</li>
          ))}
        </ul>
        <p class="muted" style="font-size:13px;margin-top:8px">
          {pool.length + (lastAiPicks?.length ?? 0)} players in the pool ({(themesFor(challenge.league).find((t) => t.key === props.state.theme) ?? themesFor(challenge.league)[0]).label.toLowerCase()}).{" "}
          {props.state.draftMode === "auction" ? "It is an auction: players come up one at a time and you bid with a purse." : "Picks go 1-2-2-2…: after the first pick, each side"} picks twice in a row.
        </p>
      </div>

      {props.state.draftMode === "auction" && props.state.auction ? (
        <div class="card">
          <div class="label">The auction</div>
          <p style="margin-top:6px">
            You each have <b>{Number(props.state.auction.purse.USER.toFixed(2))} crore</b> to fill an XI, with the overseas limit. The six best players go first, then batters, keepers, all-rounders, fast bowlers and spinners. A bid goes up a step at a time; the last bid wins.
          </p>
          <p class="muted" style="font-size:13px;margin-top:6px">
            {props.state.auction.style === "calculated" ? "The rival bids to exactly what a player is worth to its XI." : "The rival bids like a person: it can get carried away, and let a bargain go."}
          </p>
        </div>
      ) : (
      <div class="card toss">
        <span class="coin" aria-hidden="true">🪙</span>
        <div>
          <b>{aiFirst ? "The AI won the toss and picks first." : "You won the toss. You pick first."}</b>
          {aiOpener && (
            <p class="muted" style="margin-top:2px">
              It opened with <b class="ai">{shortName(aiOpener)}</b>. You now get two picks in a row.
            </p>
          )}
          {aiOpener && lastAiPicks?.[0]?.line && <q class="ai-line">{lastAiPicks[0].line}</q>}
          {!aiFirst && <p class="muted" style="margin-top:2px">Then the AI picks twice, and so on.</p>}
        </div>
      </div>
      )}

      <div class="actions">
        <button type="button" class="btn" disabled={props.busy} onClick={props.onReroll}>
          New ground
        </button>
        <button type="button" class="btn btn-primary" disabled={props.busy} onClick={props.onStart}>
          {props.state.draftMode === "auction" ? "Start the auction" : "Start drafting"}
        </button>
      </div>
    </div>
  );
}
