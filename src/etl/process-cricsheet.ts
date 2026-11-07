import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { AthleteEnricher } from "./enricher";

interface PlayerAggregate {
  cricsheet_id: string;
  name: string;
  country: string;
  matches: number;
  // Batting
  bat_innings: number;
  bat_runs: number;
  bat_balls: number;
  bat_dismissals: number;
  top_order_innings: number;     // pos 1-2
  middle_order_innings: number;  // pos 3-6
  finisher_innings: number;      // pos 7+
  // Bowling
  bowl_innings: number;
  bowl_legal_balls: number;
  bowl_runs_conceded: number;
  bowl_wickets: number;
  // Keeper dismissals
  stumpings: number;
  catches: number;
}

const COUNTRY_MAP: Record<string, string> = {
  "India": "IND",
  "Australia": "AUS",
  "England": "ENG",
  "Pakistan": "PAK",
  "South Africa": "RSA",
  "New Zealand": "NZL",
  "West Indies": "WI",
  "Sri Lanka": "SL",
  "Bangladesh": "BAN",
  "Afghanistan": "AFG",
  "Zimbabwe": "ZIM",
  "Ireland": "IRE",
  "Netherlands": "NED",
  "Scotland": "SCO",
  "United States of America": "USA",
  "USA": "USA",
  "Nepal": "NEP",
  "Namibia": "NAM",
  "Oman": "OMA",
  "Papua New Guinea": "PNG",
  "United Arab Emirates": "UAE",
  "Canada": "CAN",
  "Indonesia": "INA",
  "Austria": "AUT",
  "Hong Kong": "HKG",
  "Kenya": "KEN",
  "Bermuda": "BER",
};

/**
 * Team name to country code. Unknown names never fall back to their first three letters: that
 * turned Indonesia into IND and Austria into AUS. They get an OTHER: code and are filtered out.
 */
const countryCode = (team: string): string => COUNTRY_MAP[team] ?? `OTHER:${team}`;

