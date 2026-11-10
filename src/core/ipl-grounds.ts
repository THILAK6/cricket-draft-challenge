import type { PitchType } from "./types";

/**
 * The IPL grounds the game uses, and how Cricsheet names them (the data job matches `match`
 * against the venue string to get each ground's real par score). Pitches are the characters these
 * grounds are known for; a ground can produce more than one.
 */
export interface IplGround {
  name: string;
  short: string;
  /** Country code of the ground (the game's region logic) */
  country: string;
  /** Regular expression source matched against Cricsheet's venue name */
  match: string;
  pitches: PitchType[];
  /** The franchise that plays its home matches here (the game's franchise themes host their draft here) */
  home?: string;
}

export const IPL_GROUNDS: IplGround[] = [
  { name: "Wankhede Stadium, Mumbai", short: "the Wankhede", country: "IND", match: "Wankhede", home: "MI", pitches: ["HIGH_SCORING_FLAT", "GREEN_SEAMER"] },
  { name: "M. Chinnaswamy Stadium, Bengaluru", short: "the Chinnaswamy", country: "IND", match: "Chinnaswamy", home: "RCB", pitches: ["HIGH_SCORING_FLAT"] },
  { name: "MA Chidambaram Stadium, Chennai", short: "Chepauk", country: "IND", match: "Chidambaram|Chepauk", home: "CSK", pitches: ["DUSTBOWL", "SLOW_LOW"] },
  { name: "Eden Gardens, Kolkata", short: "Eden Gardens", country: "IND", match: "Eden Gardens", home: "KKR", pitches: ["HIGH_SCORING_FLAT", "SLOW_LOW", "DUSTBOWL"] },
  { name: "Narendra Modi Stadium, Ahmedabad", short: "Motera", country: "IND", match: "Narendra Modi|Sardar Patel|Motera", home: "GT", pitches: ["DUSTBOWL", "HIGH_SCORING_FLAT"] },
  { name: "Arun Jaitley Stadium, Delhi", short: "the Kotla", country: "IND", match: "Arun Jaitley|Feroz Shah Kotla", home: "DC", pitches: ["SLOW_LOW", "DUSTBOWL"] },
  { name: "Rajiv Gandhi International Stadium, Hyderabad", short: "Uppal", country: "IND", match: "Rajiv Gandhi", home: "SRH", pitches: ["HIGH_SCORING_FLAT", "SLOW_LOW"] },
  { name: "Punjab Cricket Association Stadium, Mohali", short: "Mohali", country: "IND", match: "Bindra|Punjab Cricket Association", home: "PBKS", pitches: ["GREEN_SEAMER", "HIGH_SCORING_FLAT"] },
  { name: "Sawai Mansingh Stadium, Jaipur", short: "Jaipur", country: "IND", match: "Sawai Mansingh", home: "RR", pitches: ["SLOW_LOW", "DUSTBOWL", "HIGH_SCORING_FLAT"] },
  { name: "Ekana Stadium, Lucknow", short: "Lucknow", country: "IND", match: "Ekana|BRSABV", home: "LSG", pitches: ["SLOW_LOW", "DUSTBOWL"] },
  { name: "Dubai International Stadium", short: "Dubai", country: "UAE", match: "Dubai International|Dubai Sports City", pitches: ["SLOW_LOW", "HIGH_SCORING_FLAT"] },
  { name: "Sharjah Cricket Stadium", short: "Sharjah", country: "UAE", match: "Sharjah", pitches: ["SLOW_LOW", "DUSTBOWL"] },
  { name: "Sheikh Zayed Stadium, Abu Dhabi", short: "Abu Dhabi", country: "UAE", match: "Sheikh Zayed|Zayed Cricket", pitches: ["SLOW_LOW", "DUSTBOWL"] },
];

/** The IPL ground a Cricsheet venue name refers to, if it is one of the game's. */
export function iplGroundOf(venue: string): string | undefined {
  return IPL_GROUNDS.find((g) => new RegExp(g.match, "i").test(venue))?.name;
}
