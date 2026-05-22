#!/usr/bin/env python
"""One-sample test: is the observed mafia winrate significantly different from
the 56% design target?

Pulls per-game outcomes from `Elo Mafia Rankings.xlsx` (MatchHistory =
current season, Season 1 - MatchHistory = prior season), collapses the
per-player rows to a single winner per GameID, then runs a two-sided exact
binomial test of the observed mafia-win proportion against p0 = 0.56.

Reports for each cohort:
- observed wins/games and proportion
- Wilson 95% confidence interval for the true winrate
- exact (Clopper-style) binomial p-value vs 0.56
- normal-approx z statistic and p-value
- verdict at alpha = 0.05
"""

import pandas as pd
from scipy import stats

XLSX = "Elo Mafia Rankings.xlsx"
TARGET = 0.56
ALPHA = 0.05


def mafia_outcomes(sheet):
    """Return (wins, games) of mafia from a MatchHistory-style sheet."""
    mh = pd.read_excel(XLSX, sheet_name=sheet)
    per_game = mh.groupby("GameID").apply(
        lambda s: (s.loc[s["Alignment"] == "Mafia", "Result"] == "Win").any(),
        include_groups=False,
    )
    return int(per_game.sum()), len(per_game)


def wilson_ci(wins, n, alpha=ALPHA):
    z = stats.norm.ppf(1 - alpha / 2)
    p = wins / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = (z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5)) / denom
    return center - half, center + half


def analyze(label, wins, n):
    p = wins / n
    lo, hi = wilson_ci(wins, n)

    binom = stats.binomtest(wins, n, p=TARGET, alternative="two-sided")

    se0 = (TARGET * (1 - TARGET) / n) ** 0.5
    z = (p - TARGET) / se0
    z_p = 2 * (1 - stats.norm.cdf(abs(z)))

    reject = binom.pvalue < ALPHA
    print(f"\n{'=' * 72}")
    print(label)
    print("=" * 72)
    print(f"  observed       : {wins}/{n} mafia wins = {p:.4f} ({p:.1%})")
    print(f"  target (H0)    : {TARGET:.1%}")
    print(f"  difference     : {p - TARGET:+.4f} ({p - TARGET:+.1%})")
    print(f"  Wilson 95% CI  : [{lo:.4f}, {hi:.4f}]  ([{lo:.1%}, {hi:.1%}])")
    print(f"  target in CI?  : {'yes' if lo <= TARGET <= hi else 'NO'}")
    print(f"  exact binomial : p = {binom.pvalue:.4f}")
    print(f"  normal z-test  : z = {z:+.3f},  p = {z_p:.4f}")
    verdict = (
        "REJECT H0 — significantly different from 56%"
        if reject else
        "FAIL TO REJECT H0 — not distinguishable from 56% at this sample size"
    )
    print(f"  verdict @ a={ALPHA}: {verdict}")


def main():
    w1, n1 = mafia_outcomes("Season 1 - MatchHistory")
    w2, n2 = mafia_outcomes("MatchHistory")
    analyze("Current season (GameID 46-162) — primary", w2, n2)
    analyze("All-time pooled (Season 1 + current)", w1 + w2, n1 + n2)
    analyze("Season 1 only (GameID 1-45) — reference", w1, n1)


if __name__ == "__main__":
    main()