async function main() {
  const dataDir = path.resolve(process.cwd(), "data");
  const peoplePath = path.join(dataDir, "raw/people.csv");

  const formats: Array<{ name: "T20" | "ODI" | "TEST"; dir: string; minMatches: number }> = [
    { name: "T20", dir: path.join(dataDir, "raw/t20s_json"), minMatches: 8 },
    { name: "ODI", dir: path.join(dataDir, "raw/odis_json"), minMatches: 12 },
    { name: "TEST", dir: path.join(dataDir, "raw/tests_json"), minMatches: 6 },
  ];

  if (!fs.existsSync(peoplePath)) {
    console.error("[Process] Missing people.csv. Run `npm run etl:download` first.");
    process.exit(1);
  }

  // 1. Read People Register to map cricsheet_id -> cricinfo_id & unique_name
  console.log("[Process] Reading people.csv...");
  const peopleContent = fs.readFileSync(peoplePath, "utf-8");
  const peopleRecords: any[] = parse(peopleContent, {
    columns: true,
    skip_empty_lines: true,
  });

  const cricinfoIdMap = new Map<string, string>();
  const canonicalNameMap = new Map<string, string>();
  for (const record of peopleRecords) {
    if (record.key_cricinfo) {
      cricinfoIdMap.set(record.identifier, record.key_cricinfo.trim());
    }
    if (record.unique_name || record.name) {
      canonicalNameMap.set(record.identifier, record.unique_name || record.name);
    }
  }
  console.log(`[Process] Loaded ${cricinfoIdMap.size} Cricinfo ID mappings.`);

  const enricher = new AthleteEnricher();
  const allPlayersMeta = new Map<string, any>();
  const formatStatsMap = new Map<string, Array<{ agg: PlayerAggregate; format: "T20" | "ODI" | "TEST" }>>();

  for (const fmt of formats) {
    if (!fs.existsSync(fmt.dir)) {
      console.warn(`[Process] Missing directory for ${fmt.name} at ${fmt.dir}, skipping...`);
      continue;
    }

    const matchFiles = fs.readdirSync(fmt.dir).filter((f) => f.endsWith(".json"));
    console.log(`[Process] Processing ${matchFiles.length} ${fmt.name} match files...`);

    const aggregates = new Map<string, PlayerAggregate>();

    function getOrCreate(cricsheetId: string, name: string, country: string): PlayerAggregate {
      let agg = aggregates.get(cricsheetId);
      if (!agg) {
        agg = {
          cricsheet_id: cricsheetId,
          name: canonicalNameMap.get(cricsheetId) || name,
          country: countryCode(country),
          matches: 0,
          bat_innings: 0,
          bat_runs: 0,
          bat_balls: 0,
          bat_dismissals: 0,
          top_order_innings: 0,
          middle_order_innings: 0,
          finisher_innings: 0,
          bowl_innings: 0,
          bowl_legal_balls: 0,
          bowl_runs_conceded: 0,
          bowl_wickets: 0,
          stumpings: 0,
          catches: 0,
        };
        aggregates.set(cricsheetId, agg);
      }
      return agg;
    }

    let processedCount = 0;
    for (const file of matchFiles) {
      try {
        const matchRaw = fs.readFileSync(path.join(fmt.dir, file), "utf-8");
        const match = JSON.parse(matchRaw);

        if (!match.info?.players || !match.info?.registry?.people) continue;
        if (match.info?.gender !== "male") continue;

        const peopleRegistry: Record<string, string> = match.info.registry.people;
        const teamPlayers: Record<string, string[]> = match.info.players;

        // Track match appearances
        for (const [teamName, playerNames] of Object.entries(teamPlayers)) {
          for (const pName of playerNames) {
            const cId = peopleRegistry[pName];
            if (cId) {
              const agg = getOrCreate(cId, pName, teamName);
              agg.matches += 1;
            }
          }
        }

        // Process innings
        const innings = match.innings || [];
        for (const inn of innings) {
          const battingOrder: string[] = [];
          const bowlersInInnings = new Set<string>();

          const overs = inn.overs || [];
          for (const overObj of overs) {
            const deliveries = overObj.deliveries || [];
            for (const del of deliveries) {
              const batterName = del.batter;
              const nonStriker = del.non_striker;
              const bowlerName = del.bowler;

              if (!battingOrder.includes(batterName)) battingOrder.push(batterName);
              if (!battingOrder.includes(nonStriker)) battingOrder.push(nonStriker);

              const batterCId = peopleRegistry[batterName];
              if (batterCId && aggregates.has(batterCId)) {
                const bAgg = aggregates.get(batterCId)!;
                bAgg.bat_runs += del.runs?.batter || 0;
                if (!del.extras?.wides) {
                  bAgg.bat_balls += 1;
                }
              }

              const bowlerCId = peopleRegistry[bowlerName];
              if (bowlerCId && aggregates.has(bowlerCId)) {
                const bwAgg = aggregates.get(bowlerCId)!;
                bowlersInInnings.add(bowlerCId);

                const extras = del.extras || {};
                const runs = del.runs || {};
                if (!extras.wides && !extras.noballs) {
                  bwAgg.bowl_legal_balls += 1;
                }
                const conceded = (runs.batter || 0) + (extras.wides || 0) + (extras.noballs || 0) + (extras.penalties || 0);
                bwAgg.bowl_runs_conceded += conceded;

                const wickets = del.wickets || [];
                for (const w of wickets) {
                  const kind = w.kind || "";
                  const outName = w.player_out;
                  const outCId = peopleRegistry[outName];
                  if (outCId && aggregates.has(outCId)) {
                    aggregates.get(outCId)!.bat_dismissals += 1;
                  }

                  if (["bowled", "caught", "caught and bowled", "lbw", "stumped", "hit wicket"].includes(kind)) {
                    bwAgg.bowl_wickets += 1;
                  }
                  if (kind === "stumped") {
                    const fielders = w.fielders || [];
                    for (const f of fielders) {
                      const fCId = peopleRegistry[f.name];
                      if (fCId && aggregates.has(fCId)) {
                        aggregates.get(fCId)!.stumpings += 1;
                      }
                    }
                  }
                }
              }
            }
          }

          for (let idx = 0; idx < battingOrder.length; idx++) {
            const pName = battingOrder[idx];
            const pCId = peopleRegistry[pName];
            if (pCId && aggregates.has(pCId)) {
              const agg = aggregates.get(pCId)!;
              agg.bat_innings += 1;
              const position = idx + 1;
              if (position <= 2) agg.top_order_innings += 1;
              else if (position <= 6) agg.middle_order_innings += 1;
              else agg.finisher_innings += 1;
            }
          }

          for (const bCId of bowlersInInnings) {
            if (aggregates.has(bCId)) {
              aggregates.get(bCId)!.bowl_innings += 1;
            }
          }
        }

        processedCount++;
      } catch (e) {
        // Skip malformed match
      }
    }

    console.log(`[Process] Completed ${fmt.name}: ${processedCount} matches aggregated.`);

    // Filter to notable international players
    const eligible = Array.from(aggregates.values()).filter(
      (p) =>
        p.matches >= fmt.minMatches &&
        ["IND", "AUS", "ENG", "PAK", "RSA", "NZL", "WI", "SL", "BAN", "AFG", "ZIM", "IRE", "NED"].includes(p.country)
    );

    console.log(`[Process] ${fmt.name} eligible players: ${eligible.length}`);

    for (const agg of eligible) {
      if (!formatStatsMap.has(agg.cricsheet_id)) {
        formatStatsMap.set(agg.cricsheet_id, []);
      }
      formatStatsMap.get(agg.cricsheet_id)!.push({ agg, format: fmt.name });
    }
  }

  // Per-format role corrections, written to player_format_roles
  const formatRoles: { id: string; format: string; role: string }[] = [];

  // Enrich unique players
  console.log(`[Process] Total unique international players across all formats: ${formatStatsMap.size}`);
  let enrichedCount = 0;

  for (const [cricsheetId, statsList] of formatStatsMap.entries()) {
    const primaryAgg = statsList[0].agg;
    const cricinfoId = cricinfoIdMap.get(cricsheetId);

    let meta;
    if (cricinfoId) {
      meta = await enricher.getPlayerMeta(cricinfoId, primaryAgg.name);
    } else {
      meta = {
        cricinfo_id: "",
        name: primaryAgg.name,
        batting_hand: "RHB" as const,
        bowling_category: "NONE" as const,
        bowling_style: "Right-arm medium",
        primary_role: "BAT" as const,
      };
    }

    // Role correction: 90% career rule
    const totalBallsBowled = statsList.reduce((sum, s) => sum + s.agg.bowl_legal_balls, 0);
    const totalRunsScored = statsList.reduce((sum, s) => sum + s.agg.bat_runs, 0);
    const totalStumpings = statsList.reduce((sum, s) => sum + s.agg.stumpings, 0);
    const totalMatches = statsList.reduce((sum, s) => sum + s.agg.matches, 0);
    const totalBowlInnings = statsList.reduce((sum, s) => sum + s.agg.bowl_innings, 0);
    const totalBatInnings = statsList.reduce((sum, s) => sum + s.agg.bat_innings, 0);
    const totalWickets = statsList.reduce((sum, s) => sum + s.agg.bowl_wickets, 0);
    const totalDismissals = statsList.reduce((sum, s) => sum + s.agg.bat_dismissals, 0);
    const totalRunsConceded = statsList.reduce((sum, s) => sum + s.agg.bowl_runs_conceded, 0);

    const careerBatAvg = totalDismissals > 0 ? totalRunsScored / totalDismissals : (totalBatInnings > 0 ? totalRunsScored : 0);
    const careerBowlAvg = totalWickets > 0 ? totalRunsConceded / totalWickets : 999;
    const bowlRate = totalMatches > 0 ? totalBowlInnings / totalMatches : 0;
    const wpm = totalMatches > 0 ? totalWickets / totalMatches : 0;
    const avgOvers = totalMatches > 0 ? (totalBallsBowled / 6) / totalMatches : 0;

    // A keeper is someone who keeps and bowls little. One stumping in a career (Mahmudullah,
    // Dilshan) used to make a frontline bowler a keeper in every format.
    if (totalStumpings > 0 && avgOvers < 2) {
      meta.primary_role = "WK";
      meta.bowling_category = "NONE";
    } else if (
      (totalWickets >= 30 && careerBatAvg < 20.0) ||
      (bowlRate >= 0.70 && careerBatAvg < 22.0) ||
      (totalBallsBowled > 1500 && careerBatAvg < 20.0)
    ) {
      // Pure Bowler (James Anderson, Stuart Broad, Steyn, Bumrah, Starc, etc.)
      meta.primary_role = "BOWL";
    } else if (
      (totalRunsScored > 800 && (careerBowlAvg > 42.0 || wpm < 0.50 || bowlRate < 0.32)) ||
      totalBallsBowled < 300 ||
      avgOvers < 1.5
    ) {
      // Pure Batter (Joe Root, Rohit Sharma, Virat Kohli, Babar Azam, Steve Smith, etc.)
      meta.primary_role = "BAT";
      meta.bowling_category = "NONE";
    } else if (
      careerBatAvg >= 22.0 &&
      careerBowlAvg <= 42.0 &&
      totalWickets >= 15 &&
      wpm >= 0.55 &&
      bowlRate >= 0.38
    ) {
      // Genuine All-Rounder (Ben Stokes, Jadeja, Shakib, Hardik, Kallis, Maxwell, etc.)
      meta.primary_role = "AR";
    } else if (bowlRate >= 0.60) {
      meta.primary_role = "BOWL";
    } else {
      meta.primary_role = "BAT";
      meta.bowling_category = "NONE";
    }

    // Frontline bowlers and all-rounders MUST have PACE or SPIN category
    if (meta.primary_role === "BOWL" || meta.primary_role === "AR") {
      const style = (meta.bowling_style || "").toLowerCase();
      if (
        style.includes("spin") ||
        style.includes("slow") ||
        style.includes("break") ||
        style.includes("orthodox") ||
        style.includes("chinaman") ||
        style.includes("googly")
      ) {
        meta.bowling_category = "SPIN";
      } else {
        meta.bowling_category = "PACE";
      }
    }

    // Strict constraint: Pure BAT and WK MUST have bowling_category "NONE"
    // so they never appear under Spinners or Fast Bowlers
    if (meta.primary_role === "BAT" || meta.primary_role === "WK") {
      meta.bowling_category = "NONE";
    }

    // Keepers by format: a keeper with 10+ matches and no stumpings in a format played there as a
    // batter (Rahul Dravid, KL Rahul and Tom Latham in Tests)
    if (meta.primary_role === "WK") {
      for (const { agg, format } of statsList) {
        if (agg.matches >= 10 && agg.stumpings === 0) formatRoles.push({ id: `crick_${cricsheetId}`, format, role: "BAT" });
      }
    }

    allPlayersMeta.set(cricsheetId, { meta, country: primaryAgg.country });
    enrichedCount++;
    if (enrichedCount % 100 === 0 || enrichedCount === formatStatsMap.size) {
      console.log(`[Process] Enriched ${enrichedCount} / ${formatStatsMap.size} player profiles...`);
      enricher.saveCache();
    }
  }

  // Generate seed.sql
  console.log("[Process] Generating multi-format data/seed.sql...");
  const sqlLines: string[] = [
    "-- Auto-generated multi-format (T20, ODI, TEST) seed data",
  ];

  for (const [cricsheetId, { meta, country }] of allPlayersMeta.entries()) {
    const pId = `crick_${cricsheetId}`;
    const cleanName = meta.name.replace(/'/g, "''");
    const cleanStyle = (meta.bowling_style || "").replace(/'/g, "''");

    sqlLines.push(
      `INSERT OR REPLACE INTO players (id, cricinfo_id, name, country, batting_hand, bowling_category, bowling_style, primary_role) VALUES ('${pId}', '${meta.cricinfo_id}', '${cleanName}', '${country}', '${meta.batting_hand}', '${meta.bowling_category}', '${cleanStyle}', '${meta.primary_role}');`
    );
  }

  for (const [cricsheetId, statsList] of formatStatsMap.entries()) {
    const pId = `crick_${cricsheetId}`;
    for (const { agg, format } of statsList) {
      const batAvg = agg.bat_innings > 0 ? (agg.bat_runs / Math.max(1, agg.bat_dismissals || 1)).toFixed(2) : "0.0";
      const batSr = agg.bat_balls > 0 ? ((agg.bat_runs / agg.bat_balls) * 100).toFixed(2) : "0.0";
      const bowlOvers = (agg.bowl_legal_balls / 6).toFixed(1);
      const bowlAvg = agg.bowl_wickets > 0 ? (agg.bowl_runs_conceded / agg.bowl_wickets).toFixed(2) : "0.0";
      const bowlEcon = agg.bowl_legal_balls > 0 ? ((agg.bowl_runs_conceded / agg.bowl_legal_balls) * 6).toFixed(2) : "0.0";

      sqlLines.push(
        `INSERT OR REPLACE INTO player_format_stats (player_id, format, matches, bat_innings, bat_runs, bat_balls, bat_average, bat_strike_rate, top_order_innings, middle_order_innings, finisher_innings, bowl_innings, bowl_overs, bowl_wickets, bowl_runs_conceded, bowl_average, bowl_economy) VALUES ('${pId}', '${format}', ${agg.matches}, ${agg.bat_innings}, ${agg.bat_runs}, ${agg.bat_balls}, ${batAvg}, ${batSr}, ${agg.top_order_innings}, ${agg.middle_order_innings}, ${agg.finisher_innings}, ${agg.bowl_innings}, ${bowlOvers}, ${agg.bowl_wickets}, ${agg.bowl_runs_conceded}, ${bowlAvg}, ${bowlEcon});`
      );
    }
  }

  for (const r of formatRoles) {
    sqlLines.push(`INSERT OR REPLACE INTO player_format_roles (player_id, format, primary_role, bowling_category) VALUES ('${r.id}', '${r.format}', '${r.role}', 'NONE');`);
  }

  // Pre-seed iconic challenges for all 3 formats
  const defaultChallenges = [
    // T20
    {
      id: "ch_t20_wankhede",
      format: "T20",
      venue_name: "Wankhede Stadium, Mumbai",
      venue_country: "IND",
      pitch_type: "HIGH_SCORING_FLAT",
      title: "Wankhede T20 Blast",
      narrative_intro: "True bounce and rapid outfields. Par score 210+. Power hitters and death yorker specialists are critical.",
      constraints: JSON.stringify([
        { type: "max_per_country", value: 2 },
        { type: "min_category", category: "AR", count: 2 },
      ]),
    },
    {
      id: "ch_t20_chepauk",
      format: "T20",
      venue_name: "MA Chidambaram Stadium, Chennai",
      venue_country: "IND",
      pitch_type: "DUSTBOWL",
      title: "Chepauk T20 Turning Trial",
      narrative_intro: "Cracked red clay turning square. Spinners will strangle the run rate; batters must play with soft hands.",
      constraints: JSON.stringify([
        { type: "max_per_country", value: 2, exceptions: { IND: 3 } },
        { type: "min_category", category: "SPIN", count: 2 },
      ]),
    },
    // ODI
    {
      id: "ch_odi_ahmedabad",
      format: "ODI",
      venue_name: "Narendra Modi Stadium, Ahmedabad",
      venue_country: "IND",
      pitch_type: "SLOW_LOW",
      title: "World Cup 50-Over Crucible",
      narrative_intro: "50 overs under scorching sun. Overs 11-40 strike rotation and reverse swing will decide the match.",
      constraints: JSON.stringify([
        { type: "max_per_country", value: 2, exceptions: { IND: 3 } },
        { type: "min_category", category: "PACE", count: 2 },
        { type: "min_category", category: "SPIN", count: 1 },
      ]),
    },
    {
      id: "ch_odi_wanderers",
      format: "ODI",
      venue_name: "Wanderers Stadium, Johannesburg",
      venue_country: "RSA",
      pitch_type: "HIGH_SCORING_FLAT",
      title: "Wanderers 438 Tribute Match",
      narrative_intro: "High altitude and rock-hard pitch. Ball flies over boundaries; Dale Steyn style express pace needed to stem flow.",
      constraints: JSON.stringify([
        { type: "max_per_country", value: 2, exceptions: { RSA: 3 } },
        { type: "min_category", category: "PACE", count: 3 },
      ]),
    },
    // TEST
    {
      id: "ch_test_lords",
      format: "TEST",
      venue_name: "Lord's Cricket Ground, London",
      venue_country: "ENG",
      pitch_type: "GREEN_SEAMER",
      title: "The Ashes at Lord's - Day 1 Seam Battle",
      narrative_intro: "Red Dukes ball, emerald green pitch with Lord's slope. Swing bowlers like Anderson rule the morning session.",
      constraints: JSON.stringify([
        { type: "max_per_country", value: 2, exceptions: { ENG: 3 } },
        { type: "min_category", category: "PACE", count: 3 },
        { type: "batting_hand_order", positions: [1, 2], hand: "LHB" },
      ]),
    },
    {
      id: "ch_test_gabba",
      format: "TEST",
      venue_name: "The Gabba, Brisbane",
      venue_country: "AUS",
      pitch_type: "GREEN_SEAMER",
      title: "Border-Gavaskar Trophy at The Gabba",
      narrative_intro: "Fast, bouncy deck with steep carry to the keeper. Taking 20 wickets with express pace is mandatory to triumph.",
      constraints: JSON.stringify([
        { type: "max_per_country", value: 2, exceptions: { AUS: 3 } },
        { type: "min_category", category: "PACE", count: 3 },
      ]),
    },
  ];

  for (const ch of defaultChallenges) {
    const cleanTitle = ch.title.replace(/'/g, "''");
    const cleanIntro = ch.narrative_intro.replace(/'/g, "''");
    const cleanVenue = ch.venue_name.replace(/'/g, "''");
    sqlLines.push(
      `INSERT OR REPLACE INTO challenges (id, format, venue_name, venue_country, pitch_type, title, narrative_intro, constraints_json) VALUES ('${ch.id}', '${ch.format}', '${cleanVenue}', '${ch.venue_country}', '${ch.pitch_type}', '${cleanTitle}', '${cleanIntro}', '${ch.constraints}');`
    );
  }

  const seedPath = path.resolve(process.cwd(), "data/seed.sql");
  fs.writeFileSync(seedPath, sqlLines.join("\n"), "utf-8");
  console.log(`[Process] Successfully generated ${seedPath} with ${allPlayersMeta.size} players and ${sqlLines.length} SQL statements!`);
}

main().catch((err) => {
  console.error("[Process] Execution error:", err);
  process.exit(1);
});
