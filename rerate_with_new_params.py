#!/usr/bin/env python
"""Re-run all 108 historical games from Elo Mafia Rankings.xlsx through the
NEW ego-mafia ghost params (25.275 / 24.275, beta 5.0) and compare to the
original ratings (which were computed under 25.7 / 23.85, beta 5.5).

Reports:
- Total mafia winrate (unchanged — it's the historical outcomes)
- Mean rating change per alignment under NEW params vs original
- Per-player final rating: original vs re-rated
"""

import math
from pathlib import Path

import pandas as pd
from trueskill import Rating, TrueSkill

XLSX = Path("Elo Mafia Rankings.xlsx")

PRIOR_MU = 25.0
PRIOR_SIGMA = 25.0 / 3.0

# NEW ego-mafia params
MAFIA_GHOST_MU = 25.275
MAFIA_GHOST_SIGMA = 0.8
TOWN_GHOST_MU = 24.275
TOWN_GHOST_SIGMA = 0.8

env = TrueSkill(tau=0.1, beta=5.0, draw_probability=0.0)


def display_rating(mu, sigma):
    return max(round((mu - 1.5 * sigma) * 68), 0)


def rate_game(mafia_players, town_players, mafia_won, ratings):
    """Apply one game's rating update in-place on `ratings` (dict name → (mu,sigma))."""
    mafia_dict = {}
    mu_geo = 1.0
    sigma_geo = 1.0
    for name in mafia_players:
        mu, sigma = ratings.get(name, (PRIOR_MU, PRIOR_SIGMA))
        mafia_dict[name] = Rating(mu, sigma)
        mu_geo *= mu
        sigma_geo *= sigma
    n_m = len(mafia_players)
    mu_avg = mu_geo ** (1 / n_m)
    sigma_avg = sigma_geo ** (1 / n_m)

    n_t = len(town_players)
    for i in range(n_t - n_m):
        mafia_dict[f"_mafia_avg{i}"] = Rating(mu_avg, sigma_avg)
    for i in range(n_t):
        mafia_dict[f"_mafia_ghost{i}"] = Rating(MAFIA_GHOST_MU, MAFIA_GHOST_SIGMA)

    town_dict = {}
    for name in town_players:
        mu, sigma = ratings.get(name, (PRIOR_MU, PRIOR_SIGMA))
        town_dict[name] = Rating(mu, sigma)
    for i in range(n_t):
        town_dict[f"_town_ghost{i}"] = Rating(TOWN_GHOST_MU, TOWN_GHOST_SIGMA)

    ranks = [0, 1] if mafia_won else [1, 0]
    rated = env.rate([mafia_dict, town_dict], ranks=ranks)

    deltas = {}
    for name in mafia_players:
        old = display_rating(*ratings.get(name, (PRIOR_MU, PRIOR_SIGMA)))
        r = rated[0][name]
        ratings[name] = (r.mu, r.sigma)
        deltas[name] = display_rating(r.mu, r.sigma) - old
    for name in town_players:
        old = display_rating(*ratings.get(name, (PRIOR_MU, PRIOR_SIGMA)))
        r = rated[1][name]
        ratings[name] = (r.mu, r.sigma)
        deltas[name] = display_rating(r.mu, r.sigma) - old
    return deltas


