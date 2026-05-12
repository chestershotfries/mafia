"""Process new-group game log CSV into a Match Results .xlsx workbook.

Reads games_input.csv (one row per slot), runs TrueSkill with the same
ghost-padded teams as backend/main.py, and writes match_results.xlsx with
MatchRatings and MatchHistory sheets. Also emits ../ego-mafia/data.json
consumed by the standalone ego-mafia static site.

Usage:
    pip install trueskill openpyxl scipy
    python process_games.py
"""

import csv
import json
from pathlib import Path

from openpyxl import Workbook
from trueskill import Rating, TrueSkill

HERE = Path(__file__).parent
INPUT_CSV = HERE / "games_input.csv"
OUTPUT_XLSX = HERE / "match_results.xlsx"
SITE_DATA = HERE.parent / "ego-mafia" / "data.json"

TRUESKILL_MU = 25
TRUESKILL_SIGMA = 25 / 3
MAFIA_GHOST_MU = 24.96
MAFIA_GHOST_SIGMA = 0.8
TOWN_GHOST_MU = 24.59
TOWN_GHOST_SIGMA = 0.8

env = TrueSkill(tau=0.1, beta=5.0, draw_probability=0.0)


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
            role = s["role"] or "Town"
            alignment = "Mafia" if role == "Mafia" else "Town"
            if s["ghost"]:
                history_rows.append(
                    [int(gid), name, role, "Ghost", 0, "", "", "", "", "", ""]
                )
            elif s["n0"]:
                history_rows.append(
                    [int(gid), name, role, "Night Zero", 0, "", "", "", "", "", ""]
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
                        role,
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

    write_site_data(order, games, winners, ratings, history_rows)


def write_site_data(order, games, winners, ratings, history_rows):
    """Emit data.json consumed by the ego-mafia static site."""
    # Per-player aggregate stats and per-player rated history (oldest first)
    stats = {}
    history = {}
    for row in reversed(history_rows):  # history_rows is oldest-first
        gid, name, role, result, rate_change = row[0], row[1], row[2], row[3], row[4]
        alignment = "Mafia" if role == "Mafia" else "Town"
        if result == "Ghost":
            continue
        entry = stats.setdefault(
            name,
            {
                "name": name,
                "town_games": 0,
                "town_wins": 0,
                "mafia_games": 0,
                "mafia_wins": 0,
            },
        )
        rated = result in ("Win", "Loss")
        if rated:
            if alignment == "Mafia":
                entry["mafia_games"] += 1
                if result == "Win":
                    entry["mafia_wins"] += 1
            else:
                entry["town_games"] += 1
                if result == "Win":
                    entry["town_wins"] += 1
        hist_entry = {
            "game_id": gid,
            "alignment": alignment,
            "result": result,
            "rate_change": int(rate_change) if rate_change != "" else 0,
        }
        if rated and row[8] != "" and row[9] != "":
            hist_entry["old_rating"] = int(row[8])
            hist_entry["new_rating"] = int(row[9])
        history.setdefault(name, []).append(hist_entry)

    players = []
    for name, r in ratings.items():
        s = stats.get(name, {"town_games": 0, "town_wins": 0, "mafia_games": 0, "mafia_wins": 0})
        total_games = s["town_games"] + s["mafia_games"]
        total_wins = s["town_wins"] + s["mafia_wins"]
        players.append(
            {
                "name": name,
                "mu": r["mu"],
                "sigma": r["sigma"],
                "rating": display_rating(r["mu"], r["sigma"]),
                "town_games": s["town_games"],
                "town_wins": s["town_wins"],
                "town_win_pct": round(100 * s["town_wins"] / s["town_games"], 1)
                if s["town_games"]
                else 0,
                "mafia_games": s["mafia_games"],
                "mafia_wins": s["mafia_wins"],
                "mafia_win_pct": round(100 * s["mafia_wins"] / s["mafia_games"], 1)
                if s["mafia_games"]
                else 0,
                "total_games": total_games,
                "total_wins": total_wins,
                "total_win_pct": round(100 * total_wins / total_games, 1) if total_games else 0,
            }
        )
    players.sort(key=lambda p: p["rating"], reverse=True)

    total_games = len(order)
    mafia_wins = sum(1 for g in order if winners[g].strip().lower().startswith("maf"))
    town_wins = total_games - mafia_wins
    game_summary = {
        "total_games": total_games,
        "mafia_wins": mafia_wins,
        "town_wins": town_wins,
        "mafia_win_pct": round(100 * mafia_wins / total_games, 1) if total_games else 0,
        "town_win_pct": round(100 * town_wins / total_games, 1) if total_games else 0,
    }

    # Build per-game player rows (last-game-style) from history_rows.
    # history_rows is oldest-first with columns:
    #   [gid, name, role, result, rate_change, old_mu, new_mu, new_sigma,
    #    old_rating, new_rating, old_sigma]
    games_by_gid = {}
    for r in history_rows:
        gid = int(r[0])
        name, role, result, rate_change = r[1], r[2], r[3], r[4]
        entry = {
            "player": name,
            "role": role,
            "alignment": "Mafia" if role == "Mafia" else "Town",
            "result": result,
            "rate_change": int(rate_change) if rate_change != "" else 0,
        }
        if r[5] != "" and r[8] != "" and r[9] != "":
            entry.update({
                "old_mu": float(r[5]),
                "new_mu": float(r[6]),
                "new_sigma": float(r[7]),
                "old_rating": int(r[8]),
                "new_rating": int(r[9]),
                "old_sigma": float(r[10]),
            })
        games_by_gid.setdefault(gid, []).append(entry)

    games_summary = []
    for gid in order:
        winner = winners[gid].strip().capitalize()
        games_summary.append({
            "game_id": int(gid),
            "winner": winner,
            "players": games_by_gid.get(int(gid), []),
        })
    games_summary.sort(key=lambda g: g["game_id"], reverse=True)

    SITE_DATA.parent.mkdir(parents=True, exist_ok=True)
    SITE_DATA.write_text(
        json.dumps(
            {
                "players": players,
                "game_summary": game_summary,
                "history": history,
                "games": games_summary,
            },
            indent=2,
        )
    )
    print(f"Wrote {SITE_DATA}")


if __name__ == "__main__":
    main()
