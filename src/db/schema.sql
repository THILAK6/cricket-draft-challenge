-- Player registry
CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,                       -- e.g. 'cricsheet_6bf1fae2'
    cricinfo_id TEXT,                          -- ESPN Cricinfo ID for linking & enrichment
    name TEXT NOT NULL,
    short_name TEXT,
    country TEXT NOT NULL,                     -- ISO alpha-3: 'IND', 'AUS', 'ENG', 'BAN', etc.
    batting_hand TEXT NOT NULL,                -- 'LHB' | 'RHB'
    bowling_category TEXT NOT NULL,            -- 'NONE' | 'PACE' | 'SPIN'
    bowling_style TEXT,                        -- e.g. 'Right-arm fast-medium', 'Slow left-arm orthodox'
    primary_role TEXT NOT NULL,                -- 'BAT' | 'WK' | 'AR' | 'BOWL'
    active_span_start INTEGER,
    active_span_end INTEGER
);

-- Format-specific pre-aggregated stats (T20, ODI, TEST)
CREATE TABLE IF NOT EXISTS player_format_stats (
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    format TEXT NOT NULL,                      -- 'T20' | 'ODI' | 'TEST'
    matches INTEGER NOT NULL DEFAULT 0,
    bat_innings INTEGER DEFAULT 0,
    bat_runs INTEGER DEFAULT 0,
    bat_balls INTEGER DEFAULT 0,
    bat_average REAL DEFAULT 0.0,
    bat_strike_rate REAL DEFAULT 0.0,
    top_order_innings INTEGER DEFAULT 0,       -- Batted at 1 or 2
    middle_order_innings INTEGER DEFAULT 0,    -- Batted at 3 to 6
    finisher_innings INTEGER DEFAULT 0,        -- Batted at 7+
    bowl_innings INTEGER DEFAULT 0,
    bowl_overs REAL DEFAULT 0.0,
    bowl_wickets INTEGER DEFAULT 0,
    bowl_runs_conceded INTEGER DEFAULT 0,
    bowl_average REAL DEFAULT 0.0,
    bowl_economy REAL DEFAULT 0.0,
    PRIMARY KEY (player_id, format)
);

-- Pre-generated or cached AI challenges
CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    format TEXT NOT NULL,
    venue_name TEXT NOT NULL,
    venue_country TEXT NOT NULL,
    pitch_type TEXT NOT NULL,                  -- 'GREEN_SEAMER' | 'DUSTBOWL' | 'HIGH_SCORING_FLAT' | 'SLOW_LOW'
    title TEXT NOT NULL,
    narrative_intro TEXT NOT NULL,
    constraints_json TEXT NOT NULL,            -- JSON array of structured constraints
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Completed match/draft results
CREATE TABLE IF NOT EXISTS draft_history (
    id TEXT PRIMARY KEY,
    challenge_id TEXT REFERENCES challenges(id),
    user_xi_json TEXT NOT NULL,
    ai_xi_json TEXT NOT NULL,
    user_deterministic_score REAL NOT NULL,
    user_llm_adjustment REAL NOT NULL,
    user_final_score REAL NOT NULL,
    ai_deterministic_score REAL NOT NULL,
    ai_llm_adjustment REAL NOT NULL,
    ai_final_score REAL NOT NULL,
    winner TEXT NOT NULL,                      -- 'USER' | 'AI' | 'TIE'
    llm_verdict TEXT NOT NULL,
    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indices for rapid constraint filtering and search
CREATE INDEX IF NOT EXISTS idx_players_country ON players(country);
CREATE INDEX IF NOT EXISTS idx_players_role ON players(primary_role);
CREATE INDEX IF NOT EXISTS idx_players_batting_hand ON players(batting_hand);
CREATE INDEX IF NOT EXISTS idx_players_bowling_category ON players(bowling_category);
CREATE INDEX IF NOT EXISTS idx_stats_format_matches ON player_format_stats(format, matches);

