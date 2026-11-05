import type { Challenge, Constraint, MatchFormat, PitchType } from "../core/types";

/**
 * Builds a different match scenario every time: a ground, the conditions on the day and a set of
 * selection rules, all picked at random. The caller checks the result against the actual pool
 * (checkDraftFeasibility), so a combination nobody can satisfy is simply discarded.
 */

interface Ground {
  name: string;
  short: string;
  country: string;
  /** Pitches this ground can plausibly produce. */
  pitches: PitchType[];
  formats: MatchFormat[];
}

const ALL: MatchFormat[] = ["T20", "ODI", "TEST"];
const GROUNDS: Ground[] = [
  { name: "Lord's Cricket Ground, London", short: "Lord's", country: "ENG", pitches: ["GREEN_SEAMER", "SLOW_LOW"], formats: ALL },
  { name: "Edgbaston, Birmingham", short: "Edgbaston", country: "ENG", pitches: ["GREEN_SEAMER", "HIGH_SCORING_FLAT"], formats: ALL },
  { name: "Headingley, Leeds", short: "Headingley", country: "ENG", pitches: ["GREEN_SEAMER"], formats: ALL },
  { name: "The Oval, London", short: "The Oval", country: "ENG", pitches: ["HIGH_SCORING_FLAT", "DUSTBOWL", "GREEN_SEAMER"], formats: ALL },
  { name: "Melbourne Cricket Ground", short: "the MCG", country: "AUS", pitches: ["HIGH_SCORING_FLAT", "SLOW_LOW", "GREEN_SEAMER"], formats: ALL },
  { name: "The Gabba, Brisbane", short: "the Gabba", country: "AUS", pitches: ["GREEN_SEAMER", "HIGH_SCORING_FLAT"], formats: ALL },
  { name: "WACA Ground, Perth", short: "the WACA", country: "AUS", pitches: ["GREEN_SEAMER", "HIGH_SCORING_FLAT"], formats: ALL },
  { name: "Sydney Cricket Ground", short: "the SCG", country: "AUS", pitches: ["DUSTBOWL", "HIGH_SCORING_FLAT", "SLOW_LOW"], formats: ALL },
  { name: "Adelaide Oval", short: "Adelaide Oval", country: "AUS", pitches: ["HIGH_SCORING_FLAT", "SLOW_LOW"], formats: ALL },
  { name: "Eden Gardens, Kolkata", short: "Eden Gardens", country: "IND", pitches: ["DUSTBOWL", "HIGH_SCORING_FLAT", "SLOW_LOW"], formats: ALL },
  { name: "Wankhede Stadium, Mumbai", short: "the Wankhede", country: "IND", pitches: ["HIGH_SCORING_FLAT", "GREEN_SEAMER"], formats: ALL },
  { name: "M. Chinnaswamy Stadium, Bengaluru", short: "the Chinnaswamy", country: "IND", pitches: ["HIGH_SCORING_FLAT"], formats: ["T20", "ODI"] },
  { name: "MA Chidambaram Stadium, Chennai", short: "Chepauk", country: "IND", pitches: ["DUSTBOWL", "SLOW_LOW"], formats: ALL },
  { name: "Narendra Modi Stadium, Ahmedabad", short: "Motera", country: "IND", pitches: ["DUSTBOWL", "HIGH_SCORING_FLAT"], formats: ALL },
  { name: "Wanderers Stadium, Johannesburg", short: "the Wanderers", country: "RSA", pitches: ["HIGH_SCORING_FLAT", "GREEN_SEAMER"], formats: ALL },
  { name: "Newlands, Cape Town", short: "Newlands", country: "RSA", pitches: ["GREEN_SEAMER", "SLOW_LOW"], formats: ALL },
  { name: "Kingsmead, Durban", short: "Kingsmead", country: "RSA", pitches: ["GREEN_SEAMER", "SLOW_LOW"], formats: ALL },
  { name: "SuperSport Park, Centurion", short: "Centurion", country: "RSA", pitches: ["GREEN_SEAMER", "HIGH_SCORING_FLAT"], formats: ALL },
  { name: "Galle International Stadium", short: "Galle", country: "SL", pitches: ["DUSTBOWL"], formats: ALL },
  { name: "R. Premadasa Stadium, Colombo", short: "the Premadasa", country: "SL", pitches: ["DUSTBOWL", "SLOW_LOW"], formats: ALL },
  { name: "Pallekele International Cricket Stadium", short: "Pallekele", country: "SL", pitches: ["DUSTBOWL", "SLOW_LOW", "HIGH_SCORING_FLAT"], formats: ALL },
  { name: "Gaddafi Stadium, Lahore", short: "Gaddafi Stadium", country: "PAK", pitches: ["HIGH_SCORING_FLAT", "DUSTBOWL"], formats: ALL },
  { name: "National Stadium, Karachi", short: "the National Stadium", country: "PAK", pitches: ["HIGH_SCORING_FLAT", "SLOW_LOW", "DUSTBOWL"], formats: ALL },
  { name: "Dubai International Stadium", short: "Dubai", country: "UAE", pitches: ["SLOW_LOW", "HIGH_SCORING_FLAT"], formats: ["T20", "ODI"] },
  { name: "Sheikh Zayed Stadium, Abu Dhabi", short: "Abu Dhabi", country: "UAE", pitches: ["SLOW_LOW", "DUSTBOWL"], formats: ALL },
  { name: "Eden Park, Auckland", short: "Eden Park", country: "NZL", pitches: ["HIGH_SCORING_FLAT", "GREEN_SEAMER"], formats: ["T20", "ODI"] },
  { name: "Basin Reserve, Wellington", short: "the Basin Reserve", country: "NZL", pitches: ["GREEN_SEAMER", "SLOW_LOW"], formats: ALL },
  { name: "Hagley Oval, Christchurch", short: "Hagley Oval", country: "NZL", pitches: ["GREEN_SEAMER", "HIGH_SCORING_FLAT"], formats: ALL },
  { name: "Sabina Park, Kingston", short: "Sabina Park", country: "WI", pitches: ["SLOW_LOW", "GREEN_SEAMER"], formats: ALL },
  { name: "Kensington Oval, Bridgetown", short: "Kensington Oval", country: "WI", pitches: ["HIGH_SCORING_FLAT", "GREEN_SEAMER"], formats: ALL },
  { name: "Shere Bangla National Stadium, Dhaka", short: "Mirpur", country: "BAN", pitches: ["DUSTBOWL", "SLOW_LOW"], formats: ALL },
  { name: "Harare Sports Club", short: "Harare", country: "ZIM", pitches: ["SLOW_LOW", "GREEN_SEAMER"], formats: ALL },
];

