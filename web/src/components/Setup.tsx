import type { MatchFormat } from "../../../src/core/types";
import type { Difficulty } from "../api";
import { POOL_THEMES, themeByKey, type ThemeKey } from "../../../src/core/themes";

const FORMATS: { key: MatchFormat; title: string; text: string }[] = [
  { key: "T20", title: "T20", text: "20 overs a side. Hitters, finishers and death bowling." },
  { key: "ODI", title: "ODI", text: "50 overs a side. Build an innings; depth and spin matter." },
  { key: "TEST", title: "Test", text: "Two innings each. Patience at the top, and twenty wickets." },
];

const LEVELS: { key: Difficulty; label: string }[] = [
  { key: "easy", label: "Easy" },
  { key: "normal", label: "Normal" },
  { key: "hard", label: "Hard" },
];

export function Setup(props: {
  format: MatchFormat;
  difficulty: Difficulty;
  theme: ThemeKey;
  busy: boolean;
  onFormat: (f: MatchFormat) => void;
  onDifficulty: (d: Difficulty) => void;
  onTheme: (t: ThemeKey) => void;
  onNext: () => void;
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
      <div class="stack" style="gap:8px">
        <div class="label">Player pool</div>
        <div class="themes">
          {POOL_THEMES.map((t) => (
            <button type="button" class={props.theme === t.key ? "on" : ""} onClick={() => props.onTheme(t.key)} aria-pressed={props.theme === t.key}>
              {t.label}
            </button>
          ))}
        </div>
        <p class="muted" style="font-size:13px">{themeByKey(props.theme).description}</p>
      </div>
      <div class="stack" style="gap:8px">
        <div class="label">AI opponent</div>
        <div class="seg">
          {LEVELS.map((l) => (
            <button type="button" class={props.difficulty === l.key ? "on" : ""} onClick={() => props.onDifficulty(l.key)} aria-pressed={props.difficulty === l.key}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-primary" disabled={props.busy} onClick={props.onNext}>
          {props.busy ? "Setting up…" : "Next: the ground and the toss"}
        </button>
      </div>
    </div>
  );
}
