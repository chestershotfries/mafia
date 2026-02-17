# CLAUDE.md

Mafia game tracker with TrueSkill ratings.

## Stack

- **Frontend**: `app.js`, `index.html`, `style.css` — vanilla JS SPA, GitHub Pages
- **Backend**: `backend/main.py` — Python Cloud Function (gen2), GCP, `trueskill` + `gspread`
- **Offline**: `Mafia_Rating_Experimental.py` — TrueSkill parameter tuning (`trueskill`, `pandas`, `numpy`)

## Development

- Frontend: no build step, edit and test in browser, deploys on push to `main`
- Backend: deps in `backend/requirements.txt`, auth via `SERVICE_ACCOUNT_KEY` env var or `service-account.json`

## Architecture

**Panel flow**: randomize → game (night/day actions) → record (finalize) → results (ratings)

**Frontend state** (`app.js`):
`currentAssignments[]` (position, name, role, is_ghost),
`nightActions[]` (mafKills, copCheck/copResult, medicSave, vigiTarget),
`dayVotes{}` (day number → voted-out name),
`currentFormals[]` (RNG counts per day)

**API**: `api(action, data)` POSTs JSON to Cloud Function.
Actions: `getPlayers`, `getLastGame`, `recordGame`, `undoLastGame`

**Sheets**: `MatchRatings` (mu/sigma per player), `MatchHistory` (game log, newest at row 2), `Stats Summary` (auto-sorted)

**Positions**: 1-3 Mafia, 4 Cop, 5 Medic, 6 Vigilante, 7-15 Town. 13-15 players, ghosts fill to 15.

## TrueSkill

Backend uses `trueskill` library with ghost-padded teams.
mu=25, sigma=25/3, tau=0.1, beta=5.5.
Mafia ghost: mu=25.7 sigma=0.8. Town ghost: mu=23.85 sigma=0.8.
Mafia team padded with geometric-mean fillers to match town size.
Display rating: `round((mu - 1.5 * sigma) * 68)`.

## Game Rules

- N0: kill 1 hidden if ≤13 players; no vigi; no medic if ≤13
- Kill 2: requires 3+ mafia alive; hidden on N0 if <15 players
- Cop: no repeat checks, no self-check
- Medic: no consecutive saves on same target, no self save
- Vigi: one-shot, disabled on N0
- Win: mafia=0 → town wins; mafia≥town → mafia wins
