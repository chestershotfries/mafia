"""Seed a GCS JSON blob with the ego-mafia games from games_input.csv.

Produces the schema consumed by backend/json_store.py:

    {
      "tabs": {
        "MatchRatings": [["Player","mu","sigma"], ...],
        "MatchHistory": [[header...], [row], ...]   # newest first
      }
    }

Required env:
    SERVICE_ACCOUNT_KEY       JSON string of the service-account key, OR
    SERVICE_ACCOUNT_KEY_FILE  path to a key file (default: service-account.json)
    JSON_BUCKET               name of the GCS bucket
    JSON_OBJECT               object path inside the bucket (default: ego-mafia.json)

Usage:
    pip install trueskill google-cloud-storage google-auth
    JSON_BUCKET=my-bucket SERVICE_ACCOUNT_KEY_FILE=key.json \
        python bootstrap_gcs.py
"""

import csv
import json
import os
import sys
from pathlib import Path

from google.cloud import storage
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

SCOPES = [
    "https://www.googleapis.com/auth/devstorage.read_write",
    "https://www.googleapis.com/auth/cloud-platform",
]

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


def get_storage_client():
    key_json = os.environ.get("SERVICE_ACCOUNT_KEY")
    if key_json:
        info = json.loads(key_json)
        creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    else:
        key_file = os.environ.get("SERVICE_ACCOUNT_KEY_FILE", "service-account.json")
        creds = Credentials.from_service_account_file(key_file, scopes=SCOPES)
    return storage.Client(credentials=creds, project=creds.project_id)


def main():
    bucket_name = os.environ.get("JSON_BUCKET")
    object_name = os.environ.get("JSON_OBJECT", "ego-mafia.json")
    if not bucket_name:
        print("ERROR: JSON_BUCKET env var is required.", file=sys.stderr)
        sys.exit(1)

    order, games, winners = load_games()

    ratings = {}                # name -> {mu, sigma}
    history_rows_oldest = []    # oldest first; flipped on output

    for gid in order:
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
            role = s["role"] or "Town"
            alignment = "Mafia" if role == "Mafia" else "Town"
            if s["ghost"]:
                history_rows_oldest.append(
                    [str(int(gid)), name, role, "Ghost", "0", "", "", "", "", "", ""]
                )
            elif s["n0"]:
                history_rows_oldest.append(
                    [str(int(gid)), name, role, "Night Zero", "0", "", "", "", "", "", ""]
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
                history_rows_oldest.append([
                    str(int(gid)), name, role, result_str,
                    str(new_rating - old_rating),
                    repr(old["mu"]), repr(nr["mu"]), repr(nr["sigma"]),
                    str(old_rating), str(new_rating), repr(old["sigma"]),
                ])
                ratings[name] = {"mu": nr["mu"], "sigma": nr["sigma"]}

    # MatchHistory: newest at row 2 (header at row 1).
    history_tab = [HISTORY_HEADER] + list(reversed(history_rows_oldest))

    # MatchRatings: alphabetical by name (the backend only looks names up by index,
    # so order doesn't matter functionally).
    ratings_tab = [RATINGS_HEADER]
    for name in sorted(ratings):
        r = ratings[name]
        ratings_tab.append([name, repr(r["mu"]), repr(r["sigma"])])

    doc = {"tabs": {"MatchRatings": ratings_tab, "MatchHistory": history_tab}}
    body = json.dumps(doc, indent=2, ensure_ascii=False)

    client = get_storage_client()
    blob = client.bucket(bucket_name).blob(object_name)
    blob.upload_from_string(body, content_type="application/json")

    print(
        f"Wrote gs://{bucket_name}/{object_name}: "
        f"{len(ratings)} players, {len(order)} games, "
        f"{len(history_rows_oldest)} history rows."
    )


if __name__ == "__main__":
    main()
