-- Corrections to data/seed.sql. Safe to run more than once. Applied by `npm run db:seed:local`;
-- for the production database run:
--   npx wrangler d1 execute cricdraft-db --remote --file=src/db/schema.sql
--   npx wrangler d1 execute cricdraft-db --remote --file=data/data-fixes.sql
-- The ETL (src/etl/process-cricsheet.ts) now gets these right on its own, so a fresh seed
-- needs only the per-format roles below that the ETL can't infer from stumpings, and the spinners at
-- the end (Cricsheet has no bowling styles; when the Cricinfo lookup fails the ETL falls back to
-- "Right-arm medium").

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

-- Spinners the source data filed under its default style, "Right-arm medium" (Warne, Kumble, Lyon,
-- MacGill...). They were treated as seamers by the match engine, the pitch fit and the AI.
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_d094e7d1'; -- Abdur Rehman (PAK)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_864c199e'; -- Adam Voges (AUS)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_fbd4f01f'; -- Ajaz Patel (NZL)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak' WHERE id = 'crick_54279e23'; -- Alok Kapali (BAN)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_e957b38f'; -- Andy McBrine (IRE)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak googly' WHERE id = 'crick_0c2730df'; -- Anil Kumble (IND)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_34ff9e07'; -- Aravinda de Silva (SL)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_a4af4849'; -- Ashley Giles (ENG)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak' WHERE id = 'crick_1a448be0'; -- Ben White (IRE)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak' WHERE id = 'crick_dadb9703'; -- Brandon Mavuta (ZIM)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_4b685e2d'; -- Dan Lawrence (ENG)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_537f5ab2'; -- Dane Piedt (RSA)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak googly' WHERE id = 'crick_0be1b885'; -- Danish Kaneria (PAK)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_53fe6ee4'; -- Darren Lehmann (AUS)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_33085ffb'; -- Dean Elgar (RSA)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak googly' WHERE id = 'crick_7a80ddf2'; -- Devendra Bishoo (WI)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_5531248e'; -- Dilruwan Perera (SL)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_656202a7'; -- Dougie Marillier (ZIM)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_0480aba6'; -- Enamul Haque (BAN)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak' WHERE id = 'crick_33b3d2df'; -- Gareth Delany (IRE)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_348195ea'; -- Grant Flower (ZIM)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_94253925'; -- Hanuma Vihari (IND)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_818e8bf2'; -- Ian Blackwell (ENG)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_cc23e91e'; -- Jomel Warrican (WI)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak' WHERE id = 'crick_3b50c63a'; -- Kaushal Lokuarachchi (SL)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_49dc9cb4'; -- Kavem Hodge (WI)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_df08c69e'; -- Keith Dabengwa (ZIM)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_7d5af2ea'; -- Kraigg Brathwaite (WI)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_b54b66b3'; -- Lasith Embuldeniya (SL)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak googly' WHERE id = 'crick_4fc516bd'; -- Malinga Bandara (SL)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_e8d7b493'; -- Manjural Islam Rana (BAN)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_99464591'; -- Marcus North (AUS)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_c8574282'; -- Mark Craig (NZL)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak' WHERE id = 'crick_fa433be6'; -- Marnus Labuschagne (AUS)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_2c54c49b'; -- Matthew Humphreys (IRE)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_7ff3fcaa'; -- Mohammad Rafique (BAN)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_de0a3209'; -- Mominul Haque (BAN)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_5a37ec26'; -- Monty Panesar (ENG)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_abfeb126'; -- Murali Kartik (IND)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_8ea6e670'; -- Nathan Hauritz (AUS)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_96a6a7ad'; -- Nathan Lyon (AUS)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_1670dcfd'; -- Nayeem Hasan (BAN)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_6a0537aa'; -- Nicky Boje (RSA)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak' WHERE id = 'crick_59ddd811'; -- Nkrumah Bonner (WI)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_54c58a5e'; -- Noman Ali (PAK)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_fd093ca9'; -- Paul Harris (RSA)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak googly' WHERE id = 'crick_98ae73b1'; -- Piyush Chawla (IND)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_127bc5ca'; -- Prabath Jayasuriya (SL)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_6c6591ab'; -- Pragyan Ojha (IND)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_9de271ef'; -- Prosper Utseya (ZIM)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_1be67d37'; -- Ramesh Mendis (SL)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_5d096f3d'; -- Ramesh Powar (IND)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_67af6f81'; -- Ray Price (ZIM)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak' WHERE id = 'crick_b08252b8'; -- Ryan Burl (ZIM)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak' WHERE id = 'crick_d2c2b2d5'; -- Sachin Tendulkar (IND)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_bbc192a4'; -- Sajid Khan (PAK)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_afe57f7a'; -- Sean Williams (ZIM)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak googly' WHERE id = 'crick_0dc00542'; -- Shahid Afridi (PAK)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_d76b0d2d'; -- Shane Shillingford (WI)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak googly' WHERE id = 'crick_bb18be76'; -- Shane Warne (AUS)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_e36e9dd3'; -- Shoaib Bashir (ENG)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_c9945bdf'; -- Simi Singh (IRE)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_23638956'; -- Simon Harmer (RSA)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak googly' WHERE id = 'crick_60dac349'; -- Stuart MacGill (AUS)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Right-arm offbreak' WHERE id = 'crick_f5f18a18'; -- Suraj Randiv (SL)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_4b2d6789'; -- Tendai Chisoro (ZIM)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak googly' WHERE id = 'crick_434e36b1'; -- Upul Chandana (SL)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_4bc0a378'; -- Wellington Masakadza (ZIM)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Legbreak googly' WHERE id = 'crick_f2800ef3'; -- Yasir Shah (PAK)
UPDATE players SET bowling_category = 'SPIN', bowling_style = 'Slow left-arm orthodox' WHERE id = 'crick_3a0f6df2'; -- Zulfiqar Babar (PAK)
-- Per-format roles follow the corrected category
UPDATE player_format_roles SET bowling_category = 'SPIN'
  WHERE bowling_category = 'PACE' AND player_id IN (SELECT id FROM players WHERE bowling_category = 'SPIN');
