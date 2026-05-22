# Data Quality Notes — Elo Mafia Rankings.xlsx

Findings from re-rating the current season (GameID 46–162, 117 games) on
2026-05-21. Source data lives in the live Google Sheet; the `.xlsx` is a
downloaded snapshot.

## Duplicated players within a single game

Five games list the same player name more than once.

| Game | Player | Appears as | Rows → distinct | Resolution |
| ---- | ------ | ---------- | --------------- | ---------- |
| 83 | Whyin | Town/Win **and** Mafia/Loss | 14 → 13 | Dan: actually **Mafia**; drop Town row |
| 116 | Ken | Town/Win **and** Mafia/Loss | 14 → 13 | Dan: actually **Mafia**; drop Town row |
| 136 | Smit | Town/Loss ×2 | 13 → **12** | Short roster — likely wrong substitution; a real player is missing |
| 151 | Kden | Town/Win ×2 | 14 → 13 | Accidental duplicate; dedup is clean |
| 155 | Ken | Town/Loss ×2 | 13 → **12** | Short roster — likely wrong substitution; a real player is missing |

`rerate_sheets.py` encodes the 83/116 resolution in `DUP_KEEP_ALIGNMENT`
(keep the Mafia row). For 136 and 155 the game is one player short after
dedup, so it is rated with 12 players; the missing participant cannot be
recovered from the sheet and would need manual correction.

## Name drift

MatchHistory contains 89 distinct player names; the original Stats Summary
lists 86. Three names appear in MatchHistory but not the summary, implying the
same person was logged under more than one spelling at different times:

- `DrMorris`
- `Ryan`
- `Vandyfan`

These likely map onto existing summary names (e.g. `Vandyfan` → `Vandy`) but
the mapping is not recorded. Aliases are applied at record time in
`backend/main.py` (`NAME_ALIASES`); names logged before an alias was added
keep their old spelling.

## Historical rating config

The current season's stored ratings were **not** computed under the documented
main config (ghosts 25.7 / 23.85, beta 5.5). Re-rating game 46 (a clean fresh
start) matches the stored values only at **beta ≈ 6.0** (error 6e-4 mu vs
0.02 at beta 5.5). Error then grows across the season, consistent with the live
config being retuned mid-season. A single static config cannot reproduce the
cumulative history.

This rules out floating-point / library-version drift as the cause: a numpy or
trueskill version difference would differ at ~1e-12 per game, not 1e-2 on the
first game.

## openpyxl strips formula caches

The Stats Summary sheets are formula-driven (COUNTIFS, Google-Sheets
`DUMMYFUNCTION`, and ArrayFormulas for Mu/Sigma/Rating). Saving the workbook
with openpyxl preserves the formula text but **drops the cached values**, so
pandas/Excel read blanks until the file is reopened in Google Sheets (which
recomputes). Raw data sheets (MatchHistory, MatchRatings) are literal values
and are unaffected.
