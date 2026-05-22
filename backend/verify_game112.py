#!/usr/bin/env python3
"""Verify TrueSkill computation for game 112.

Runs the same game through both the backend logic and the experimental
script logic, then compares results side-by-side.

Usage: python verify_game112.py
"""

import math
import sys

import trueskill
from trueskill import TrueSkill, Rating

# --- Game 112 data (Badpants duplicate version matching other guy's input) ---

MAFIA_GHOST_MU = 25.7
MAFIA_GHOST_SIGMA = 0.8
TOWN_GHOST_MU = 23.85
TOWN_GHOST_SIGMA = 0.8

MAFIA = [
    ('Gilbert', 25.28132346, 7.967583107),
    ('Chelsea', 23.44581122, 8.261381908),
    ('Levi',    28.359012,   8.160009601),
]

TOWN = [
    ('Lou',      28.46331273, 6.948603064),
    ('Iln',      26.74797461, 7.03398742),
    ('Smit',     26.51067108, 6.988280247),
    ('Vandy',    24.14087881, 8.277903013),
    ('Badpants', 22.79063084, 6.896114437),
    ('Cj',       26.87207341, 7.88936576),
    ('Carson',   31.76576843, 6.852501804),
    ('Ken',      23.44581122, 8.261381908),
    ('Rocker',   31.47144884, 6.669366647),
    ('Badpants', 22.79063084, 6.896114437),  # duplicate
]

MAFIA_WON = False

# --- Expected values from the other guy ---

EXPECTED = {
    'Gilbert':  (23.71361878, 7.898390305),
    'Chelsea':  (21.76052567, 8.183383278),
    'Levi':     (26.71477758, 8.085118772),
    'Lou':      (29.65620044, 6.90545831),
    'Iln':      (27.97030394, 6.988911384),
    'Smit':     (27.71719527, 6.944243466),
    'Vandy':    (25.83290268, 8.199390857),
    'Badpants': (23.96559826, 6.854135398),
    'Cj':       (28.40919239, 7.822415029),
    'Carson':   (32.92594929, 6.811479029),
    'Ken':      (25.13109676, 8.183383278),
    'Rocker':   (32.57056303, 6.632239224),
}


def display_rating(mu, sigma):
    return round((mu - 1.5 * sigma) * 68)


def _build_teams(env, mafia_data, town_data, ghost_count=None):
    """Build mafia and town dicts for TrueSkill rate() call."""
    mafia_players = [{'name': n, 'mu': m, 'sigma': s} for n, m, s in mafia_data]
    town_players = [{'name': n, 'mu': m, 'sigma': s} for n, m, s in town_data]
    n_mafia = len(mafia_players)
    n_town = len(town_players)
    n_ghosts = ghost_count if ghost_count is not None else n_town

    mafia_dict = {}
    mu_geo = 1.0
    sigma_geo = 1.0
    for p in mafia_players:
        mafia_dict[p['name']] = Rating(p['mu'], p['sigma'])
        mu_geo *= p['mu']
        sigma_geo *= p['sigma']

    mu_avg = mu_geo ** (1 / n_mafia)
    sigma_avg = sigma_geo ** (1 / n_mafia)
    for i in range(n_town - n_mafia):
        mafia_dict[f'_mafia_avg{i}'] = Rating(mu_avg, sigma_avg)
    for i in range(n_ghosts):
        mafia_dict[f'_mafia_ghost{i}'] = Rating(MAFIA_GHOST_MU, MAFIA_GHOST_SIGMA)

    town_dict = {}
    for p in town_players:
        town_dict[p['name']] = Rating(p['mu'], p['sigma'])
    for i in range(n_ghosts):
        town_dict[f'_town_ghost{i}'] = Rating(TOWN_GHOST_MU, TOWN_GHOST_SIGMA)

    return mafia_dict, town_dict


