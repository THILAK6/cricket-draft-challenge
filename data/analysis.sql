-- Queries for analysing saved matches. Run against production with, for example:
--   npx wrangler d1 execute cricdraft-db --remote --command "<query>"
-- Each `-- name:` line starts a query; tests/analysis.test.ts runs every one so they stay valid.

-- name: record by draft mode, bidder style and format
SELECT COALESCE(json_extract(data, '$.draftMode'), 'snake') AS mode,
       json_extract(data, '$.auction.style') AS bidder,
       format,
       SUM(winner = 'USER') AS you_won, SUM(winner = 'AI') AS ai_won, SUM(winner NOT IN ('USER', 'AI')) AS other, COUNT(*) AS matches
FROM matches GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- name: average price paid by role in auctions, you v the AI
SELECT json_extract(p.value, '$.by') AS side, json_extract(p.value, '$.role') AS role,
       COUNT(*) AS bought, ROUND(AVG(json_extract(p.value, '$.price')), 2) AS avg_crore
FROM matches m, json_each(m.data, '$.pickLog') p
WHERE json_extract(m.data, '$.draftMode') = 'auction'
GROUP BY 1, 2 ORDER BY 1, 2;

-- name: how much of the purse was left at the end, by bidder style
SELECT json_extract(data, '$.auction.style') AS bidder,
       ROUND(AVG(json_extract(data, '$.auction.purseLeft.USER')), 1) AS you_left,
       ROUND(AVG(json_extract(data, '$.auction.purseLeft.AI')), 1) AS ai_left, COUNT(*) AS auctions
FROM matches WHERE json_extract(data, '$.draftMode') = 'auction' GROUP BY 1;

-- name: players who went unsold, most often first
SELECT json_extract(l.value, '$.name') AS player, COUNT(*) AS times_unsold
FROM matches m, json_each(m.data, '$.auction.log') l
WHERE json_extract(l.value, '$.price') IS NULL
GROUP BY 1 ORDER BY 2 DESC LIMIT 25;

-- name: how often each player is in your winning XIs
SELECT json_extract(x.value, '$.name') AS player, COUNT(*) AS in_your_xi,
       SUM(m.winner = 'USER') AS wins, ROUND(100.0 * SUM(m.winner = 'USER') / COUNT(*), 0) AS win_pct
FROM matches m, json_each(m.data, '$.userXI') x
GROUP BY 1 HAVING COUNT(*) >= 3 ORDER BY win_pct DESC, in_your_xi DESC LIMIT 25;

-- name: your drafts by the replay win chance they earned (the draft, not the dice)
SELECT COALESCE(json_extract(data, '$.draftMode'), 'snake') AS mode,
       ROUND(AVG(100.0 * json_extract(data, '$.results.review.winChance.wins') / json_extract(data, '$.results.review.winChance.played')), 1) AS avg_win_chance,
       ROUND(100.0 * AVG(winner = 'USER'), 1) AS actual_win_pct, COUNT(*) AS matches
FROM matches WHERE json_extract(data, '$.results.review.winChance.played') > 0 GROUP BY 1;
