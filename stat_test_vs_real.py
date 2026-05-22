#!/usr/bin/env python
"""Statistical test: is real-world mafia winrate (60/117 = 51.3%) consistent
with what the model predicts under OLD vs NEW ghost-mu configurations?

Setup:
- 86-player pool, hidden true skill ~ N(25, 25/3)
- Per-game roster: 3 mafia + 10 town drawn without replacement, weighted by
  the empirical `Total Games` distribution from Elo Mafia Rankings.xlsx
- Winner sampled from the configured TrueSkill ghost-padded win probability
- 1000 independent 117-game seasons per config

For each config we compute:
- Sim distribution of mafia winrate (mean, std, percentiles)
- Where 50% real sits in that distribution
- Empirical two-tailed p-value (Monte Carlo)
- Z-test approximation against sim distribution
- One-sample binomial test (54 of 108) against the sim's mean probability
"""

import itertools
import math
import random
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy import stats
from trueskill import Rating, TrueSkill

XLSX = "Elo Mafia Rankings.xlsx"

ROSTER_SIZE = 13       # real data uses 3 mafia + 10 town, no N0
NUM_MAFIA = 3
NUM_TOWN = 10
NUM_GAMES = 117        # exactly match real-data game count (current season)
NUM_RUNS = 1000
SEED = 42

PRIOR_MU = 25.0
PRIOR_SIGMA = 25.0 / 3.0
TRUE_SKILL_MEAN = 25.0
TRUE_SKILL_STD = 25.0 / 3.0

REAL_MAFIA_WINS = 60
REAL_MAFIA_WINRATE = REAL_MAFIA_WINS / NUM_GAMES  # 0.513


@dataclass
class Config:
    label: str
    env: TrueSkill
    mafia_ghost_mu: float
    mafia_ghost_sigma: float
    town_ghost_mu: float
    town_ghost_sigma: float


CONFIGS = [
    Config(
        label="OLD (gap 1.85, β=5.5)",
        env=TrueSkill(tau=0.1, beta=5.5, draw_probability=0.0),
        mafia_ghost_mu=25.7, mafia_ghost_sigma=0.8,
        town_ghost_mu=23.85, town_ghost_sigma=0.8,
    ),
    Config(
        label="NEW (gap 1.00, β=5.0)",
        env=TrueSkill(tau=0.1, beta=5.0, draw_probability=0.0),
        mafia_ghost_mu=25.275, mafia_ghost_sigma=0.8,
        town_ghost_mu=24.275, town_ghost_sigma=0.8,
    ),
]


@dataclass
class Player:
    name: str
    true_mu: float
    weight: float
    mu: float = PRIOR_MU
    sigma: float = PRIOR_SIGMA


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
    for p in mafia:
        new = rated[0][p.name]
        p.mu, p.sigma = new.mu, new.sigma
    for p in town:
        new = rated[1][p.name]
        p.mu, p.sigma = new.mu, new.sigma


def run_one_season(seed, weights, cfg):
    """Run one 108-game season under cfg. Returns mafia win count."""
    rng = random.Random(seed)
    np_rng = np.random.default_rng(seed)
    n = len(weights)
    true_skills = np_rng.normal(TRUE_SKILL_MEAN, TRUE_SKILL_STD, n).clip(min=1.0)
    players = [
        Player(name=f"P{i+1:03d}", true_mu=float(true_skills[i]),
               weight=float(weights[i]))
        for i in range(n)
    ]
    mafia_wins = 0
    for _ in range(NUM_GAMES):
        roster = weighted_sample(players, ROSTER_SIZE, rng)
        rng.shuffle(roster)
        mafia = roster[:NUM_MAFIA]
        town = roster[NUM_MAFIA:NUM_MAFIA + NUM_TOWN]
        mafia_won = sample_mafia_win(mafia, town, cfg, rng)
        rate_game(mafia, town, mafia_won, cfg)
        if mafia_won:
            mafia_wins += 1
    return mafia_wins