def method_no_dedup():
    """Same as backend but avoid dict dedup by renaming duplicate."""
    env = TrueSkill(tau=0.1, beta=5.5, draw_probability=0.00)

    # Rename second Badpants so dict doesn't overwrite
    town_no_dedup = list(TOWN)
    seen = set()
    for i, (n, m, s) in enumerate(town_no_dedup):
        if n in seen:
            town_no_dedup[i] = (f'{n}_2', m, s)
        seen.add(n)

    mafia_players = [{'name': n, 'mu': m, 'sigma': s} for n, m, s in MAFIA]
    town_players = [{'name': n, 'mu': m, 'sigma': s} for n, m, s in town_no_dedup]
    n_mafia = len(mafia_players)
    n_town = len(town_players)

    mafia_dict = {}
    mu_geo = 1.0
    sigma_geo = 1.0
    for p in mafia_players:
        mafia_dict[p['name']] = Rating(p['mu'], p['sigma'])
        mu_geo *= p['mu']
        sigma_geo *= p['sigma']

    mu_avg = mu_geo ** (1 / n_mafia)
    sigma_avg = sigma_geo ** (1 / n_mafia)
    for i in range(n_town - n_mafia):
        mafia_dict[f'_mafia_avg{i}'] = Rating(mu_avg, sigma_avg)
    for i in range(n_town):
        mafia_dict[f'_mafia_ghost{i}'] = Rating(MAFIA_GHOST_MU, MAFIA_GHOST_SIGMA)

    town_dict = {}
    for p in town_players:
        town_dict[p['name']] = Rating(p['mu'], p['sigma'])
    for i in range(n_town):
        town_dict[f'_town_ghost{i}'] = Rating(TOWN_GHOST_MU, TOWN_GHOST_SIGMA)

    ranks = [0, 1] if MAFIA_WON else [1, 0]
    rated = env.rate([mafia_dict, town_dict], ranks=ranks)

    result = {}
    for p in mafia_players:
        r = rated[0][p['name']]
        result[p['name']] = (r.mu, r.sigma)
    for p in town_players:
        name = p['name'].replace('_2', '')  # map back to original name
        r = rated[1][p['name']]
        result[name] = (r.mu, r.sigma)
    return result


def method_backend():
    """Backend logic (backend/main.py compute_trueskill)."""
    env = TrueSkill(tau=0.1, beta=5.5, draw_probability=0.00)

    mafia_players = [{'name': n, 'mu': m, 'sigma': s} for n, m, s in MAFIA]
    town_players = [{'name': n, 'mu': m, 'sigma': s} for n, m, s in TOWN]
    n_mafia = len(mafia_players)
    n_town = len(town_players)

    mafia_dict = {}
    mu_geo = 1.0
    sigma_geo = 1.0
    for p in mafia_players:
        mafia_dict[p['name']] = Rating(p['mu'], p['sigma'])
        mu_geo *= p['mu']
        sigma_geo *= p['sigma']

    mu_avg = mu_geo ** (1 / n_mafia)
    sigma_avg = sigma_geo ** (1 / n_mafia)
    for i in range(n_town - n_mafia):
        mafia_dict[f'_mafia_avg{i}'] = Rating(mu_avg, sigma_avg)
    for i in range(n_town):
        mafia_dict[f'_mafia_ghost{i}'] = Rating(MAFIA_GHOST_MU, MAFIA_GHOST_SIGMA)

    town_dict = {}
    for p in town_players:
        town_dict[p['name']] = Rating(p['mu'], p['sigma'])
    for i in range(n_town):
        town_dict[f'_town_ghost{i}'] = Rating(TOWN_GHOST_MU, TOWN_GHOST_SIGMA)

    ranks = [0, 1] if MAFIA_WON else [1, 0]
    rated = env.rate([mafia_dict, town_dict], ranks=ranks)

    result = {}
    for p in mafia_players:
        r = rated[0][p['name']]
        result[p['name']] = (r.mu, r.sigma)
    for p in town_players:
        r = rated[1][p['name']]
        result[p['name']] = (r.mu, r.sigma)
    return result


