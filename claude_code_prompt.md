# Claude Code Prompt: Mafia Game Randomizer & ELO Tracker Webpage

Build a local web application (HTML/CSS/JS frontend + Python Flask or FastAPI backend) that serves as a Mafia game randomizer and integrates with my existing ELO tracking Excel workbook.

## Core Workflow

### Step 1: Name Input & Randomization

- The webpage presents a text input area where I enter 13–15 player names (one per line or comma-separated).
- On submit, the app validates that exactly 13–15 names were entered.
- **Ghost logic:**
  - If 13 names are entered → add 2 ghosts (named "Ghost1", "Ghost2").
  - If 14 names are entered → add 1 ghost (named "Ghost1").
  - If 15 names are entered → no ghosts needed.
- The app randomizes all 15 entries into positions 1–15 with these **ghost constraints:**
  - Ghosts **cannot** be placed in positions 1–3 (these are Mafia roles).
  - At most **1 ghost** can be placed in positions 4–6.
  - The remaining ghost(s) must be in positions 7–15.
- Display the randomized list clearly as a numbered list (1–15), highlighting which are ghosts and which positions are Mafia (1–3) vs Town (4–15).

### Step 2: Record Game Results

- After a game is played, the UI should allow me to input:
  1. **Game result**: Did Mafia win or did Town win?
  2. **Night 0 kills**: Which player(s) were killed on Night 0 (select from the randomized list of real players). This could be 0, 1, or more players.
- The app then determines each player's alignment and result:
  - Positions 1–3 = **Mafia** alignment
  - Positions 4–15 = **Town** alignment
  - Result = "Win" or "Loss" based on the game outcome and their alignment
- **Exclusions from MatchHistory and TrueSkill calculations:**
  - **Ghosts** are never included — they are only placeholders for randomization.
  - **Night 0 kills** are excluded — players killed on Night 0 do not get a MatchHistory row and are not included in the TrueSkill rating update.
  - Only the remaining real, surviving players are recorded and rated.

### Step 3: ELO Calculation & Excel Integration

- The app reads from and writes to the Excel workbook at `Elo_Mafia_Rankings.xlsx`.
- **Relevant sheets and their structures:**

#### `MatchRatings` sheet (current mu/sigma per player)
| Column | Content |
|--------|---------|
| A | Player (name) |
| B | mu |
| C | sigma |

#### `Stats Summary` sheet (aggregate stats, read-only reference)
| Column | Content |
|--------|---------|
| A | Name |
| B | Town Games |
| C | Town Wins |
| D | Town Win % |
| E | Mafia Games |
| F | Mafia Wins |
| G | Mafia Win % |
| H | Total Games |
| I | Total Win % |
| J | Mu |
| K | Sigma |
| L | Rating |

#### `MatchHistory` sheet (append new game rows here)
| Column | Content |
|--------|---------|
| A | GameID (integer, increment from last used GameID) |
| B | Player name |
| C | Alignment ("Mafia" or "Town") |
| D | Result ("Win" or "Loss") |
| E | RateChange (new_rating - old_rating, as integer) |
| F | old_mu |
| G | new_mu |
| H | new_sigma |
| I | old_rating (as integer) |
| J | new_rating (as integer) |
| K | old_sigma |

- **Rating formula:** `Rating = round((mu - 1.5 * sigma) * 68)`
  - This has been verified against all existing data with zero error. For example: Laur with mu=37.804, sigma=7.187 → round((37.804 - 1.5×7.187) × 68) = 1838 ✓

- **For each included player (non-ghost, not killed Night 0):**
  1. Look up their current `mu` and `sigma` from the `MatchRatings` sheet (column A = name, B = mu, C = sigma).
  2. If the player is **not found** in `MatchRatings`, they are a new player. Initialize them with `mu = 25` and `sigma = 25/3` (≈8.3333). Add them to the `MatchRatings` sheet.
  3. Run the **TrueSkill rating update** for the game. Use the `trueskill` Python library. The game is a 2-team match:
     - Team 1 = Mafia players (positions 1–3), **excluding** any Night 0 kills.
     - Team 2 = Town players (positions 4–15), **excluding** ghosts and Night 0 kills.
     - Team sizes will vary game-to-game depending on how many ghosts and N0 kills there are.
     - The winning team's rank = 0, losing team's rank = 1 (TrueSkill convention).
     - **TrueSkill environment parameters** need to be calibrated to match the existing data in the workbook. Start with defaults (`mu=25, sigma=25/3`) and expose `beta`, `tau`, and `draw_probability` as configurable constants at the top of the backend code so they can be tuned. Set `draw_probability=0` (no draws in Mafia).
  4. After the TrueSkill update, compute old_rating and new_rating using the rating formula.
  5. Compute `RateChange = new_rating - old_rating`.
  6. Append one row per **included** player (non-ghost, non-Night-0-killed) to `MatchHistory` with all the columns filled in. Use the next GameID (max existing GameID + 1). All players in the same game share the same GameID.
  7. Update the player's mu and sigma in the `MatchRatings` sheet.

- **Do NOT modify** the `Stats Summary` sheet — it likely uses formulas that auto-calculate from MatchHistory/MatchRatings. Only write to `MatchHistory` and `MatchRatings`.

## Technical Requirements

- Use **Python** for the backend (Flask or FastAPI).
- Use **openpyxl** to read/write the Excel file (preserve all existing sheets, formatting, and formulas).
- Use the **trueskill** Python library for ELO/TrueSkill calculations.
- Frontend should be clean and simple — single-page app is fine.
- The randomization with ghost constraints should use a retry or smart-shuffle approach to guarantee valid placement.
- Add a "history" or "last game" display so I can verify what was recorded.
- Include error handling for: duplicate names, empty inputs, file not found, etc.

## File Location

The Excel workbook is located at: `./Elo_Mafia_Rankings.xlsx` (same directory as the app). Make a backup copy before first write.

## Summary of Ghost Constraint Rules

| # of real players | # of ghosts | Ghost position restrictions |
|---|---|---|
| 15 | 0 | N/A |
| 14 | 1 | Cannot be in positions 1–3. Cannot be in positions 4–6 if that would put more than 1 ghost in 4–6 (only 1 ghost so this is fine, but it CAN be in 4–6). |
| 13 | 2 | Neither ghost in positions 1–3. At most 1 ghost in positions 4–6. At least 1 ghost must be in positions 7–15. |
