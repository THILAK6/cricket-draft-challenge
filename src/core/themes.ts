/**
 * Pool themes: which players a draft is drawn from. "mixed" (any era, all Full Members) is the
 * default; the others narrow the pool the way friends set a theme before a school draft.
 * Pure data, shared by the Worker and the UI.
 */
export type ThemeKey = "mixed" | "legends" | "noughties" | "modern" | "ind-aus" | "ashes" | "ind-pak";

export interface PoolTheme {
  key: ThemeKey;
  label: string;
  description: string;
  /** Only players from these countries (and grounds in them). */
  countries?: string[];
  /** Mid-career year range, inclusive. */
  era?: [number, number];
  /** Only the format's top players by stature. */
  legendsOnly?: number;
}

export const POOL_THEMES: PoolTheme[] = [
  { key: "mixed", label: "Mixed", description: "Any era, every Test nation. Stars and squad players." },
  { key: "legends", label: "All-time greats", description: "Only the format's biggest names. Every pick is a star.", legendsOnly: 120 },
  { key: "noughties", label: "The 2000s", description: "Players whose careers peaked up to 2010.", era: [1990, 2010] },
  { key: "modern", label: "Modern era", description: "Players whose careers peaked from 2016 on.", era: [2016, 2100] },
  { key: "ind-aus", label: "India v Australia", description: "Only Indian and Australian players.", countries: ["IND", "AUS"] },
  { key: "ashes", label: "The Ashes", description: "Only English and Australian players.", countries: ["ENG", "AUS"] },
  { key: "ind-pak", label: "India v Pakistan", description: "Only Indian and Pakistani players.", countries: ["IND", "PAK"] },
];

export const themeByKey = (key: string | undefined): PoolTheme => POOL_THEMES.find((t) => t.key === key) ?? POOL_THEMES[0];
