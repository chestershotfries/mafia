"""One-shot import: push games_input.csv into a fresh Google Sheet.

The sheet must already exist with `MatchRatings` and `MatchHistory` tabs
(empty or with just the header row). The service account credentials need
edit access to the sheet.

Required env:
    SERVICE_ACCOUNT_KEY      JSON string of the service-account key, OR
    SERVICE_ACCOUNT_KEY_FILE path to a key file (default: service-account.json)
    TARGET_SHEET_ID          Google Sheet ID for the ego-mafia group

Usage:
    pip install trueskill gspread google-auth
    SERVICE_ACCOUNT_KEY_FILE=key.json TARGET_SHEET_ID=<id> python bootstrap_sheet.py
"""

import csv
import json
import os
import sys
from pathlib import Path

import gspread
from google.oauth2.service_account import Credentials
from trueskill import Rating, TrueSkill

HERE = Path(__file__).parent
INPUT_CSV = HERE / "games_input.csv"

TRUESKILL_MU = 25
TRUESKILL_SIGMA = 25 / 3
MAFIA_GHOST_MU = 25.7
MAFIA_GHOST_SIGMA = 0.8
TOWN_GHOST_MU = 23.85
TOWN_GHOST_SIGMA = 0.8

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

RATINGS_HEADER = ["Player", "mu", "sigma"]
HISTORY_HEADER = [
    "GameID", "Player", "Alignment", "Result", "RateChange",
    "old_mu", "new_mu", "new_sigma", "old_rating", "new_rating", "old_sigma",
]

env = TrueSkill(tau=0.1, beta=5.5, draw_probability=0.0)


def display_rating(mu, sigma):
    return round((mu - 1.5 * sigma) * 68)


def parse_bool(v):
    return str(v).strip().lower() in ("true", "1", "yes", "y", "t")


def compute_trueskill(mafia_players, town_players, mafia_won):
    n_mafia = len(mafia_players)
    n_town = len(town_players)

    mafia_dict = {}
    mu_geo = 1.0
    sigma_geo = 1.0
    for p in mafia_players:
        mafia_dict[p["name"]] = Rating(p["mu"], p["sigma"])
        mu_geo *= p["mu"]
        sigma_geo *= p["sigma"]
    mu_avg = mu_geo ** (1 / n_mafia)
    sigma_avg = sigma_geo ** (1 / n_mafia)
    for i in range(n_town - n_mafia):
        mafia_dict[f"_mafia_avg{i}"] = Rating(mu_avg, sigma_avg)
    for i in range(n_town):
        mafia_dict[f"_mafia_ghost{i}"] = Rating(MAFIA_GHOST_MU, MAFIA_GHOST_SIGMA)

    town_dict = {}
    for p in town_players:
        town_dict[p["name"]] = Rating(p["mu"], p["sigma"])
    for i in range(n_town):
        town_dict[f"_town_ghost{i}"] = Rating(TOWN_GHOST_MU, TOWN_GHOST_SIGMA)

    ranks = [0, 1] if mafia_won else [1, 0]
    rated = env.rate([mafia_dict, town_dict], ranks=ranks)
    out = {}
    for p in mafia_players:
        r = rated[0][p["name"]]; out[p["name"]] = {"mu": r.mu, "sigma": r.sigma}
    for p in town_players:
        r = rated[1][p["name"]]; out[p["name"]] = {"mu": r.mu, "sigma": r.sigma}
    return out


def load_games():
    games = {}
    order = []
    winners = {}
    with open(INPUT_CSV, newline="") as f:
        for row in csv.DictReader(f):
            gid = row["GameID"].strip()
            if not gid:
                continue
            if gid not in games:
                games[gid] = []
                order.append(gid)
            games[gid].append(row)
            w = row.get("Winner", "").strip()
            if w:
                winners[gid] = w
    return order, games, winners


def get_gc():
    key_json = os.environ.get("SERVICE_ACCOUNT_KEY")
    if key_json:
        info = json.loads(key_json)
        creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    else:
        key_file = os.environ.get("SERVICE_ACCOUNT_KEY_FILE", "service-account.json")
        creds = Credentials.from_service_account_file(key_file, scopes=SCOPES)
    return gspread.authorize(creds)


def ensure_headers(ws, header):
    existing = ws.row_values(1)
    if existing != header:
        ws.update("A1", [header])