def method_experimental():
    """Experimental script logic (Mafia_Rating_Experimental.py rate_game)."""
    env = TrueSkill(tau=0.1, beta=5.5, draw_probability=0.00)
    env.make_as_global()

    town_players = [n for n, _, _ in TOWN]
    mafia_players = [n for n, _, _ in MAFIA]
    ratings_lookup = {}
    for n, m, s in MAFIA + TOWN:
        ratings_lookup[n] = (m, s)

    mafia_dict = {}
    town_dict = {}

    # Town first (matches experimental script order)
    for player in town_players:
        mu, sigma = ratings_lookup[player]
        town_dict[player] = Rating(mu, sigma)

    for i in range(len(town_players)):
        town_dict[f'town_ghost{i}'] = Rating(TOWN_GHOST_MU, TOWN_GHOST_SIGMA)

    # Then mafia
    mafia_mu_geo_total = 1.0
    mafia_sigma_geo_total = 1.0
    for player in mafia_players:
        mu, sigma = ratings_lookup[player]
        mafia_mu_geo_total *= mu
        mafia_sigma_geo_total *= sigma
        mafia_dict[player] = Rating(mu, sigma)

    mafia_mu_avg = math.pow(mafia_mu_geo_total, (1 / len(mafia_players)))
    mafia_sigma_avg = math.pow(mafia_sigma_geo_total, (1 / len(mafia_players)))

    for i in range(len(town_players) - len(mafia_dict)):
        mafia_dict[f'mafia_avg{i}'] = Rating(mafia_mu_avg, mafia_sigma_avg)

    for i in range(len(town_players)):
        mafia_dict[f'mafia_ghost{i}'] = Rating(MAFIA_GHOST_MU, MAFIA_GHOST_SIGMA)

    rating_groups = [mafia_dict, town_dict]
    if MAFIA_WON:
        rated = env.rate(rating_groups, ranks=[0, 1])
    else:
        rated = env.rate(rating_groups, ranks=[1, 0])

    result = {}
    for player in mafia_players:
        r = rated[0][player]
        result[player] = (r.mu, r.sigma)
    for player in town_players:
        r = rated[1][player]
        result[player] = (r.mu, r.sigma)
    return result


def print_results(label, results):
    print(f'\n--- {label} ---')
    print(f'{"Player":<12} {"new_mu":>14} {"new_sigma":>14} {"rating":>8}')
    for name, _, _ in MAFIA + TOWN:
        if name in results:
            mu, sigma = results[name]
            print(f'{name:<12} {mu:>14.8f} {sigma:>14.9f} {display_rating(mu, sigma):>8}')


def print_comparison(backend, experimental, expected):
    print('\n--- Comparison (backend vs experimental vs expected) ---')
    print(f'{"Player":<12} {"back_mu":>14} {"exp_mu":>14} {"expect_mu":>14} {"back==exp":>10} {"exp==expect":>12}')
    seen = set()
    for name, _, _ in MAFIA + TOWN:
        if name in seen:
            continue
        seen.add(name)
        b_mu, b_sig = backend.get(name, (0, 0))
        e_mu, e_sig = experimental.get(name, (0, 0))
        x_mu, x_sig = expected.get(name, (0, 0))
        back_exp = 'YES' if abs(b_mu - e_mu) < 1e-10 else f'diff={b_mu - e_mu:+.8f}'
        exp_expect = 'YES' if abs(e_mu - x_mu) < 1e-10 else f'diff={e_mu - x_mu:+.8f}'
        print(f'{name:<12} {b_mu:>14.8f} {e_mu:>14.8f} {x_mu:>14.8f} {back_exp:>10} {exp_expect:>12}')


