import { useState } from "preact/hooks";
import type { InningsScorecard, MatchSimulationResult } from "../../../src/core/simulator";
import { buildDraftAwards, buildHeadToHead, type DraftAward, type HeadToHead, type MatchReview, type WinChance } from "../../../src/core/match-review";
import { parLine, PITCH_LABEL, shortName } from "../format";
import type { RoomProps } from "./Draft";

const score = (i?: InningsScorecard) => (i ? `${i.totalRuns}/${i.totalWickets}${i.declared ? "d" : ""}` : "");
// An innings that never started (an innings win) is left out of the score line
const scoreLine = (a?: InningsScorecard, b?: InningsScorecard) =>
  [a, b].filter((i): i is InningsScorecard => !!i && i.totalBalls > 0).map((i) => (i.totalWickets >= 10 ? `${i.totalRuns}` : score(i))).join(" & ");

/** The match result: score line, how often this XI wins, head to head, turning points, draft awards, then the details. */
export function Result(props: RoomProps) {
  const sim = props.state.simulation as MatchSimulationResult | undefined;
  const results = props.state.results;
  const [shown, setShown] = useState("u1");
  if (!sim) return <div class="loading">No result yet.</div>;
  const test = sim.format === "TEST";
  const headline =
    sim.winner === "USER" ? "You won" : sim.winner === "AI" ? "The AI won" : sim.winner === "DRAW" ? "Match drawn" : "Match tied";
  // Rooms finished before the review existed get the head-to-head and awards worked out here
  const review: MatchReview = results?.review ?? {
    headToHead: buildHeadToHead(props.state.userPicks, props.state.aiPicks, props.state.challenge),
    awards: buildDraftAwards(props.state.pickLog, sim.matchFacts?.contributions),
  };

  const innings: { key: string; label: string; inn: InningsScorecard }[] = [
    { key: "u1", label: test ? "Your 1st" : "Your XI", inn: sim.userInnings },
    { key: "a1", label: test ? "AI 1st" : "AI XI", inn: sim.aiInnings },
    ...(sim.userSecondInnings ? [{ key: "u2", label: "Your 2nd", inn: sim.userSecondInnings }] : []),
    ...(sim.aiSecondInnings ? [{ key: "a2", label: "AI 2nd", inn: sim.aiSecondInnings }] : []),
  ];
  const current = innings.find((x) => x.key === shown) ?? innings[0];

  return (
    <div class="result">
      <div class="scorehead">
        <div class="side">
          <span class="you">Your XI</span>
          <b>{scoreLine(sim.userInnings, sim.userSecondInnings)}</b>
          <span>{test ? "" : `${sim.userInnings.oversString} ov`}</span>
        </div>
        <span class="vs">v</span>
        <div class="side r">
          <span class="ai">AI XI</span>
          <b>{scoreLine(sim.aiInnings, sim.aiSecondInnings)}</b>
          <span>{test ? "" : `${sim.aiInnings.oversString} ov`}</span>
        </div>
      </div>

      <div class="verdict">
        <h2 class={sim.winner === "USER" ? "good" : sim.winner === "AI" ? "bad" : ""}>{headline}</h2>
        <p class="muted" style="margin-top:4px">{sim.summary}</p>
        {sim.playerOfTheMatch && (
          <div class="potm">
            <span aria-hidden="true">🏅</span>
            <div class="grow">
              <span class="muted" style="font-size:12px">Player of the match</span>
              <div>
                <b>{sim.playerOfTheMatch.name}</b> <span class="muted">{sim.playerOfTheMatch.performance}</span>
              </div>
            </div>
          </div>
        )}
        <p class="faint" style="font-size:13px;margin-top:8px">{sim.toss?.narrative}</p>
      </div>

      <WinChanceLine chance={review.winChance} winner={sim.winner} />

      <HeadToHeadCard h2h={review.headToHead} />

      {(results?.decisiveDifference || sim.keyMoments.length > 0) && (
        <div class="card stack" style="gap:8px">
          <div class="label">Turning points</div>
          {results?.decisiveDifference && <p>{results.decisiveDifference}</p>}
          {sim.keyMoments.slice(0, 3).map((m) => (
            <div class="moment">
              <span class="ov">{typeof m.over === "number" ? `Ov ${m.over}` : m.over}</span>
              <div class="grow">
                <b class={m.impactTeam === "USER" ? "you" : "ai"}>{m.title}</b>
                <div class="muted" style="font-size:13px">{m.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {review.awards.length > 0 && (
        <div class="card stack" style="gap:8px">
          <div class="label">Draft awards</div>
          {review.awards.map((a) => (
            <div class="award">
              <span class="ic" aria-hidden="true">{AWARD_ICON[a.kind]}</span>
              <div class="grow">
                <span class="muted" style="font-size:12px">{a.title}</span>
                <div>
                  <b class={a.team === "USER" ? "you" : "ai"}>{a.name}</b>
                </div>
                <div class="muted" style="font-size:13px">{a.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {sim.superOver && (
        <div class="card">
          <div class="label">Super over</div>
          <p style="margin-top:6px">{sim.superOver.summary}</p>
        </div>
      )}

      <details class="box">
        <summary>Scorecards</summary>
        <div class="inner">
          <div class="tabs2" style="flex-wrap:wrap">
            {innings.map((x) => (
              <button type="button" class={x.key === shown ? "on" : ""} onClick={() => setShown(x.key)}>
                {x.label} {score(x.inn)}
              </button>
            ))}
          </div>
          <Scorecard inn={current.inn} />
        </div>
      </details>

      {test && sim.dayChronicle && sim.dayChronicle.length > 0 && (
        <details class="box">
          <summary>Day by day</summary>
          <div class="inner">
            {sim.dayChronicle.map((d) => (
              <div class="moment">
                <span class="ov">Day {d.day}</span>
                <div class="grow">
                  <b>{d.title}</b> <span class="muted">{d.stumpsScore}</span>
                  <div class="muted" style="font-size:13px">{d.highlight}</div>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      <details class="box">
        <summary>The ground</summary>
        <div class="inner">
          <p>
            {props.state.challenge.venue.name} · <span class="pitch">{PITCH_LABEL[props.state.challenge.venue.pitch_type]}</span>
          </p>
          {parLine(sim.format, props.state.challenge.venue.name) && <p class="muted">{parLine(sim.format, props.state.challenge.venue.name)}.</p>}
          {sim.groundConditionsAnalysis && <p class="muted">{sim.groundConditionsAnalysis}</p>}
          {results?.refereeReport && <p class="muted">{results.refereeReport}</p>}
        </div>
      </details>

      <div style="padding:16px">
        <button type="button" class="btn btn-primary btn-block" style="min-height:52px;font-size:17px" onClick={props.onNewGame}>
          New game
        </button>
      </div>
    </div>
  );
}

const AWARD_ICON: Record<DraftAward["kind"], string> = { steal: "💎", best: "⭐", regret: "😬" };

/** "Hope", "de Villiers": enough of a name to argue about. */
function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  return /^(de|du|van|von|der|ul|al|le)$/i.test(prev) ? `${prev} ${last}` : last;
}

function names(xs: string[]): string {
  if (!xs.length) return "nobody";
  const s = xs.map(surname);
  return s.length === 2 ? `${s[0]} & ${s[1]}` : s.join(", ");
}

function HeadToHeadCard({ h2h }: { h2h: HeadToHead }) {
  const level = h2h.rows.length - h2h.won.USER - h2h.won.AI;
  return (
    <div class="card stack" style="gap:6px">
      <div class="label">Head to head</div>
      <p class="h2h-sum">
        <b class="you">You {h2h.won.USER}</b>
        <span class="muted"> · </span>
        <b class="ai">AI {h2h.won.AI}</b>
        {level > 0 && <span class="muted"> · {level} level</span>}
      </p>
      <div class="h2h">
        {h2h.rows.map((r) => (
          <div class={`row ${r.edge === "USER" ? "u" : r.edge === "AI" ? "a" : "e"}`}>
            <div class="lbl">
              <span class="arrow l" aria-hidden="true">{r.edge === "USER" ? "◀" : ""}</span>
              <span>{r.label}</span>
              <span class="arrow r" aria-hidden="true">{r.edge === "AI" ? "▶" : ""}</span>
              <span class="sr-only">{r.edge === "USER" ? ": yours" : r.edge === "AI" ? ": the AI's" : ": level"}</span>
            </div>
            {r.cols && <div class="cols">{r.cols}</div>}
            <UnitSide line={r.user} side="l" />
            <UnitSide line={r.ai} side="r" />
          </div>
        ))}
      </div>
      <p class="faint" style="font-size:12px">
        Career numbers in this format. The arrow points to the stronger unit; a short career counts for less than the same numbers over a long one.
      </p>
    </div>
  );
}

/** One side of a match-up: each player with his own numbers, or the unit as a whole. */
function UnitSide({ line, side }: { line: HeadToHead["rows"][number]["user"]; side: "l" | "r" }) {
  if (line.players?.length) {
    return (
      <div class={`side ${side}`}>
        {line.players.map((p) => (
          <div class="pl">
            <span class="who">{surname(p.name)}</span> <span class="st">{p.stat}</span>
          </div>
        ))}
        {line.stat && <div class="st note">{line.stat}</div>}
      </div>
    );
  }
  return (
    <div class={`side ${side}`}>
      <div class="who">{names(line.names)}</div>
      <div class="st">{line.stat}</div>
    </div>
  );
}

function WinChanceLine({ chance, winner }: { chance?: WinChance; winner: string }) {
  if (!chance || !chance.played) return null;
  const pct = (n: number) => Math.round((n / chance.played) * 100);
  const w = pct(chance.wins);
  const d = pct(chance.draws);
  const l = 100 - w - d;
  const read =
    winner === "USER" && w < 40 ? "This one went your way, but their XI is the stronger draft."
    : winner === "AI" && w > 55 ? "Unlucky: yours is the better XI and wins this more often than not."
    : w >= 60 ? "You drafted the better XI."
    : l >= 60 ? "Their XI was the better draft."
    : "Two well-matched XIs: it could go either way.";
  return (
    <div class="card stack" style="gap:8px">
      <div class="label">Played {chance.played} times</div>
      <p>
        Your XI wins <b class="you">{w}%</b>
        {d > 0 ? <>, draws {d}%</> : null} and loses <b class="ai">{l}%</b>.
      </p>
      <div class="chance" role="img" aria-label={`Win ${w}%, draw ${d}%, lose ${l}%`}>
        <span class="w" style={{ width: `${w}%` }} />
        <span class="d" style={{ width: `${d}%` }} />
        <span class="l" style={{ width: `${l}%` }} />
      </div>
      <p class="muted" style="font-size:13px">{read}</p>
    </div>
  );
}

function Scorecard({ inn }: { inn: InningsScorecard }) {
  return (
    <div class="stack" style="gap:12px">
      <p class="muted" style="font-size:13px">
        {inn.teamName}: {inn.totalRuns}/{inn.totalWickets} in {inn.oversString} overs
      </p>
      <table class="sc">
        <thead>
          <tr>
            <th>Batter</th>
            <th>R</th>
            <th>B</th>
            <th>4s</th>
            <th>6s</th>
          </tr>
        </thead>
        <tbody>
          {inn.batters.map((b) => (
            <tr>
              <td>
                {shortName(b, 24)}
                {!b.isOut ? " *" : ""}
                <span class="how">{b.isOut ? b.dismissal : "not out"}</span>
              </td>
              <td>
                <b>{b.runs}</b>
              </td>
              <td>{b.balls}</td>
              <td>{b.fours}</td>
              <td>{b.sixes}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table class="sc">
        <thead>
          <tr>
            <th>Bowler</th>
            <th>O</th>
            <th>R</th>
            <th>W</th>
            <th>Econ</th>
          </tr>
        </thead>
        <tbody>
          {inn.bowlers.map((b) => (
            <tr>
              <td>{shortName(b, 24)}</td>
              <td>{b.overs}</td>
              <td>{b.runs}</td>
              <td>
                <b>{b.wickets}</b>
              </td>
              <td>{b.economy.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
