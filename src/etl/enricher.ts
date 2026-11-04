import fs from "node:fs";
import path from "node:path";
import type { BattingHand, BowlingCategory, PlayerRole } from "../core/types";

export interface EnrichedAthleteMeta {
  cricinfo_id: string;
  name: string;
  batting_hand: BattingHand;
  bowling_category: BowlingCategory;
  bowling_style: string;
  primary_role: PlayerRole;
}

const CACHE_FILE = path.resolve(process.cwd(), "data/cache/athletes.json");

export class AthleteEnricher {
  private cache: Map<string, EnrichedAthleteMeta> = new Map();

  constructor() {
    this.loadCache();
  }

  private loadCache() {
    if (fs.existsSync(CACHE_FILE)) {
      try {
        const raw = fs.readFileSync(CACHE_FILE, "utf-8");
        const list: EnrichedAthleteMeta[] = JSON.parse(raw);
        for (const item of list) {
          this.cache.set(item.cricinfo_id, item);
        }
        console.log(`[Enricher] Loaded ${this.cache.size} cached player profiles.`);
      } catch (e) {
        console.warn("[Enricher] Failed to parse cache file, starting fresh.");
      }
    }
  }

  saveCache() {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const list = Array.from(this.cache.values());
    fs.writeFileSync(CACHE_FILE, JSON.stringify(list, null, 2), "utf-8");
    console.log(`[Enricher] Persisted ${list.length} player profiles to cache.`);
  }

  async getPlayerMeta(cricinfo_id: string, fallbackName: string): Promise<EnrichedAthleteMeta> {
    const existing = this.cache.get(cricinfo_id);
    // Return existing if valid, non-fallback entry
    if (existing && !(existing.bowling_category === "NONE" && existing.bowling_style === "Right-arm medium" && existing.name === fallbackName)) {
      return existing;
    }

    try {
      // Gentle pacing to avoid rate-limiting
      await new Promise((r) => setTimeout(r, 40));

      const url = `https://site.web.api.espn.com/apis/common/v3/sports/cricket/athletes/${cricinfo_id}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "CricketDraftChallenge/1.0" },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data: any = await res.json();
      const athlete = data.athlete;

      // 1. Batting Hand
      const batDesc = athlete.batStyle?.[0]?.description?.toLowerCase() || "";
      const batShort = athlete.batStyle?.[0]?.shortDescription?.toLowerCase() || "";
      const batting_hand: BattingHand = batDesc.includes("left") || batShort === "lhb" ? "LHB" : "RHB";

      // 2. Bowling Category & Style
      const bowlDesc = athlete.bowlStyle?.[0]?.description || "";
      const bowlLower = bowlDesc.toLowerCase();
      let bowling_category: BowlingCategory = "NONE";

      if (
        bowlLower.includes("spin") ||
        bowlLower.includes("break") ||
        bowlLower.includes("orthodox") ||
        bowlLower.includes("googly")
      ) {
        bowling_category = "SPIN";
      } else if (
        bowlLower.includes("fast") ||
        bowlLower.includes("medium") ||
        bowlLower.includes("pace") ||
        bowlLower.includes("seam")
      ) {
        bowling_category = "PACE";
      }

      // 3. Primary Role
      const posSlug = athlete.position?.slug?.toLowerCase() || "";
      const posName = athlete.position?.name?.toLowerCase() || "";
      const posId = athlete.position?.id || "";

      let primary_role: PlayerRole = "BAT";
      if (posSlug.includes("wicketkeeper") || posName.includes("wicketkeeper") || posId === "WBT" || posId === "WK") {
        primary_role = "WK";
      } else if (posSlug.includes("allrounder") || posId === "AR" || posId === "BTA" || posId === "BLA") {
        primary_role = "AR";
      } else if (posSlug.includes("bowler") || posId === "BL") {
        primary_role = "BOWL";
      } else {
        primary_role = "BAT";
      }

      const meta: EnrichedAthleteMeta = {
        cricinfo_id,
        name: athlete.displayName || fallbackName,
        batting_hand,
        bowling_category,
        bowling_style: bowlDesc,
        primary_role,
      };

      this.cache.set(cricinfo_id, meta);
      return meta;
    } catch (err) {
      // Fallback if API is unreachable or cricinfo_id invalid
      const fallback: EnrichedAthleteMeta = {
        cricinfo_id,
        name: fallbackName,
        batting_hand: "RHB",
        bowling_category: "NONE",
        bowling_style: "Right-arm medium",
        primary_role: "BAT",
      };
      this.cache.set(cricinfo_id, fallback);
      return fallback;
    }
  }
}

