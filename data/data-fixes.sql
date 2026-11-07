-- Corrections to data/seed.sql. Safe to run more than once. Applied by `npm run db:seed:local`;
-- for the production database run:
--   npx wrangler d1 execute cricdraft-db --remote --file=src/db/schema.sql
--   npx wrangler d1 execute cricdraft-db --remote --file=data/data-fixes.sql
-- The ETL (src/etl/process-cricsheet.ts) now gets these right on its own, so a fresh seed
-- needs only the per-format roles below that the ETL can't infer from stumpings.

CREATE TABLE IF NOT EXISTS player_format_roles (
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    format TEXT NOT NULL,
    primary_role TEXT NOT NULL,
    bowling_category TEXT NOT NULL,
    PRIMARY KEY (player_id, format)
);

-- ---------------------------------------------------------------------------------------------
-- Countries. The ETL turned unknown team names into their first three letters, so Indonesia
-- became IND and Austria became AUS. Every T20-only player under IND or AUS who is not a known
-- India or Australia international is moved to their real country.
-- ---------------------------------------------------------------------------------------------

-- Indonesia
UPDATE players SET country = 'INA' WHERE id IN (
  'crick_a62f55ba', -- Danilson Johanis Hawoe
  'crick_3c8faed4', -- Ferdinando Banunaek
  'crick_190957d2', -- I Ketut Edi Guna Artawan
  'crick_2af0e3b1', -- Gede Agus Priandana
  'crick_4b349dc0', -- Dharma Kadek Kesuma
  'crick_72275237', -- Muhammad Anjar Tadarus
  'crick_4d7c5b56', -- I Kadek Gamantika
  'crick_e969e580', -- Gede Darma Arta
  'crick_b5f30525', -- Ahmad Ramdoni
  'crick_f0a45427', -- Rojerio Maxi Koda
  'crick_2327fdc7', -- Apriliandi Abdillah Rahayu
  'crick_206efeb1', -- Padmakar Rajaram Surve
  'crick_a89c270b', -- Kirubasankar Coimbatore Ramamoorthy
  'crick_65cfc56b', -- Dhanesh Kumar Shetty
  'crick_cab3f89a', -- Gaurav Tiwari
  'crick_d3d096f5', -- Dewa Gede Andika Pradipta Diatmika Wiswi
  'crick_a88e4013', -- Kavin Neeraj Chaddha
  'crick_41a61623', -- Sampath Kharvi
  'crick_ef6d6883', -- Andreas Alexander Hawoe
  'crick_866e9f3d', -- Sudhakar Jegannathan
  'crick_05ea0342', -- Julang Dzulfikar
  'crick_ad85a036', -- Vineet Shah
  'crick_95f0262b'  -- I Gede Teguh Pranatha Wiguna
);

-- Austria
UPDATE players SET country = 'AUT' WHERE id IN (
  'crick_14157abf', -- Aqib Javed Iqbal
  'crick_33b67317', -- Mahammad Bilal Zalmai
  'crick_6a97c7a4', -- Karanbir Singh
  'crick_67ec2b09', -- Umair Tariq
  'crick_75ebfe19', -- Baseer Khan
  'crick_74571ec4', -- Mohamad Waqar Zalmai
  'crick_1798078c', -- Armaan Randhawa
  'crick_dae28050', -- Sahel Zadran
  'crick_60cc80ac', -- Razmal Shigiwal
  'crick_6829b373', -- Zeshan Arif
  'crick_f9dc404a', -- Amar Naeem
  'crick_ec4ae12d', -- Hamid Safi
  'crick_6c53ffb2', -- Irfan Safi
  'crick_fecd828e', -- Mark Simpson-Parker
  'crick_97181d1b', -- Mehar Partap Singh Cheema
  'crick_5de198db', -- Abdullah Akbarjan
  'crick_9bdb9aa9', -- KR Jha
  'crick_663ad386', -- Imran Asif
  'crick_6b74c13b', -- Mirza Ahsan
  'crick_507fc658', -- Saad Falak Sher Cheema
  'crick_b85c0597', -- Hekmatullah Khogiyani
  'crick_f1c4f2ea', -- Amit Nathwani
  'crick_46821fbd', -- Shahil Momin
  'crick_e1824e7d', -- Iqbal Hossain
  'crick_c1f05d1d', -- Jaweed Sadran
  'crick_b17d629e', -- Shadnan Khan
  'crick_86d7a2d2', -- Mansoor Safi
  'crick_cc65e4a4', -- Arsalan Arif
  'crick_72ae14d0', -- Zeeshan Goraya
  'crick_f1e7f97c', -- Ziaurahman Shinwari
  'crick_dcfad6eb', -- Nageebullah Sultanzai
  'crick_85dcc96d', -- Navin Wijesekera
  'crick_6ddaee2d', -- Abrar Bilal
  'crick_0467bd8d'  -- Ranjit Singh
);

-- ---------------------------------------------------------------------------------------------
-- Roles. The ETL made anyone with a single career stumping a keeper in every format.
-- ---------------------------------------------------------------------------------------------

-- Not keepers: frontline bowlers or batters who once stood in
UPDATE players SET primary_role = 'AR', bowling_category = 'SPIN' WHERE id = 'crick_bf1d7d3e'; -- Mahmudullah (off-spin)
UPDATE players SET primary_role = 'AR', bowling_category = 'SPIN' WHERE id = 'crick_9a46c4e5'; -- Glenn Phillips (off-spin)
UPDATE players SET primary_role = 'BAT', bowling_category = 'NONE' WHERE id IN (
  'crick_5bdcdb72', -- Tillakaratne Dilshan (all-rounder in ODIs, below)
  'crick_d67d5f00', -- David Miller
  'crick_fd2bf2a0', -- Umar Akmal
  'crick_1c17e270', -- Robin Uthappa
  'crick_e94bc520'  -- Ollie Pope
);

-- One format differs from the rest
INSERT OR REPLACE INTO player_format_roles (player_id, format, primary_role, bowling_category) VALUES
  ('crick_5bdcdb72', 'ODI', 'AR', 'SPIN'),   -- Dilshan: 980 ODI overs of off-spin
  ('crick_9a46c4e5', 'T20', 'BAT', 'NONE'),  -- Glenn Phillips bats in T20Is
  ('crick_0184dc35', 'TEST', 'BAT', 'NONE'), -- Rahul Dravid kept in ODIs, batted in Tests
  ('crick_b17e2f24', 'TEST', 'BAT', 'NONE'), -- KL Rahul opens in Tests
  ('crick_e824e6ee', 'TEST', 'BAT', 'NONE'), -- Tom Latham opens in Tests
  ('crick_5d1e7582', 'TEST', 'BAT', 'NONE'), -- Kusal Mendis
  ('crick_1fc6ef83', 'TEST', 'BAT', 'NONE'), -- Shai Hope
  ('crick_df5a6881', 'ODI', 'BAT', 'NONE'),  -- Devon Conway
  ('crick_df5a6881', 'TEST', 'BAT', 'NONE'),
  ('crick_abb83e27', 'ODI', 'BAT', 'NONE'),  -- Jonny Bairstow opened in white-ball cricket
  ('crick_abb83e27', 'T20', 'BAT', 'NONE');
