import { useState } from "preact/hooks";
import type { InningsScorecard, MatchSimulationResult } from "../../../src/core/simulator";
import { PITCH_LABEL, shortName } from "../format";
import type { RoomProps } from "./Draft";

const score = (i?: InningsScorecard) => (i ? `${i.totalRuns}/${i.totalWickets}${i.declared ? "d" : ""}` : "");
// An innings that never started (an innings win) is left out of the score line
const scoreLine = (a?: InningsScorecard, b?: InningsScorecard) =>
  [a, b].filter((i): i is InningsScorecard => !!i && i.totalBalls > 0).map((i) => (i.totalWickets >= 10 ? `${i.totalRuns}` : score(i))).join(" & ");

/** The match result: score line first, then why it went that way, then the full scorecards. */
export function Result(props: RoomProps) {
  const sim = props.state.simulation as MatchSimulationResult | undefined;
  const results = props.state.results;
  const [shown, setShown] = useState("u1");
  if (!sim) return <div class="loading">No result yet.</div>;
  const test = sim.format === "TEST";
  const headline =
    sim.winner === "USER" ? "You won" : sim.winner === "AI" ? "The AI won" : sim.winner === "DRAW" ? "Match drawn" : "Match tied";
  const sel = sim.selection;
  const perf = sim.performance;

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

      {sel && (
        <div class="card stack" style="gap:10px">
          <div class="label">Your selection</div>
          <p style="font-weight:700">{sel.headline}</p>
          <div class="cmp">
            <span class="l you">You</span>
            <span class="lbl" />
            <span class="r ai">AI</span>
            {sel.categories.map((c) => (
              <>
                <span class={`l ${c.user > c.ai ? "good" : ""}`}>{fmtPts(c.user)}</span>
                <span class="lbl">
                  {c.label} <span class="faint">/{c.max}</span>
                </span>
                <span class={`r ${c.ai > c.user ? "good" : ""}`}>{fmtPts(c.ai)}</span>
              </>
            ))}
          </div>
          {sel.userPoints.length > 0 && (
            <div>
              <div class="label" style="margin-bottom:4px">What your picks did</div>
              <ul class="pts">
                {sel.userPoints.map((p) => (
                  <li class={p.tone === "good" ? "" : "muted"}>
                    {p.tone === "good" ? "✓ " : "✗ "}
                    {p.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {sel.nextTime.length > 0 && (
            <div>
              <div class="label" style="margin-bottom:4px">Next time</div>
              <ul class="pts">
                {sel.nextTime.map((t) => (
                  <li>{t}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {(results?.decisiveDifference || sim.keyMoments.length > 0) && (
        <div class="card stack" style="gap:8px">
          <div class="label">How it was decided</div>
          {results?.decisiveDifference && <p>{results.decisiveDifference}</p>}
          {sim.keyMoments.slice(0, 5).map((m) => (
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

      {perf && (
        <details class="box">
          <summary>Team report</summary>
          <div class="inner">
            <div class="cmp">
              <span class="l you">You</span>
              <span class="lbl" />
              <span class="r ai">AI</span>
              {(
                [
                  ["Batting", perf.USER.battingScore, perf.AI.battingScore],
                  ["Bowling", perf.USER.bowlingScore, perf.AI.bowlingScore],
                  ["Fielding", perf.USER.fieldingScore, perf.AI.fieldingScore],
                  ["Overall", perf.USER.overallScore, perf.AI.overallScore],
                  ["Sixes", perf.USER.stats.sixes, perf.AI.stats.sixes],
                  ["Fours", perf.USER.stats.fours, perf.AI.stats.fours],
                  ["Dropped catches", perf.USER.stats.droppedCatches, perf.AI.stats.droppedCatches],
                ] as [string, number, number][]
              ).map(([label, u, a]) => (
                <>
                  <span class="l">{Math.round(u)}</span>
                  <span class="lbl">{label}</span>
                  <span class="r">{Math.round(a)}</span>
                </>
              ))}
            </div>
          </div>
        </details>
      )}

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

const fmtPts = (x: number) => (Number.isInteger(x) ? `${x}` : x.toFixed(1));

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
