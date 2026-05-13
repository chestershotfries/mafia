#!/usr/bin/env python
"""Compare two ghost-μ TrueSkill configurations across 100 simulated seasons each.

Uses the empirical participation distribution from `Elo Mafia Rankings.xlsx`
(86 players, real `Total Games` as per-game inclusion weights). For each
config, runs 100 independent simulations of 500 games, samples each game's
winner from the configured TrueSkill ghost-padded win-probability over hidden
true skills, applies the standard rating update, and snapshots metrics at
100 and 500 games. Prints distributional statistics (mean / std / quartile
band / fraction matching real-data 50% target) side-by-side so we can see
which config produces a more realistic and fairer simulation.
"""

import itertools
import math
import random
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from trueskill import Rating, TrueSkill

XLSX = "Elo Mafia Rankings.xlsx"

# Game shape
ROSTER_SIZE = 15
NUM_MAFIA = 3
NUM_TOWN = 10
NUM_NIGHT_ZERO = 2

# Sim params
NUM_GAMES = 500
SNAPSHOT_AT = [100, 500]  # game-count snapshots to report
NUM_RUNS = 100

PRIOR_MU = 25.0
PRIOR_SIGMA = 25.0 / 3.0
TRUE_SKILL_MEAN = 25.0
TRUE_SKILL_STD = 25.0 / 3.0

SEED = 42


@dataclass
class Config:
    label: str
    env: TrueSkill
    mafia_ghost_mu: float
    mafia_ghost_sigma: float
    town_ghost_mu: float
    town_ghost_sigma: float


# Shared env (matches ego_mafia/process_games.py beta=5.0)
_ENV = TrueSkill(tau=0.1, beta=5.0, draw_probability=0.0)


def _mk(label, gap):
    """Build a Config with ghost mu's centered at 24.775 and the given gap."""
    mid = 24.775
    return Config(
        label=label,
        env=_ENV,
        mafia_ghost_mu=mid + gap / 2,
        mafia_ghost_sigma=0.8,
        town_ghost_mu=mid - gap / 2,
        town_ghost_sigma=0.8,
    )


# Current NEW baseline + tuning sweep targeting ~52% MafWR
CONFIGS = [
    Config(  # current NEW exactly as shipped
        label="NEW baseline (gap 0.37 — 24.96/24.59)",
        env=_ENV,
        mafia_ghost_mu=24.96, mafia_ghost_sigma=0.8,
        town_ghost_mu=24.59, town_ghost_sigma=0.8,
    ),
    _mk("gap 0.60 (25.075/24.475)", 0.60),
    _mk("gap 0.80 (25.175/24.375)", 0.80),
    _mk("gap 1.00 (25.275/24.275)", 1.00),
]


@dataclass
class Player:
    name: str
    true_mu: float
    weight: float
    mu: float = PRIOR_MU
    sigma: float = PRIOR_SIGMA


def display_rating(mu, sigma):
    return max(round((mu - 1.5 * sigma) * 68), 0)


def win_probability(team1, team2, env):
    delta_mu = sum(r.mu for r in team1) - sum(r.mu for r in team2)
    sum_sigma = sum(r.sigma ** 2 for r in itertools.chain(team1, team2))
    size = len(team1) + len(team2)
    denom = math.sqrt(size * (env.beta * env.beta) + sum_sigma)
    return env.cdf(delta_mu / denom)


def sample_mafia_win(mafia, town, cfg, rng):
    eps = 1e-6
    mafia_team = [Rating(p.true_mu, eps) for p in mafia]
    town_team = [Rating(p.true_mu, eps) for p in town]
    mu_geo = math.prod(p.true_mu for p in mafia) ** (1 / len(mafia))
    for _ in range(len(town) - len(mafia)):
        mafia_team.append(Rating(mu_geo, eps))
    for _ in range(len(town)):
        mafia_team.append(Rating(cfg.mafia_ghost_mu, cfg.mafia_ghost_sigma))
        town_team.append(Rating(cfg.town_ghost_mu, cfg.town_ghost_sigma))
    return rng.random() < win_probability(mafia_team, town_team, cfg.env)


def weighted_sample(players, k, rng):
    keys = [(rng.random() ** (1.0 / p.weight), p) for p in players]
    keys.sort(key=lambda kv: kv[0], reverse=True)
    return [p for _, p in keys[:k]]


def rate_game(mafia, town, mafia_won, cfg):
    mafia_dict = {p.name: Rating(p.mu, p.sigma) for p in mafia}
    town_dict = {p.name: Rating(p.mu, p.sigma) for p in town}
    for i in range(len(town)):
        town_dict[f"town_ghost{i}"] = Rating(cfg.town_ghost_mu, cfg.town_ghost_sigma)
    mu_geo = math.prod(p.mu for p in mafia) ** (1 / len(mafia))
    sigma_geo = math.prod(p.sigma for p in mafia) ** (1 / len(mafia))
    for i in range(len(town) - len(mafia)):
        mafia_dict[f"mafia_avg{i}"] = Rating(mu_geo, sigma_geo)
    for i in range(len(town)):
        mafia_dict[f"mafia_ghost{i}"] = Rating(cfg.mafia_ghost_mu, cfg.mafia_ghost_sigma)

    ranks = [0, 1] if mafia_won else [1, 0]
    rated = cfg.env.rate([mafia_dict, town_dict], ranks=ranks)

    deltas = {}
    for p in mafia:
        old_r = display_rating(p.mu, p.sigma)
        new = rated[0][p.name]
        p.mu, p.sigma = new.mu, new.sigma
        deltas[p.name] = display_rating(p.mu, p.sigma) - old_r
    for p in town:
        old_r = display_rating(p.mu, p.sigma)
        new = rated[1][p.name]
        p.mu, p.sigma = new.mu, new.sigma
        deltas[p.name] = display_rating(p.mu, p.sigma) - old_r
    return deltas