interface Condition {
  label: string;
  /** Sentence fragments describing the day. */
  text: string;
  /** Pitches this condition makes sense with. */
  pitches: PitchType[];
  formats?: MatchFormat[];
}

const CONDITIONS: Condition[] = [
  { label: "Under Cloud Cover", text: "Heavy cloud hangs low and the ball is swinging from the first over.", pitches: ["GREEN_SEAMER", "SLOW_LOW"] },
  { label: "Morning Moisture", text: "Dew on the grass and moisture in the surface give the new ball a lively start.", pitches: ["GREEN_SEAMER"] },
  { label: "Day-Night Showdown", text: "Played under lights with a pink-ball feel: the twilight period is the hardest time to bat.", pitches: ["GREEN_SEAMER", "SLOW_LOW", "HIGH_SCORING_FLAT"], formats: ["TEST", "ODI"] },
  { label: "Under The Lights", text: "A night match with heavy dew expected, so the side bowling second will struggle to grip the ball.", pitches: ["HIGH_SCORING_FLAT", "SLOW_LOW", "DUSTBOWL"], formats: ["T20", "ODI"] },
  { label: "Heatwave", text: "Forty degrees and a baked surface. Fielders will tire and the pitch will keep deteriorating.", pitches: ["DUSTBOWL", "SLOW_LOW", "HIGH_SCORING_FLAT"] },
  { label: "Cracked Surface", text: "Visible cracks and a dry, worn square. Turn and uneven bounce will take over as the match goes on.", pitches: ["DUSTBOWL", "SLOW_LOW"] },
  { label: "Batting Paradise", text: "A true, hard surface and a lightning outfield. Boundaries are on offer for anyone who gets set.", pitches: ["HIGH_SCORING_FLAT"] },
  { label: "Slow Burner", text: "A tacky, low surface where shots stick in the pitch. Cutters, change of pace and spin choke the scoring.", pitches: ["SLOW_LOW", "DUSTBOWL"] },
  { label: "Sea Breeze", text: "A strong breeze blows across the ground, helping swing for one end and seam for the other.", pitches: ["GREEN_SEAMER", "SLOW_LOW", "HIGH_SCORING_FLAT"] },
  { label: "Crowd Cauldron", text: "A sell-out crowd and a short boundary. Nerve matters as much as skill today.", pitches: ["HIGH_SCORING_FLAT", "SLOW_LOW", "DUSTBOWL", "GREEN_SEAMER"], formats: ["T20", "ODI"] },
  { label: "Grassy Opener", text: "A well-grassed pitch that will ease as the sun comes out; the first session is the key.", pitches: ["GREEN_SEAMER"], formats: ["TEST", "ODI"] },
  { label: "Day Four Crumble", text: "The pitch has been used for days, and the ball is turning and keeping low.", pitches: ["DUSTBOWL", "SLOW_LOW"], formats: ["TEST"] },
];