def main():
    sheet_id = os.environ.get("TARGET_SHEET_ID")
    if not sheet_id:
        print("ERROR: TARGET_SHEET_ID env var is required.", file=sys.stderr)
        sys.exit(1)

    order, games, winners = load_games()
    gc = get_gc()
    ss = gc.open_by_key(sheet_id)
    ws_ratings = ss.worksheet("MatchRatings")
    ws_history = ss.worksheet("MatchHistory")

    ensure_headers(ws_ratings, RATINGS_HEADER)
    ensure_headers(ws_history, HISTORY_HEADER)

    # Skip any games already present in MatchHistory
    existing_game_ids = set()
    for r in ws_history.get_all_values()[1:]:
        if r and r[0]:
            existing_game_ids.add(r[0])

    ratings = {}  # in-memory; we'll overwrite MatchRatings at the end
    history_rows_to_prepend = []  # collected oldest-first; we'll reverse before write

    for gid in order:
        if gid in existing_game_ids:
            print(f"Skipping game {gid} (already in sheet)")
            continue
        rows = games[gid]
        winner = winners.get(gid)
        if not winner:
            raise ValueError(f"Game {gid} missing Winner")
        mafia_won = winner.strip().lower().startswith("maf")

        slots = []
        for r in rows:
            slots.append({
                "position": int(r["Position"]),
                "name": r["Name"].strip(),
                "role": r["Role"].strip(),
                "ghost": parse_bool(r.get("IsGhost", "")),
                "n0": parse_bool(r.get("NightZero", "")),
            })

        mafia_players, town_players = [], []
        for s in slots:
            if s["ghost"] or s["n0"] or not s["name"]:
                continue
            cur = ratings.get(s["name"], {"mu": TRUESKILL_MU, "sigma": TRUESKILL_SIGMA})
            entry = {"name": s["name"], "mu": cur["mu"], "sigma": cur["sigma"]}
            if s["role"] == "Mafia":
                mafia_players.append(entry)
            else:
                town_players.append(entry)

        new_ratings = compute_trueskill(mafia_players, town_players, mafia_won)

        for s in sorted(slots, key=lambda x: x["position"]):
            name = s["name"]
            alignment = "Mafia" if s["role"] == "Mafia" else "Town"
            if s["ghost"]:
                history_rows_to_prepend.append(
                    [int(gid), name, alignment, "Ghost", 0, "", "", "", "", "", ""]
                )
            elif s["n0"]:
                history_rows_to_prepend.append(
                    [int(gid), name, alignment, "Night Zero", 0, "", "", "", "", "", ""]
                )
            elif name:
                old = ratings.get(name, {"mu": TRUESKILL_MU, "sigma": TRUESKILL_SIGMA})
                nr = new_ratings[name]
                old_rating = display_rating(old["mu"], old["sigma"])
                new_rating = display_rating(nr["mu"], nr["sigma"])
                result_str = (
                    ("Win" if alignment == "Mafia" else "Loss")
                    if mafia_won
                    else ("Loss" if alignment == "Mafia" else "Win")
                )
                history_rows_to_prepend.append([
                    int(gid), name, alignment, result_str,
                    new_rating - old_rating,
                    old["mu"], nr["mu"], nr["sigma"],
                    old_rating, new_rating, old["sigma"],
                ])
                ratings[name] = {"mu": nr["mu"], "sigma": nr["sigma"]}

    if not history_rows_to_prepend:
        print("Nothing to write.")
        return

    # MatchHistory: newest at row 2. Insert in reverse so latest game ends up on top.
    ws_history.insert_rows(list(reversed(history_rows_to_prepend)), row=2)

    # MatchRatings: replace contents below header.
    ratings_data = ws_ratings.get_all_values()
    existing_names = {r[0]: i + 1 for i, r in enumerate(ratings_data[1:], start=2) if r and r[0]}
    for name, r in ratings.items():
        row = [name, r["mu"], r["sigma"]]
        if name in existing_names:
            ws_ratings.update(f"A{existing_names[name]}:C{existing_names[name]}", [row])
        else:
            ws_ratings.append_row(row, value_input_option="USER_ENTERED")

    print(
        f"Wrote {len(history_rows_to_prepend)} history rows and "
        f"{len(ratings)} player rating(s) to sheet {sheet_id}."
    )


if __name__ == "__main__":
    main()