def load_real_weights():
    ss = pd.read_excel(XLSX, sheet_name="Stats Summary")
    return ss["Total Games"].to_numpy(dtype=float)


def run_simulation(seed, weights, cfg):
    rng = random.Random(seed)
    np_rng = np.random.default_rng(seed)

    n = len(weights)
    true_skills = np_rng.normal(TRUE_SKILL_MEAN, TRUE_SKILL_STD, n).clip(min=1.0)
    players = [
        Player(name=f"P{i+1:03d}", true_mu=float(true_skills[i]),
               weight=float(weights[i]))
        for i in range(n)
    ]

    snaps = {}
    mafia_win_count = 0
    sum_maf_d = sum_maf_w_d = sum_maf_l_d = 0.0
    sum_twn_d = sum_twn_w_d = sum_twn_l_d = 0.0
    n_maf_rows = n_maf_w = n_maf_l = 0
    n_twn_rows = n_twn_w = n_twn_l = 0

    for g in range(1, NUM_GAMES + 1):
        roster = weighted_sample(players, ROSTER_SIZE, rng)
        rng.shuffle(roster)
        mafia = roster[:NUM_MAFIA]
        town = roster[NUM_MAFIA:NUM_MAFIA + NUM_TOWN]
        mafia_won = sample_mafia_win(mafia, town, cfg, rng)
        deltas = rate_game(mafia, town, mafia_won, cfg)

        for p in mafia:
            d = deltas[p.name]
            sum_maf_d += d
            n_maf_rows += 1
            if mafia_won:
                sum_maf_w_d += d
                n_maf_w += 1
            else:
                sum_maf_l_d += d
                n_maf_l += 1
        for p in town:
            d = deltas[p.name]
            sum_twn_d += d
            n_twn_rows += 1
            if not mafia_won:
                sum_twn_w_d += d
                n_twn_w += 1
            else:
                sum_twn_l_d += d
                n_twn_l += 1
        if mafia_won:
            mafia_win_count += 1

        if g in SNAPSHOT_AT:
            true_mus = np.array([p.true_mu for p in players])
            disp = np.array([display_rating(p.mu, p.sigma) for p in players])
            rho, _ = spearmanr(disp, true_mus)
            snaps[g] = {
                "mafia_winrate": mafia_win_count / g,
                "maf_w_d": sum_maf_w_d / max(n_maf_w, 1),
                "maf_l_d": sum_maf_l_d / max(n_maf_l, 1),
                "twn_w_d": sum_twn_w_d / max(n_twn_w, 1),
                "twn_l_d": sum_twn_l_d / max(n_twn_l, 1),
                "maf_net": sum_maf_d / max(n_maf_rows, 1),
                "twn_net": sum_twn_d / max(n_twn_rows, 1),
                "spearman": float(rho),
            }
    return snaps


def aggregate_runs(all_snaps, game):
    """Compute distributional stats for one game-snapshot across all runs."""
    metrics = {}
    keys = ["mafia_winrate", "maf_w_d", "maf_l_d", "twn_w_d", "twn_l_d",
            "maf_net", "twn_net", "spearman"]
    for k in keys:
        vals = np.array([s[game][k] for s in all_snaps])
        metrics[k] = {
            "mean": float(vals.mean()),
            "std": float(vals.std()),
            "p10": float(np.percentile(vals, 10)),
            "p50": float(np.percentile(vals, 50)),
            "p90": float(np.percentile(vals, 90)),
            "min": float(vals.min()),
            "max": float(vals.max()),
        }
    return metrics


def fraction_in_band(all_snaps, game, key, low, high):
    vals = np.array([s[game][key] for s in all_snaps])
    return float(((vals >= low) & (vals <= high)).mean())


def fmt_pct(x):
    return f"{x:>6.1%}"


def fmt_num(x):
    return f"{x:>+7.2f}"


