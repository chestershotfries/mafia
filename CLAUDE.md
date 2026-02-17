# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mafia game tracker with TrueSkill ratings. Three-tier hybrid architecture:

- **Frontend** (`app.js`, `index.html`, `style.css`): Vanilla JS single-page app hosted on GitHub Pages.
  Handles role randomization, night/day phase tracking, Discord output generation, and game recording UI.
- **Backend** (`Code.gs`): Google Apps Script web app. Handles TrueSkill rating calculations, Google Sheets
  read/write, and concurrency via `LockService`.
- **Offline analysis** (`Mafia_Rating_Experimental.py`): Python TrueSkill parameter tuning against historical data.

## Development

### Frontend

No build step. Edit JS/HTML/CSS directly and test in browser. Deploys automatically to GitHub Pages on push to `main`.

### Backend (Code.gs)

Deployed manually through the Google Apps Script editor. Changes here do **not** go through git push.

### Python script

Standalone script. Dependencies: `trueskill`, `pandas`, `numpy` (no requirements.txt).

## Architecture Details

### Frontend data model (app.js)

- `currentAssignments[]` — player objects with `position`, `name`, `role` (Mafia/Town), `is_ghost`
- `nightActions[]` — per-night actions: mafia kills, cop check/result, medic save, vigi target
- `dayVotes{}` — day-phase vote-outs keyed by day number
- `currentFormals[]` — RNG formal counts per day

### Panel flow

Four sequential panels: **randomize** → **game** (night/day actions) → **record** (finalize result) → **results**
(rating changes).

### Backend API (Code.gs)

All calls go through `api(action, data)` in app.js which POSTs to the Apps Script web app.

Key endpoints: `getPlayers`, `getLastGame`, `recordGame`, `undoLastGame`.

### TrueSkill

Custom JS implementation in Code.gs (not an external library). Constants: mu=25, sigma=25/3, beta=40.7, tau=0.
The Python script mirrors this for offline tuning with different ghost parameters.

### Game rules encoded in frontend

- N0: Mafia kill 1 hidden if ≤13 players; no vigi/medic if ≤13 players
- Kill 2 only if 3+ mafia alive
- Cop: no repeat checks, no self-check
- Medic: no consecutive saves on same target
- Vigi: one-shot only
- Auto win detection: mafia=0 (town wins) or mafia≥town (mafia wins)

## Commit Convention

Gitmoji + conventional commits per `~/.config/git/template`:

```text
✨ feat:     New features
🐛 fix:      Bug fixes
♻️  refactor: Refactor code
💄 ui:       UI/style changes
🔧 config:   Configuration
```