def analyze(label, sim_wins, cfg):
    sim_wr = sim_wins / NUM_GAMES
    mean = sim_wr.mean()
    std = sim_wr.std(ddof=1)
    z = (REAL_MAFIA_WINRATE - mean) / (std if std > 0 else 1e-9)
    z_pval = 2 * (1 - stats.norm.cdf(abs(z)))

    diff = abs(sim_wr - mean)
    obs_diff = abs(REAL_MAFIA_WINRATE - mean)
    mc_p_two_tail = float((diff >= obs_diff).mean())
    mc_p_one_tail = float((sim_wr <= REAL_MAFIA_WINRATE).mean())

    # One-sample binomial test against sim mean probability
    binom = stats.binomtest(REAL_MAFIA_WINS, NUM_GAMES, p=mean,
                            alternative="two-sided")

    pcts = np.percentile(sim_wr, [2.5, 10, 25, 50, 75, 90, 97.5])

    print(f"\n{'=' * 88}")
    print(f"{label}")
    print('=' * 88)
    print(f"Sim distribution of MafWR over {NUM_RUNS} {NUM_GAMES}-game seasons:")
    print(f"  mean     = {mean:.4f}  ({mean * NUM_GAMES:.1f} wins out of {NUM_GAMES})")
    print(f"  std      = {std:.4f}")
    print(f"  min/max  = {sim_wr.min():.4f} / {sim_wr.max():.4f}")
    print(f"  p2.5/p97.5 (empirical 95% band) = "
          f"{pcts[0]:.4f} / {pcts[6]:.4f}")
    print(f"  p10/p25/p50/p75/p90 = {pcts[1]:.4f} / {pcts[2]:.4f} / "
          f"{pcts[3]:.4f} / {pcts[4]:.4f} / {pcts[5]:.4f}")
    print(f"\nReal observed: MafWR = {REAL_MAFIA_WINRATE:.4f} "
          f"({REAL_MAFIA_WINS}/{NUM_GAMES})")
    print(f"  Deviation from sim mean: {REAL_MAFIA_WINRATE - mean:+.4f} "
          f"(z = {z:.2f})")
    print(f"  Empirical percentile of real in sim distribution: "
          f"{(sim_wr < REAL_MAFIA_WINRATE).mean() * 100:.0f}th "
          f"(ties count as below)")
    print(f"\nStatistical tests of H0 (real drawn from this model):")
    print(f"  Z-test two-tailed p-value:           {z_pval:.4f}")
    print(f"  Monte-Carlo two-tailed p-value:      {mc_p_two_tail:.4f}  "
          f"(fraction of sims at least as extreme as real)")
    print(f"  Monte-Carlo one-tailed p-value:      {mc_p_one_tail:.4f}  "
          f"(fraction of sims with MafWR ≤ {REAL_MAFIA_WINRATE:.0%})")
    print(f"  Binomial test ({REAL_MAFIA_WINS}/{NUM_GAMES} vs p={mean:.4f}): "
          f"p-value = {binom.pvalue:.4f}  "
          f"[note: not strictly correct — see MC p-value]")
    sig = ("REJECT H0 — real data is inconsistent with this model"
           if z_pval < 0.05 else
           "FAIL TO REJECT H0 — real data is consistent with this model")
    print(f"\n  Verdict @ α=0.05: {sig}")
    return {
        "mean": mean, "std": std, "z": z, "z_pval": z_pval,
        "mc_two": mc_p_two_tail, "mc_one": mc_p_one_tail,
        "binom": binom.pvalue,
    }


def real_anchor():
    """Recompute (mafia_wins, games) from the current MatchHistory sheet."""
    mh = pd.read_excel(XLSX, sheet_name="MatchHistory")
    per_game = mh.groupby("GameID").apply(
        lambda s: (s.loc[s["Alignment"] == "Mafia", "Result"] == "Win").any(),
        include_groups=False,
    )
    return int(per_game.sum()), len(per_game)


def main():
    live_wins, live_games = real_anchor()
    if (live_wins, live_games) != (REAL_MAFIA_WINS, NUM_GAMES):
        print(f"WARNING: hardcoded anchor ({REAL_MAFIA_WINS}/{NUM_GAMES}) "
              f"!= current MatchHistory ({live_wins}/{live_games}). "
              f"Update REAL_MAFIA_WINS / NUM_GAMES.")

    ss = pd.read_excel(XLSX, sheet_name="Stats Summary")
    weights = ss["Total Games"].dropna().to_numpy(dtype=float)
    print(f"Pool: {len(weights)} players, true skill ~ N({TRUE_SKILL_MEAN}, "
          f"{TRUE_SKILL_STD:.3f})")
    print(f"Participation: real `Total Games` (max={weights.max():.0f}, "
          f"mean={weights.mean():.1f})")
    print(f"Real anchor: {REAL_MAFIA_WINS} mafia wins out of {NUM_GAMES} games "
          f"({REAL_MAFIA_WINRATE:.1%})")

    results = {}
    for cfg in CONFIGS:
        wins = np.array([
            run_one_season(SEED + i, weights, cfg) for i in range(NUM_RUNS)
        ])
        results[cfg.label] = analyze(cfg.label, wins, cfg)

    print("\n" + "=" * 88)
    print("SUMMARY")
    print("=" * 88)
    print(f"{'Config':<28}{'sim mean':>10}{'std':>8}"
          f"{'z':>7}{'z p-val':>10}{'MC 2-tail':>12}{'binom p':>10}")
    print("-" * 88)
    for label, r in results.items():
        print(f"{label:<28}"
              f"{r['mean']:>9.3%} {r['std']:>7.3%} "
              f"{r['z']:>+6.2f}  {r['z_pval']:>8.4f}  {r['mc_two']:>10.4f}  "
              f"{r['binom']:>8.4f}")


if __name__ == "__main__":
    main()