def main():
    mh = pd.read_excel(XLSX, sheet_name="MatchHistory")
    mh = mh[mh.Result.isin(["Win", "Loss"])].copy()

    ss = pd.read_excel(XLSX, sheet_name="Stats Summary")
    orig = {row["Name"]: row for _, row in ss.iterrows()}

    ratings = {}
    sum_maf_d_win = sum_maf_d_loss = 0.0
    sum_twn_d_win = sum_twn_d_loss = 0.0
    n_maf_w = n_maf_l = n_twn_w = n_twn_l = 0
    n_mafia_wins = 0

    gids = sorted(mh.GameID.unique())
    for gid in gids:
        g = mh[mh.GameID == gid]
        mafia = g[g.Alignment == "Mafia"].Player.tolist()
        town = g[g.Alignment == "Town"].Player.tolist()
        mafia_won = (g.query("Alignment == 'Mafia'").Result == "Win").any()
        if mafia_won:
            n_mafia_wins += 1
        deltas = rate_game(mafia, town, mafia_won, ratings)
        for name in mafia:
            d = deltas[name]
            if mafia_won:
                sum_maf_d_win += d
                n_maf_w += 1
            else:
                sum_maf_d_loss += d
                n_maf_l += 1
        for name in town:
            d = deltas[name]
            if not mafia_won:
                sum_twn_d_win += d
                n_twn_w += 1
            else:
                sum_twn_d_loss += d
                n_twn_l += 1

    n_games = len(gids)
    print("=" * 90)
    print(f"Re-rating {n_games} games from Elo Mafia Rankings.xlsx")
    print(f"NEW params: ghosts {MAFIA_GHOST_MU} / {TOWN_GHOST_MU}, "
          f"beta={env.beta}")
    print("=" * 90)
    print(f"\nMafia winrate (historical): {n_mafia_wins / n_games:.1%} "
          f"({n_mafia_wins}/{n_games})  — unchanged, this is historical outcome")
    print(f"\nMean RateChange under NEW params:")
    print(f"  MafW Δ  = {sum_maf_d_win / max(n_maf_w, 1):>+7.2f}  (n={n_maf_w})")
    print(f"  MafL Δ  = {sum_maf_d_loss / max(n_maf_l, 1):>+7.2f}  (n={n_maf_l})")
    print(f"  TwnW Δ  = {sum_twn_d_win / max(n_twn_w, 1):>+7.2f}  (n={n_twn_w})")
    print(f"  TwnL Δ  = {sum_twn_d_loss / max(n_twn_l, 1):>+7.2f}  (n={n_twn_l})")
    maf_total = sum_maf_d_win + sum_maf_d_loss
    twn_total = sum_twn_d_win + sum_twn_d_loss
    print(f"  MafNet  = {maf_total / max(n_maf_w + n_maf_l, 1):>+7.2f}")
    print(f"  TwnNet  = {twn_total / max(n_twn_w + n_twn_l, 1):>+7.2f}")
    print(f"\nFor comparison, ORIGINAL params (25.7/23.85, beta=5.5):")
    print(f"  MafW Δ  = +48.15   MafL Δ  =  -73.23   TwnW Δ  = +84.17   TwnL Δ  = -40.02")
    print(f"  MafNet  = -12.54   TwnNet  =  +22.35")

    # Per-player rating comparison
    print("\nPer-player final ratings (sorted by ORIGINAL rating descending):")
    print(f"{'Player':<14}{'Games':>6}{'Maf%':>6}"
          f"  {'OldMu':>7}{'OldSig':>7}{'OldRtg':>7}"
          f"  {'NewMu':>7}{'NewSig':>7}{'NewRtg':>7}"
          f"  {'Δ Rtg':>7}")
    print("-" * 90)
    players_sorted = sorted(
        orig.items(),
        key=lambda kv: kv[1]["Rating"],
        reverse=True,
    )
    for name, srow in players_sorted:
        if name not in ratings:
            continue
        new_mu, new_sigma = ratings[name]
        new_rtg = display_rating(new_mu, new_sigma)
        old_rtg = int(srow["Rating"])
        maf_games = int(srow["Mafia Games"])
        tot_games = int(srow["Total Games"])
        maf_pct = maf_games / tot_games if tot_games else 0
        print(f"{name:<14}{tot_games:>6}{maf_pct:>6.0%}"
              f"  {srow['Mu']:>7.2f}{srow['Sigma']:>7.2f}{old_rtg:>7d}"
              f"  {new_mu:>7.2f}{new_sigma:>7.2f}{new_rtg:>7d}"
              f"  {new_rtg - old_rtg:>+7d}")

    # Mafia-heavy players: who benefits most from re-rating?
    print("\nTop 10 RATING GAINERS (re-rated minus original):")
    diffs = []
    for name, srow in orig.items():
        if name in ratings:
            new_rtg = display_rating(*ratings[name])
            diffs.append((name, new_rtg - int(srow["Rating"]),
                          int(srow["Mafia Games"]), int(srow["Total Games"]),
                          float(srow["Mafia Win %"]) if srow["Mafia Games"] else 0))
    diffs.sort(key=lambda x: x[1], reverse=True)
    print(f"{'Player':<14}{'Δ Rtg':>7}  {'MafGm':>6}{'TotGm':>6}{'MafWin%':>9}")
    for name, d, mg, tg, mwp in diffs[:10]:
        print(f"{name:<14}{d:>+7d}  {mg:>6d}{tg:>6d}{mwp:>9.1%}")
    print("\nTop 10 RATING LOSERS:")
    for name, d, mg, tg, mwp in diffs[-10:][::-1]:
        print(f"{name:<14}{d:>+7d}  {mg:>6d}{tg:>6d}{mwp:>9.1%}")


if __name__ == "__main__":
    main()
