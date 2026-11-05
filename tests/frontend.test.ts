import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function loadEsc(): (v: unknown) => string {
  const m = html.match(/function esc\(v\) \{[\s\S]*?\n    \}/);
  if (!m) throw new Error("esc() helper not found in public/index.html");
  return new Function(`${m[0]}; return esc;`)() as (v: unknown) => string;
}

describe("front-end HTML safety", () => {
  it("esc() neutralises markup and quotes", () => {
    const esc = loadEsc();
    expect(esc(`<img src=x onerror="alert(1)">`)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(esc("O'Brien & Co")).toBe("O&#39;Brien &amp; Co");
    expect(esc(null)).toBe("");
    expect(esc(42)).toBe("42");
  });

  it("never interpolates data-derived text into innerHTML without esc()", () => {
    // Fields that come from the database, the simulator or Gemini.
    const risky = /\$\{\s*(?:[\w.]*\.(?:name|country|title|description|dismissal|highlight|pitchBehavior|stumpsScore|teamName|summary)|message|desc)\s*\}/g;
    const offenders: string[] = [];
    const lines = html.split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("${")) return;
      const hits = line.replace(/slotDefs?(\[[^\]]*\])?\.name/g, "").match(risky); // slot names are static constants
      if (!hits) return;
      // Plain-text sinks are safe: innerText/textContent/title/showToast arguments and string building.
      if (/\.(innerText|textContent|title|value|placeholder)\s*=/.test(line) || /showToast\(/.test(line)) return;
      if (/reason:|desc = |const |return `|slotSubStats|statDisplay/.test(line)) return;
      offenders.push(`${i + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });

  it("page script parses", () => {
    const m = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
    expect(m).not.toBeNull();
    expect(() => new Function(m![1])).not.toThrow();
  });
});
