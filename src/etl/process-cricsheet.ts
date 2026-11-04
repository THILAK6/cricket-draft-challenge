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
};

async function main() {
  const dataDir = path.resolve(process.cwd(), "data");
  const peoplePath = path.join(dataDir, "raw/people.csv");
  const t20sDir = path.join(dataDir, "raw/t20s_json");

  if (!fs.existsSync(peoplePath) || !fs.existsSync(t20sDir)) {
    console.error("[Process] Missing raw data. Run `npm run etl:download` first.");
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

  // 2. Iterate through T20 match files and aggregate stats
  const matchFiles = fs.readdirSync(t20sDir).filter((f) => f.endsWith(".json"));
  console.log(`[Process] Processing ${matchFiles.length} T20 match files...`);

  const aggregates = new Map<string, PlayerAggregate>();

  function getOrCreate(cricsheetId: string, name: string, country: string): PlayerAggregate {
    let agg = aggregates.get(cricsheetId);
    if (!agg) {
      agg = {
        cricsheet_id: cricsheetId,
        name: canonicalNameMap.get(cricsheetId) || name,
        country: COUNTRY_MAP[country] || country.slice(0, 3).toUpperCase(),
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
      const matchRaw = fs.readFileSync(path.join(t20sDir, file), "utf-8");
      const match = JSON.parse(matchRaw);

      if (!match.info?.players || !match.info?.registry?.people) continue;

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

            // Track batting order
            if (!battingOrder.includes(batterName)) battingOrder.push(batterName);
            if (!battingOrder.includes(nonStriker)) battingOrder.push(nonStriker);

            // Batting stats
            const batterCId = peopleRegistry[batterName];
            if (batterCId && aggregates.has(batterCId)) {
              const bAgg = aggregates.get(batterCId)!;
              bAgg.bat_runs += del.runs?.batter || 0;
              // Extras: wide balls do not count as ball faced by batter
              if (!del.extras?.wides) {
                bAgg.bat_balls += 1;
              }
            }

            // Bowling stats
            const bowlerCId = peopleRegistry[bowlerName];
            if (bowlerCId && aggregates.has(bowlerCId)) {
              const bwAgg = aggregates.get(bowlerCId)!;
              bowlersInInnings.add(bowlerCId);

              const extras = del.extras || {};
              const runs = del.runs || {};
              // Legal ball: not wide or noball
              if (!extras.wides && !extras.noballs) {
                bwAgg.bowl_legal_balls += 1;
              }
              // Bowler runs conceded excludes legbyes and byes
              const conceded = (runs.batter || 0) + (extras.wides || 0) + (extras.noballs || 0) + (extras.penalties || 0);
              bwAgg.bowl_runs_conceded += conceded;

              // Bowler wickets exclude run outs, retired out, etc.
              const wickets = del.wickets || [];
              for (const w of wickets) {
                const kind = w.kind || "";
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

        // Record batting innings & position slots
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

        // Record bowling innings count
        for (const bCId of bowlersInInnings) {
          if (aggregates.has(bCId)) {
            aggregates.get(bCId)!.bowl_innings += 1;
          }
        }
      }

      processedCount++;
    } catch (e) {
      // Continue on corrupted file
    }
  }

  console.log(`[Process] Aggregated stats across ${processedCount} matches for ${aggregates.size} players.`);

  // 3. Filter to notable/active international players (e.g. >= 10 matches or high performers)
  const eligiblePlayers = Array.from(aggregates.values()).filter(
    (p) => p.matches >= 8 && ["IND", "AUS", "ENG", "PAK", "RSA", "NZL", "WI", "SL", "BAN", "AFG"].includes(p.country)
  );

  console.log(`[Process] Selected ${eligiblePlayers.length} high-tier international players for draft pool.`);

  // 4. Enrich player profiles via AthleteEnricher (ESPN Cricinfo metadata)
  const enricher = new AthleteEnricher();
  console.log("[Process] Enriching player attributes (batting hand, bowling style, role)...");

  // Process in small batches
  const enrichedList = [];
  for (let i = 0; i < eligiblePlayers.length; i++) {
    const agg = eligiblePlayers[i];
    const cricinfoId = cricinfoIdMap.get(agg.cricsheet_id);

    let meta;
    if (cricinfoId) {
      meta = await enricher.getPlayerMeta(cricinfoId, agg.name);
    } else {
      // Derive fallback
      meta = {
        cricinfo_id: "",
        name: agg.name,
        batting_hand: "RHB" as const,
        bowling_category: agg.bowl_legal_balls > 120 ? ("PACE" as const) : ("NONE" as const),
        bowling_style: "Right-arm medium",
        primary_role: agg.stumpings > 0 ? ("WK" as const) : agg.bowl_legal_balls > 240 ? ("BOWL" as const) : ("BAT" as const),
      };
    }

    // Adjust primary role if Cricsheet shows active keeper or heavy bowler
    if (agg.stumpings > 0) {
      meta.primary_role = "WK";
    }

    enrichedList.push({ agg, meta });

    if ((i + 1) % 50 === 0 || i + 1 === eligiblePlayers.length) {
      console.log(`[Process] Enriched ${i + 1} / ${eligiblePlayers.length} players...`);
      enricher.saveCache();
    }
  }

  // 5. Generate data/seed.sql
  console.log("[Process] Generating data/seed.sql...");
  const sqlLines: string[] = [
    "-- Auto-generated seed data from Cricsheet + ESPN Cricinfo enrichment",
    "BEGIN TRANSACTION;",
  ];

  for (const { agg, meta } of enrichedList) {
    const pId = `crick_${agg.cricsheet_id}`;
    const cleanName = meta.name.replace(/'/g, "''");
    const cleanStyle = (meta.bowling_style || "").replace(/'/g, "''");

    // Compute derived rates
    const batAvg = agg.bat_innings > 0 ? (agg.bat_runs / Math.max(1, agg.bat_dismissals || 1)).toFixed(2) : "0.0";
    const batSr = agg.bat_balls > 0 ? ((agg.bat_runs / agg.bat_balls) * 100).toFixed(2) : "0.0";
    const bowlOvers = (agg.bowl_legal_balls / 6).toFixed(1);
    const bowlAvg = agg.bowl_wickets > 0 ? (agg.bowl_runs_conceded / agg.bowl_wickets).toFixed(2) : "0.0";
    const bowlEcon = agg.bowl_legal_balls > 0 ? ((agg.bowl_runs_conceded / agg.bowl_legal_balls) * 6).toFixed(2) : "0.0";

    sqlLines.push(
      `INSERT OR REPLACE INTO players (id, cricinfo_id, name, country, batting_hand, bowling_category, bowling_style, primary_role) VALUES ('${pId}', '${meta.cricinfo_id}', '${cleanName}', '${agg.country}', '${meta.batting_hand}', '${meta.bowling_category}', '${cleanStyle}', '${meta.primary_role}');`
    );

    sqlLines.push(
      `INSERT OR REPLACE INTO player_format_stats (player_id, format, matches, bat_innings, bat_runs, bat_balls, bat_average, bat_strike_rate, top_order_innings, middle_order_innings, finisher_innings, bowl_innings, bowl_overs, bowl_wickets, bowl_runs_conceded, bowl_average, bowl_economy) VALUES ('${pId}', 'T20', ${agg.matches}, ${agg.bat_innings}, ${agg.bat_runs}, ${agg.bat_balls}, ${batAvg}, ${batSr}, ${agg.top_order_innings}, ${agg.middle_order_innings}, ${agg.finisher_innings}, ${agg.bowl_innings}, ${bowlOvers}, ${agg.bowl_wickets}, ${agg.bowl_runs_conceded}, ${bowlAvg}, ${bowlEcon});`
    );
  }

  sqlLines.push("COMMIT;");

  const seedPath = path.resolve(process.cwd(), "data/seed.sql");
  fs.writeFileSync(seedPath, sqlLines.join("\n"), "utf-8");
  console.log(`[Process] Successfully generated ${seedPath} with ${enrichedList.length} players!`);
}

main().catch((err) => {
  console.error("[Process] Execution error:", err);
  process.exit(1);
});