def print_config_stats(label, all_snaps):
    print(f"\n{'=' * 86}")
    print(f"{label}  —  {NUM_RUNS} runs × {NUM_GAMES} games each")
    print('=' * 86)
    for g in SNAPSHOT_AT:
        m = aggregate_runs(all_snaps, g)
        in_band = fraction_in_band(all_snaps, g, "mafia_winrate", 0.45, 0.55)
        maf_fair = fraction_in_band(all_snaps, g, "maf_net", -2.0, 2.0)
        twn_fair = fraction_in_band(all_snaps, g, "twn_net", -2.0, 2.0)

        print(f"\n  Snapshot @ {g} games")
        print(f"  {'Metric':<18}{'mean':>8}{'std':>7}{'p10':>8}{'p50':>8}{'p90':>8}"
              f"{'min':>8}{'max':>8}")
        print("  " + "-" * 73)

        def line(label, key, fmt):
            mm = m[key]
            print(f"  {label:<18}"
                  f"{fmt(mm['mean']):>8}{fmt(mm['std']):>7}"
                  f"{fmt(mm['p10']):>8}{fmt(mm['p50']):>8}{fmt(mm['p90']):>8}"
                  f"{fmt(mm['min']):>8}{fmt(mm['max']):>8}")
        # winrate uses pct formatting (no signed)
        ww = m["mafia_winrate"]
        print(f"  {'MafWR':<18}{ww['mean']:>7.1%} {ww['std']:>6.1%} "
              f"{ww['p10']:>7.1%} {ww['p50']:>7.1%} {ww['p90']:>7.1%} "
              f"{ww['min']:>7.1%} {ww['max']:>7.1%}")
        for k, lbl in [("maf_w_d", "MafW Δ"), ("maf_l_d", "MafL Δ"),
                       ("twn_w_d", "TwnW Δ"), ("twn_l_d", "TwnL Δ"),
                       ("maf_net", "MafNet"), ("twn_net", "TwnNet")]:
            mm = m[k]
            print(f"  {lbl:<18}{mm['mean']:>+7.2f} {mm['std']:>6.2f} "
                  f"{mm['p10']:>+7.2f} {mm['p50']:>+7.2f} {mm['p90']:>+7.2f} "
                  f"{mm['min']:>+7.2f} {mm['max']:>+7.2f}")
        mm = m["spearman"]
        print(f"  {'Spearman':<18}{mm['mean']:>7.3f} {mm['std']:>6.3f} "
              f"{mm['p10']:>7.3f} {mm['p50']:>7.3f} {mm['p90']:>7.3f} "
              f"{mm['min']:>7.3f} {mm['max']:>7.3f}")
        print(f"  Fraction of runs with MafWR ∈ [45%, 55%]:  {in_band:.0%}")
        print(f"  Fraction of runs with MafNet ∈ [-2, +2]:   {maf_fair:.0%}")
        print(f"  Fraction of runs with TwnNet ∈ [-2, +2]:   {twn_fair:.0%}")


def main():
    weights = load_real_weights()
    print("=" * 86)
    print(f"Ghost-μ Configuration Comparison  ({NUM_RUNS} runs each)")
    print("=" * 86)
    print(f"Pool: {len(weights)} players, true skill ~ "
          f"N({TRUE_SKILL_MEAN}, {TRUE_SKILL_STD:.2f})")
    print(f"Participation weights: real `Total Games` "
          f"(max={weights.max():.0f}, mean={weights.mean():.1f})")
    print(f"Roster: {NUM_MAFIA} mafia / {NUM_TOWN} town / {NUM_NIGHT_ZERO} N0")
    print(f"Real-data anchor: 108 games, MafWR=50.0%, "
          f"MafNet=-12.54, TwnNet=+22.35 (rated under OLD params)")

    summary_rows = []
    for cfg in CONFIGS:
        all_snaps = []
        for i in range(NUM_RUNS):
            snaps = run_simulation(SEED + i, weights, cfg)
            all_snaps.append(snaps)
        print_config_stats(cfg.label, all_snaps)
        m500 = aggregate_runs(all_snaps, 500)
        in_band = fraction_in_band(all_snaps, 500, "mafia_winrate", 0.45, 0.55)
        summary_rows.append({
            "label": cfg.label,
            "mafwr": m500["mafia_winrate"],
            "mafnet": m500["maf_net"],
            "twnnet": m500["twn_net"],
            "spear": m500["spearman"],
            "in_band": in_band,
        })

    print("\n" + "=" * 86)
    print("SUMMARY @ 500 games  —  which config lands closest to 52% MafWR?")
    print("=" * 86)
    print(f"{'Config':<42}{'MafWR':>10}{'MafNet':>10}{'TwnNet':>10}{'Spear':>8}")
    print("-" * 86)
    for r in summary_rows:
        print(f"{r['label']:<42}"
              f"{r['mafwr']['mean']:>8.1%}±{r['mafwr']['std']*100:.1f}"
              f"{r['mafnet']['mean']:>+8.2f}±{r['mafnet']['std']:>4.2f}".rstrip()
              + f"  {r['twnnet']['mean']:>+5.2f}±{r['twnnet']['std']:>4.2f}"
              f"  {r['spear']['mean']:>5.3f}")
    print()
    # Recommend the closest to 52%
    target = 0.52
    best = min(summary_rows, key=lambda r: abs(r["mafwr"]["mean"] - target))
    print(f"Closest to 52% target: {best['label']}  "
          f"(MafWR={best['mafwr']['mean']:.1%}, MafNet={best['mafnet']['mean']:+.2f})")


if __name__ == "__main__":
    main()