if __name__ == '__main__':
    print(f'Python:    {sys.version}')
    print(f'trueskill: {trueskill.__version__}')
    try:
        import scipy
        print(f'scipy:     {scipy.__version__}')
    except ImportError:
        print('scipy:     NOT INSTALLED')
    try:
        import mpmath
        print(f'mpmath:    {mpmath.__version__}')
    except ImportError:
        print('mpmath:    NOT INSTALLED')

    try:
        backends = trueskill.available_backends()
        print(f'backends:  {backends}')
    except AttributeError:
        print('backends:  (function not available in this version)')

    print(f'\nTeam sizes:')
    print(f'  mafia_players list: {len(MAFIA)}')
    print(f'  town_players list:  {len(TOWN)}')
    print(f'  town unique names:  {len(set(n for n, _, _ in TOWN))}')
    print(f'  mafia dict entries: {len(MAFIA)} real + {len(TOWN) - len(MAFIA)} fillers + {len(TOWN)} ghosts = {len(MAFIA) + (len(TOWN) - len(MAFIA)) + len(TOWN)}')
    print(f'  town dict entries:  {len(set(n for n, _, _ in TOWN))} real + {len(TOWN)} ghosts = {len(set(n for n, _, _ in TOWN)) + len(TOWN)}')

    backend_results = method_backend()
    no_dedup_results = method_no_dedup()

    # Test with forced backends
    print_results('Backend logic (dedup, 20v19)', backend_results)
    print_results('No dedup (20v20)', no_dedup_results)

    # Try varying beta to find what matches expected
    print('\n--- Parameter sweep (Gilbert new_mu, expected=23.71361878) ---')
    target_mu = 23.71361878
    for beta in [4.167, 5.0, 5.5, 5.8, 5.9, 5.95, 5.98, 5.99, 6.0, 6.01, 6.02, 6.05, 6.1, 6.5, 25/6, 25/3/2]:
        env = TrueSkill(tau=0.1, beta=beta, draw_probability=0.00)
        md, td = _build_teams(env, MAFIA, TOWN)
        ranks = [0, 1] if MAFIA_WON else [1, 0]
        rated = env.rate([md, td], ranks=ranks)
        r = rated[0]['Gilbert']
        diff = r.mu - target_mu
        marker = ' <-- MATCH' if abs(diff) < 0.001 else ''
        print(f'  beta={beta:<6} Gilbert={r.mu:.8f} diff={diff:+.8f}{marker}')

    # Try varying tau
    for tau in [0.0, 0.05, 0.1, 0.2, 0.5, 25/300]:
        env = TrueSkill(tau=tau, beta=5.5, draw_probability=0.00)
        md, td = _build_teams(env, MAFIA, TOWN)
        ranks = [0, 1] if MAFIA_WON else [1, 0]
        rated = env.rate([md, td], ranks=ranks)
        r = rated[0]['Gilbert']
        diff = r.mu - target_mu
        marker = ' <-- MATCH' if abs(diff) < 0.001 else ''
        print(f'  tau={tau:<8.4f} Gilbert={r.mu:.8f} diff={diff:+.8f}{marker}')

    # Try varying ghost counts
    print('\n--- Ghost count sweep ---')
    for n_ghosts in [8, 9, 10, 11, 12, 13, 15]:
        env = TrueSkill(tau=0.1, beta=5.5, draw_probability=0.00)
        md, td = _build_teams(env, MAFIA, TOWN, ghost_count=n_ghosts)
        ranks = [0, 1] if MAFIA_WON else [1, 0]
        rated = env.rate([md, td], ranks=ranks)
        r = rated[0]['Gilbert']
        diff = r.mu - target_mu
        marker = ' <-- MATCH' if abs(diff) < 0.001 else ''
        print(f'  ghosts={n_ghosts:<3} Gilbert={r.mu:.8f} diff={diff:+.8f}{marker}')

    print_comparison(backend_results, no_dedup_results, EXPECTED)
