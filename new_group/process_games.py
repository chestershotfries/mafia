"""Process new-group game log CSV into a Match Results .xlsx workbook.

Reads games_input.csv (one row per slot), runs TrueSkill with the same
ghost-padded teams as backend/main.py, and writes match_results.xlsx with
MatchRatings and MatchHistory sheets.

Usage:
    pip install trueskill openpyxl scipy
    python process_games.py
"""

import csv
from pathlib import Path

from openpyxl import Workbook
from trueskill import Rating, TrueSkill

HERE = Path(__file__).parent
INPUT_CSV = HERE / "games_input.csv"
OUTPUT_XLSX = HERE / "match_results.xlsx"

TRUESKILL_MU = 25
TRUESKILL_SIGMA = 25 / 3
MAFIA_GHOST_MU = 25.7
MAFIA_GHOST_SIGMA = 0.8
TOWN_GHOST_MU = 23.85
TOWN_GHOST_SIGMA = 0.8

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
        r = rated[0][p["name"]]
        out[p["name"]] = {"mu": r.mu, "sigma": r.sigma}
    for p in town_players:
        r = rated[1][p["name"]]
        out[p["name"]] = {"mu": r.mu, "sigma": r.sigma}
    return out


def load_games():
    games = {}
    order = []
    winners = {}
    with open(INPUT_CSV, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
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


def main():
    order, games, winners = load_games()
    ratings = {}
    history_rows = []

    for gid in order:
        rows = games[gid]
        winner = winners.get(gid)
        if not winner:
            raise ValueError(f"Game {gid} missing Winner (set on any row)")
        mafia_won = winner.strip().lower().startswith("maf")

        slots = []
        for r in rows:
            name = r["Name"].strip()
            role = r["Role"].strip()
            is_ghost = parse_bool(r.get("IsGhost", ""))
            is_n0 = parse_bool(r.get("NightZero", ""))
            position = int(r["Position"])
            slots.append(
                {
                    "position": position,
                    "name": name,
                    "role": role,
                    "ghost": is_ghost,
                    "n0": is_n0,
                }
            )

        mafia_players = []
        town_players = []
        for s in slots:
            if s["ghost"] or s["n0"] or not s["name"]:
                continue
            cr = ratings.get(s["name"], {"mu": TRUESKILL_MU, "sigma": TRUESKILL_SIGMA})
            entry = {"name": s["name"], "mu": cr["mu"], "sigma": cr["sigma"]}
            if s["role"] == "Mafia":
                mafia_players.append(entry)
            else:
                town_players.append(entry)

        new_ratings = compute_trueskill(mafia_players, town_players, mafia_won)

        for s in sorted(slots, key=lambda x: x["position"]):
            name = s["name"]
            alignment = "Mafia" if s["role"] == "Mafia" else "Town"
            if s["ghost"]:
                history_rows.append(
                    [int(gid), name, alignment, "Ghost", 0, "", "", "", "", "", ""]
                )
            elif s["n0"]:
                history_rows.append(
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
                history_rows.append(
                    [
                        int(gid),
                        name,
                        alignment,
                        result_str,
                        new_rating - old_rating,
                        old["mu"],
                        nr["mu"],
                        nr["sigma"],
                        old_rating,
                        new_rating,
                        old["sigma"],
                    ]
                )
                ratings[name] = {"mu": nr["mu"], "sigma": nr["sigma"]}

    wb = Workbook()
    ws_r = wb.active
    ws_r.title = "MatchRatings"
    ws_r.append(["Player", "mu", "sigma", "Rating"])
    sorted_players = sorted(
        ratings.items(),
        key=lambda kv: display_rating(kv[1]["mu"], kv[1]["sigma"]),
        reverse=True,
    )
    for name, r in sorted_players:
        ws_r.append([name, r["mu"], r["sigma"], display_rating(r["mu"], r["sigma"])])

    ws_h = wb.create_sheet("MatchHistory")
    ws_h.append(
        [
            "GameID",
            "Player",
            "Alignment",
            "Result",
            "RateChange",
            "old_mu",
            "new_mu",
            "new_sigma",
            "old_rating",
            "new_rating",
            "old_sigma",
        ]
    )
    for row in reversed(history_rows):
        ws_h.append(row)

    wb.save(OUTPUT_XLSX)
    print(f"Wrote {OUTPUT_XLSX} ({len(ratings)} players, {len(order)} games)")


if __name__ == "__main__":
    main()
