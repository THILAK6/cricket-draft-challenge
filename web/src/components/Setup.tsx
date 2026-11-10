import type { Mode } from "../format";
import type { Difficulty } from "../api";
import { IPL_THEMES, POOL_THEMES, type ThemeKey } from "../../../src/core/themes";
import { PERSONA_INFO } from "../../../src/core/personas";
import { MyMatches } from "./MyMatches";
import { IPL_LABEL } from "../format";

const FORMATS: { key: Mode; title: string; text: string }[] = [
  { key: "T20", title: "T20", text: "20 overs a side. Hitters, finishers and death bowling." },
  { key: "ODI", title: "ODI", text: "50 overs a side. Build an innings; depth and spin matter." },
  { key: "TEST", title: "Test", text: "Two innings each. Patience at the top, and twenty wickets." },
  { key: "IPL", title: IPL_LABEL, text: "T20 with the league's players, 2008 to now. At most four overseas in your XI." },
];

const LEVELS: { key: Difficulty; level: string }[] = [
  { key: "easy", level: "Easy" },
  { key: "normal", level: "Normal" },
  { key: "hard", level: "Hard" },
];

export function Setup(props: {
  format: Mode;
  difficulty: Difficulty;
  theme: ThemeKey;
  busy: boolean;
  onFormat: (f: Mode) => void;
  onDifficulty: (d: Difficulty) => void;
  onTheme: (t: ThemeKey) => void;
  onNext: () => void;
  onOpenMatch: (id: string) => void;
  /** IPL: an auction instead of a snake draft, and how the AI bids in one */
  auction: boolean;
  bidStyle: "calculated" | "impulsive";
  onAuction: (on: boolean) => void;
  onBidStyle: (s: "calculated" | "impulsive") => void;
}) {
  return (
    <div class="wizard">
      <div class="steps" aria-hidden="true">
        <span class="on" />
        <span />
        <span />
      </div>
      <div class="stack" style="gap:6px">
        <h1>Draft your XI</h1>
        <p class="muted">You and the AI take turns picking from one pool of players. Picks are final, so think before you tap.</p>
      </div>
      <div class="stack" style="gap:8px">
        <div class="label">Format</div>
        {FORMATS.map((f) => (
          <button type="button" class={`choice ${props.format === f.key ? "on" : ""}`} onClick={() => props.onFormat(f.key)} aria-pressed={props.format === f.key}>
            <b>{f.title}</b>
            <span class="muted">{f.text}</span>
          </button>
        ))}
      </div>
      {props.format === "IPL" && (
        <div class="stack" style="gap:8px">
          <div class="label">How to draft</div>
          <div class="seg" style="grid-template-columns:1fr 1fr">
            <button type="button" class={!props.auction ? "on" : ""} onClick={() => props.onAuction(false)} aria-pressed={!props.auction}>
              <span style="display:block">Snake draft</span>
              <span class="faint" style="display:block;font-size:11px;font-weight:600">take turns</span>
            </button>
            <button type="button" class={props.auction ? "on" : ""} onClick={() => props.onAuction(true)} aria-pressed={props.auction}>
              <span style="display:block">Auction</span>
              <span class="faint" style="display:block;font-size:11px;font-weight:600">bid with a purse</span>
            </button>
          </div>
          {props.auction ? (
            <>
              <p class="muted" style="font-size:13px">60 crore each. Players come up one at a time: the six best first, then batters, keepers, all-rounders, fast bowlers and spinners. Bid a step up or pass; the last bid wins.</p>
              <div class="label" style="margin-top:4px">The rival bids</div>
              <div class="seg" style="grid-template-columns:1fr 1fr">
                <button type="button" class={props.bidStyle === "calculated" ? "on" : ""} onClick={() => props.onBidStyle("calculated")} aria-pressed={props.bidStyle === "calculated"}>
                  <span style="display:block">Calculated</span>
                  <span class="faint" style="display:block;font-size:11px;font-weight:600">to its valuation</span>
                </button>
                <button type="button" class={props.bidStyle === "impulsive" ? "on" : ""} onClick={() => props.onBidStyle("impulsive")} aria-pressed={props.bidStyle === "impulsive"}>
                  <span style="display:block">Impulsive</span>
                  <span class="faint" style="display:block;font-size:11px;font-weight:600">gets carried away</span>
                </button>
              </div>
              <p class="muted" style="font-size:13px">
                {props.bidStyle === "calculated"
                  ? "It never pays more than a player is worth to its XI. Predictable: win the auction by valuing players better than it does."
                  : "It bids like a person: a bad day or a good one, a premium for famous names, and it gets carried away in a bidding war. It can blow its purse early, and sometimes lets a bargain go."}
              </p>
            </>
          ) : null}
        </div>
      )}
      <div class="stack" style="gap:8px">
        <div class="label">Player pool</div>
        <div class="themes">
          {(props.format === "IPL" ? IPL_THEMES : POOL_THEMES).map((t) => (
            <button type="button" class={props.theme === t.key ? "on" : ""} onClick={() => props.onTheme(t.key)} aria-pressed={props.theme === t.key}>
              {t.label}
            </button>
          ))}
        </div>
        <p class="muted" style="font-size:13px">{((props.format === "IPL" ? IPL_THEMES : POOL_THEMES).find((t) => t.key === props.theme) ?? (props.format === "IPL" ? IPL_THEMES : POOL_THEMES)[0]).description}</p>
      </div>
      <div class="stack" style="gap:8px">
        <div class="label">Your opponent</div>
        <div class="seg">
          {LEVELS.map((l) => (
            <button type="button" class={props.difficulty === l.key ? "on" : ""} onClick={() => props.onDifficulty(l.key)} aria-pressed={props.difficulty === l.key}>
              <span style="display:block">{PERSONA_INFO[l.key].short}</span>
              <span class="faint" style="display:block;font-size:11px;font-weight:600">{l.level}</span>
            </button>
          ))}
        </div>
        <p class="muted" style="font-size:13px">{PERSONA_INFO[props.difficulty].blurb}</p>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-primary" disabled={props.busy} onClick={props.onNext}>
          {props.busy ? "Setting up…" : "Next: the ground and the toss"}
        </button>
      </div>
      <MyMatches onOpen={props.onOpenMatch} />
    </div>
  );
}
