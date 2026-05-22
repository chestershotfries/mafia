# TrueSkill Calculation Discrepancy Investigation

## Problem

The backend's TrueSkill ratings differ from the values produced by "the other
guy" who runs `Mafia_Rating_Experimental.py`. The difference is systematic:
~0.10 in mu for all players in game 112.

## Game 112 Test Data

- 3 mafia (Gilbert, Chelsea, Levi), 10 town entries (9 unique — duplicate Badpants)
- Town won (`mafia_won = False`)
- Parameters: `tau=0.1, beta=5.5, draw_probability=0.00`
- Ghost params: mafia ghost mu=25.7 sigma=0.8, town ghost mu=23.85 sigma=0.8
- Full data hardcoded in `verify_game112.py`

### Example: Gilbert

| Source | new_mu | Diff from expected |
|--------|--------|--------------------|
| Backend (20v19 dedup) | 23.6108 | -0.1028 |
| No dedup (20v20) | 24.0796 | +0.3659 |
| Expected (other guy) | 23.7136 | — |
| trueskill with beta=6.0 | 23.7143 | +0.0006 |

## What Was Tested

### Libraries

- `trueskill` 0.4.5 (sublee) — current library, all three numerical backends
- `trueskill` 0.4.4 — older version
- `skills` 0.3.0 (PythonSkills/McLeopold) — different TrueSkill implementation
- `openskill` — uses Weng-Lin algorithm, not TrueSkill (not tested)

### Numerical Backends

All three produce identical results (diff < 0.00000014):

- scipy
- mpmath
- builtin (pure Python)

### Parameter Sweeps

- `draw_probability`: 0.0 through 0.20 — none match
- `tau`: 0.0 through 0.5 — negligible effect
- `beta`: **6.0 matches almost exactly** (diff=+0.0006)
- Ghost sigma: 0.5 through 4.167 — none match
- Ghost count: 8 through 15 — none match

### Team Construction Variations

- 20v19 (dict dedup of duplicate Badpants) — backend default
- 20v20 (renamed duplicate to Badpants_2) — no dedup
- 18v18 (9 unique town, no duplicate)
- Various with Matt as separate player
- None match expected values

### Import/Calling Differences

- `from trueskill import *` + `make_as_global()` vs explicit import — identical
- `env.rate()` vs global `rate()` — identical

## Key Finding

The ONLY configuration that matches the expected output is `beta=6.0` instead
of `5.5`. The experimental script hardcodes `beta=5.5` on line 18. Either:

1. The other guy has a locally modified copy with different beta
2. The other guy's script has some other structural difference
3. There is some other environmental factor we haven't identified

## Files

- `backend/verify_game112.py` — standalone verification script with all test methods
- `backend/main.py` — backend `compute_trueskill()` at line 67
- `Mafia_Rating_Experimental.py` — reference script the other guy runs

## Next Step

Get the other guy's actual source code and diff it against
`Mafia_Rating_Experimental.py`. Key things to check:

- `beta` value (line 18 of experimental script)
- Team construction logic in `rate_game()` (lines 111-158)
- Ghost parameters and counts
- Whether N0 players are excluded the same way
- Any local modifications to the trueskill library itself