const PITCH_FLAVOUR: Record<PitchType, string> = {
  GREEN_SEAMER: "Pace and seam are the weapon of choice, and the top order must leave well.",
  DUSTBOWL: "Spin will play a big part and batters need soft hands against turn.",
  HIGH_SCORING_FLAT: "Expect runs; the bowlers need variations and discipline to survive.",
  SLOW_LOW: "Run-scoring is hard work, so accurate bowling and smart rotation of strike win games.",
};

type Rand = () => number;
const pick = <T,>(xs: T[], rand: Rand): T => xs[Math.floor(rand() * xs.length)];

function buildConstraints(format: MatchFormat, ground: Ground, pitch: PitchType, rand: Rand): Constraint[] {
  const out: Constraint[] = [];
  // Country cap, usually with a home-side allowance
  const cap = pick([2, 2, 3], rand);
  out.push({ type: "max_per_country", value: cap, ...(rand() < 0.6 ? { exceptions: { [ground.country]: cap + 1 } } : {}) });

  // Bowling-attack rule driven by the conditions
  const attack: Constraint[] = [];
  if (pitch === "GREEN_SEAMER") attack.push({ type: "min_category", category: "PACE", count: pick([2, 3], rand) });
  else if (pitch === "DUSTBOWL") attack.push({ type: "min_category", category: "SPIN", count: pick([1, 2], rand) });
  else if (pitch === "SLOW_LOW") attack.push(rand() < 0.5 ? { type: "min_category", category: "SPIN", count: 1 } : { type: "min_category", category: "PACE", count: 2 });
  else attack.push(pick<Constraint>([
    { type: "min_category", category: "PACE", count: 2 },
    { type: "min_category", category: "SPIN", count: 1 },
    { type: "min_category", category: "AR", count: 2 },
  ], rand));
  out.push(...attack);

  // Optional extra criteria, so no two scenarios read the same
  const extras: Constraint[] = [
    { type: "batting_hand_order", positions: [pick([1, 2, 3], rand)], hand: pick<"LHB" | "RHB">(["LHB", "LHB", "RHB"], rand) },
    { type: "min_category", category: "AR", count: pick([1, 2], rand) },
    { type: "min_strike_rate_top_order", threshold: format === "T20" ? 125 : format === "ODI" ? 78 : 50 },
    { type: "min_bowlers_economy_under", threshold: format === "T20" ? 8.5 : format === "ODI" ? 5.6 : 3.4, min_count: pick([2, 3], rand) },
  ];
  if (rand() < 0.6) out.push(pick(extras, rand));
  if (rand() < 0.2) out.push(pick(extras, rand));
  // Drop duplicates of the same rule type + category
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = c.type + ("category" in c ? c.category : "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A random scenario for the format. Not guaranteed playable: check it against the pool. */
export function generateScenario(format: MatchFormat, rand: Rand = Math.random): Omit<Challenge, "id"> {
  const ground = pick(GROUNDS.filter((g) => g.formats.includes(format)), rand);
  const pitch = pick(ground.pitches, rand);
  const options = CONDITIONS.filter((c) => c.pitches.includes(pitch) && (!c.formats || c.formats.includes(format)));
  const condition = pick(options.length ? options : CONDITIONS, rand);
  const constraints = buildConstraints(format, ground, pitch, rand);
  const dayNote = format === "TEST" ? "A five-day contest." : format === "ODI" ? "Fifty overs a side." : "Twenty overs a side.";
  return {
    title: `${ground.short.replace(/^the /, "").replace(/^./, (c) => c.toUpperCase())}: ${condition.label}`,
    format,
    venue: { name: ground.name, country: ground.country, pitch_type: pitch },
    narrative_intro: `${condition.text} ${PITCH_FLAVOUR[pitch]} ${dayNote}`,
    constraints,
  };
}
