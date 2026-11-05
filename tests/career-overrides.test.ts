import { describe, it, expect } from "vitest";
import { parseInfobox } from "../src/etl/career-overrides";

const sample = `{{Infobox cricketer
| name = Test Player
| columns = 3
| column1 = [[Test cricket|Test]]
| matches1 = 200
| runs1 = 15,921
| bat avg1 = 53.78
| deliveries1 = 4,240
| wickets1 = 46
| bowl avg1 = 54.17
| column2 = [[One Day International|ODI]]
| matches2 = 463
| runs2 = 18,426
| bat avg2 = 44.83
| deliveries2 = 8,054
| wickets2 = 154
| bowl avg2 = 44.48
| column3 = [[First-class cricket|FC]]
| matches3 = 310
| runs3 = 25,396
| bat avg3 = 57.84
}}`;

describe("career infobox parser", () => {
  it("reads Test and ODI columns with thousands separators and ignores other columns", () => {
    const c = parseInfobox(sample);
    expect(c.TEST).toMatchObject({ matches: 200, runs: 15921, batAvg: 53.78, deliveries: 4240, wickets: 46, bowlAvg: 54.17 });
    expect(c.ODI?.runs).toBe(18426);
    expect(c.T20).toBeUndefined();
  });

  it("returns nothing when there is no cricketer infobox", () => {
    expect(parseInfobox("{{Infobox person | name = X }}")).toEqual({});
  });
});
