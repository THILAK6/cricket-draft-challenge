/**
 * Pool themes: which players a draft is drawn from. "mixed" (any era, all Full Members) is the
 * default; the others narrow the pool the way friends set a theme before a school draft.
 * Pure data, shared by the Worker and the UI.
 */
export type ThemeKey = "mixed" | "legends" | "noughties" | "modern" | "ind-aus" | "ashes" | "ind-pak" | "ipl-all" | "ipl-modern" | "ipl-classic" | "ipl-legends" | `ipl-${string}`;

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
  /** IPL: only players who have turned out for one of these franchises (codes), and grounds that are their homes. */
  franchises?: string[];
}

/** The IPL franchises the game knows, by code. */
export const FRANCHISE_NAME: Record<string, string> = {
  CSK: "Chennai Super Kings", MI: "Mumbai Indians", RCB: "Royal Challengers", KKR: "Kolkata Knight Riders", DC: "Delhi Capitals",
  PBKS: "Punjab Kings", RR: "Rajasthan Royals", SRH: "Sunrisers Hyderabad", GT: "Gujarat Titans", LSG: "Lucknow Super Giants",
};
const club = (code: string): PoolTheme => ({ key: `ipl-${code.toLowerCase()}`, label: FRANCHISE_NAME[code], description: `Everyone who has played for ${FRANCHISE_NAME[code]}, at their home ground.`, franchises: [code] });
const rivalry = (a: string, b: string, label: string): PoolTheme => ({ key: `ipl-${a.toLowerCase()}-${b.toLowerCase()}`, label, description: `Players of ${FRANCHISE_NAME[a]} and ${FRANCHISE_NAME[b]}, at one of their grounds.`, franchises: [a, b] });

export const POOL_THEMES: PoolTheme[] = [
  { key: "mixed", label: "Mixed", description: "Any era, every Test nation. Stars and squad players." },
  { key: "legends", label: "All-time greats", description: "Only the format's biggest names. Every pick is a star.", legendsOnly: 120 },
  { key: "noughties", label: "The 2000s", description: "Players whose careers peaked up to 2010.", era: [1990, 2010] },
  { key: "modern", label: "Modern era", description: "Players whose careers peaked from 2016 on.", era: [2016, 2100] },
  { key: "ind-aus", label: "India v Australia", description: "Only Indian and Australian players.", countries: ["IND", "AUS"] },
  { key: "ashes", label: "The Ashes", description: "Only English and Australian players.", countries: ["ENG", "AUS"] },
  { key: "ind-pak", label: "India v Pakistan", description: "Only Indian and Pakistani players.", countries: ["IND", "PAK"] },
];

/** The IPL's themes: era is the middle season of a player's IPL career. */
export const IPL_THEMES: PoolTheme[] = [
  { key: "ipl-all", label: "All seasons", description: "Every IPL season, 2008 to now. Stars and squad players." },
  { key: "ipl-legends", label: "IPL legends", description: "Only the league's biggest names. Every pick is a star.", legendsOnly: 80 },
  { key: "ipl-modern", label: "Recent seasons", description: "Players whose IPL careers peaked from 2019 on.", era: [2019, 2100] },
  { key: "ipl-classic", label: "The early years", description: "Players whose IPL careers peaked up to 2015.", era: [2007, 2015] },
  // Franchise themes: a club's players, or two clubs' (the pool comes from the IPL career of anyone who turned out for them)
  rivalry("CSK", "MI", "CSK v MI"),
  rivalry("RCB", "KKR", "RCB v KKR"),
  rivalry("DC", "PBKS", "DC v PBKS"),
  rivalry("RR", "SRH", "RR v SRH"),
  club("CSK"), club("MI"), club("RCB"), club("KKR"),
];

export const themeByKey = (key: string | undefined): PoolTheme => POOL_THEMES.find((t) => t.key === key) ?? POOL_THEMES[0];
export const iplThemeByKey = (key: string | undefined): PoolTheme => IPL_THEMES.find((t) => t.key === key) ?? IPL_THEMES[0];
export const themesFor = (league?: "IPL"): PoolTheme[] => (league === "IPL" ? IPL_THEMES : POOL_THEMES);
