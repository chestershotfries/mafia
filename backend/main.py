"""Mafia TrueSkill backend — Google Cloud Function replacement for Code.gs.

Deploy as HTTP Cloud Function (gen2). Authenticates to Google Sheets via
service account. Uses the trueskill library with ghost-padded teams to
produce ratings identical to the existing Python analysis script.
"""

import json
import math
import os

import functions_framework
import gspread
from google.oauth2.service_account import Credentials
from trueskill import TrueSkill, Rating

# --- Constants ---

SHEET_ID = '1vTc6XAa4beDM4n1syQ22Hs10JGVT9PuHNSoTmY051CQ'
TRUESKILL_MU = 25
TRUESKILL_SIGMA = 25 / 3

MAFIA_GHOST_MU = 25.7
MAFIA_GHOST_SIGMA = 0.8
TOWN_GHOST_MU = 23.85
TOWN_GHOST_SIGMA = 0.8

POSITION_ROLES = {
    1: 'Mafia', 2: 'Mafia', 3: 'Mafia',
    4: 'Cop', 5: 'Medic', 6: 'Vigilante',
}

env = TrueSkill(tau=0.1, beta=5.5, draw_probability=0.00)

SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

# --- Auth ---

_gc = None


def get_gc():
    global _gc
    if _gc is not None:
        return _gc
    key_json = os.environ.get('SERVICE_ACCOUNT_KEY')
    if key_json:
        info = json.loads(key_json)
        creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    else:
        key_file = os.environ.get('SERVICE_ACCOUNT_KEY_FILE', 'service-account.json')
        creds = Credentials.from_service_account_file(key_file, scopes=SCOPES)
    _gc = gspread.authorize(creds)
    return _gc


def get_sheet():
    return get_gc().open_by_key(SHEET_ID)


# --- Rating helpers ---

def display_rating(mu, sigma):
    return round((mu - 1.5 * sigma) * 68)


def compute_trueskill(mafia_players, town_players, mafia_won):
    """Run TrueSkill with ghost-padded teams.

    Each player dict has keys: name, mu, sigma.
    Returns dict keyed by real player name with {mu, sigma}.
    """
    n_mafia = len(mafia_players)
    n_town = len(town_players)

    # Build mafia team: real players + avg fillers + ghosts
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

    # Build town team: real players + ghosts
    town_dict = {}
    for p in town_players:
        town_dict[p['name']] = Rating(p['mu'], p['sigma'])
    for i in range(n_town):
        town_dict[f'_town_ghost{i}'] = Rating(TOWN_GHOST_MU, TOWN_GHOST_SIGMA)

    # Rate
    ranks = [0, 1] if mafia_won else [1, 0]
    rated = env.rate([mafia_dict, town_dict], ranks=ranks)

    # Extract real player results only
    result = {}
    for p in mafia_players:
        r = rated[0][p['name']]
        result[p['name']] = {'mu': r.mu, 'sigma': r.sigma}
    for p in town_players:
        r = rated[1][p['name']]
        result[p['name']] = {'mu': r.mu, 'sigma': r.sigma}
    return result


# --- Sheet operations ---

def sort_stats_summary(ss):
    """Sort the Stats Summary sheet by Rating (column 12) descending."""
    try:
        ws = ss.worksheet('Stats Summary')
    except gspread.exceptions.WorksheetNotFound:
        return
    last_row = len(ws.get_all_values())
    if last_row > 1:
        ws.sort((12, 'des'), range=f'A2:L{last_row}')


def parse_pct(val):
    """Parse '65%' or '0.65' or '65' into a float 0-100."""
    if not val:
        return 0.0
    s = str(val).strip().rstrip('%')
    try:
        f = float(s)
        return round(f if f > 1 else f * 100, 1)
    except ValueError:
        return 0.0


def get_players():
    ss = get_sheet()
    ws = ss.worksheet('MatchRatings')
    data = ws.get_all_values()
    players = []
    for row in data[1:]:
        name = row[0]
        if not name:
            continue
        try:
            mu = float(row[1])
            sigma = float(row[2])
        except (ValueError, IndexError):
            continue
        rating = display_rating(mu, sigma)
        players.append({'name': name, 'mu': mu, 'sigma': sigma, 'rating': rating})
    return {'players': players}


def get_last_game():
    ss = get_sheet()
    ws = ss.worksheet('MatchHistory')
    data = ws.get_all_values()
    if len(data) < 2 or not data[1][0]:
        return {'game': None}

    game_id = data[1][0]
    players = []
    for row in data[1:]:
        if row[0] != game_id:
            break
        entry = {
            'game_id': int(float(game_id)),
            'player': row[1],
            'alignment': row[2],
            'result': row[3],
            'rate_change': int(float(row[4])) if row[4] else 0,
        }
        # Only include rating data for rated players
        if row[5]:
            entry.update({
                'old_mu': float(row[5]),
                'new_mu': float(row[6]),
                'new_sigma': float(row[7]),
                'old_rating': int(float(row[8])),
                'new_rating': int(float(row[9])),
                'old_sigma': float(row[10]),
            })
        players.append(entry)
    return {'game': {'game_id': int(float(game_id)), 'players': players}}


def record_game(body):
    assignments = body['assignments']
    winner = body['winner']
    night0_kills = body.get('night0_kills', [])
    mafia_won = winner == 'Mafia'

    # Filter for rating: exclude ghosts and N0 kills
    rated = [a for a in assignments
             if not a.get('is_ghost') and a['name'] not in night0_kills]

    ss = get_sheet()
    ws_ratings = ss.worksheet('MatchRatings')
    ws_history = ss.worksheet('MatchHistory')

    # Build current ratings lookup
    ratings_data = ws_ratings.get_all_values()
    current_ratings = {}
    for i, row in enumerate(ratings_data[1:], start=2):
        name = row[0]
        if not name:
            continue
        try:
            mu = float(row[1])
            sigma = float(row[2])
        except (ValueError, IndexError):
            continue
        current_ratings[name] = {
            'mu': mu,
            'sigma': sigma,
            'row': i,
        }

    # Build team player lists
    mafia_players = []
    town_players = []
    for a in rated:
        cr = current_ratings.get(a['name'])
        player = {
            'name': a['name'],
            'mu': cr['mu'] if cr else TRUESKILL_MU,
            'sigma': cr['sigma'] if cr else TRUESKILL_SIGMA,
        }
        if a['role'] == 'Mafia':
            mafia_players.append(player)
        else:
            town_players.append(player)

    # Compute new ratings
    new_ratings = compute_trueskill(mafia_players, town_players, mafia_won)

    # Determine next GameID
    history_data = ws_history.get_all_values()
    current_game_id = history_data[1][0] if len(history_data) > 1 and history_data[1][0] else None
    next_game_id = int(float(current_game_id)) + 1 if current_game_id else 46

    # Build all 15 rows for MatchHistory (in position order)
    rated_names = {a['name'] for a in rated}
    history_rows = []
    result_players = []

    for a in sorted(assignments, key=lambda x: x['position']):
        name = a['name']
        alignment = a['role']
        is_ghost = a.get('is_ghost', False)
        is_n0 = name in night0_kills

        if is_ghost:
            history_rows.append([
                next_game_id, name, alignment, 'Ghost', 0,
                '', '', '', '', '', '',
            ])
            result_players.append({
                'name': name, 'alignment': alignment, 'result': 'Ghost',
                'rate_change': 0,
            })
        elif is_n0:
            history_rows.append([
                next_game_id, name, alignment, 'Night Zero', 0,
                '', '', '', '', '', '',
            ])
            result_players.append({
                'name': name, 'alignment': alignment, 'result': 'Night Zero',
                'rate_change': 0,
            })
        else:
            cr = current_ratings.get(name)
            old_mu = cr['mu'] if cr else TRUESKILL_MU
            old_sigma = cr['sigma'] if cr else TRUESKILL_SIGMA
            nr = new_ratings[name]
            new_mu = nr['mu']
            new_sigma = nr['sigma']
            old_rating = display_rating(old_mu, old_sigma)
            new_rating = display_rating(new_mu, new_sigma)
            rate_change = new_rating - old_rating
            result_str = ('Win' if alignment == 'Mafia' else 'Loss') if mafia_won \
                else ('Loss' if alignment == 'Mafia' else 'Win')

            history_rows.append([
                next_game_id, name, alignment, result_str, rate_change,
                old_mu, new_mu, new_sigma, old_rating, new_rating, old_sigma,
            ])
            result_players.append({
                'name': name, 'alignment': alignment, 'result': result_str,
                'old_rating': old_rating, 'new_rating': new_rating,
                'rate_change': rate_change,
                'old_mu': old_mu, 'new_mu': new_mu,
                'old_sigma': old_sigma, 'new_sigma': new_sigma,
            })

    # Insert rows at row 2 of MatchHistory (newest first)
    ws_history.insert_rows(history_rows, row=2)

    # Update MatchRatings
    for a in rated:
        name = a['name']
        nr = new_ratings[name]
        cr = current_ratings.get(name)
        if cr:
            ws_ratings.update(f'B{cr["row"]}:C{cr["row"]}', [[nr['mu'], nr['sigma']]])
        else:
            next_row = len(ratings_data) + 1
            ws_ratings.update(f'A{next_row}:C{next_row}', [[name, nr['mu'], nr['sigma']]])
            ratings_data.append([name, nr['mu'], nr['sigma']])
            current_ratings[name] = {'mu': nr['mu'], 'sigma': nr['sigma'], 'row': next_row}

    # Sort Stats Summary
    sort_stats_summary(ss)

    return {
        'game_id': next_game_id,
        'players': result_players,
        'excluded': {
            'ghosts': [a['name'] for a in assignments if a.get('is_ghost')],
            'night0_kills': night0_kills,
        },
    }


def undo_last_game():
    ss = get_sheet()
    ws_history = ss.worksheet('MatchHistory')
    history_data = ws_history.get_all_values()

    if len(history_data) < 2 or not history_data[1][0]:
        raise ValueError('No games to undo')

    game_id = history_data[1][0]

    # Collect all rows for this game and rated players to restore
    game_row_count = 0
    players_to_restore = []
    for row in history_data[1:]:
        if row[0] != game_id:
            break
        game_row_count += 1
        # Only restore rated players (those with old_mu data)
        if row[5]:
            players_to_restore.append({
                'name': row[1],
                'old_mu': float(row[5]),
                'old_sigma': float(row[10]),
            })

    # Restore ratings in MatchRatings
    ws_ratings = ss.worksheet('MatchRatings')
    ratings_data = ws_ratings.get_all_values()
    ratings_lookup = {}
    for i, row in enumerate(ratings_data[1:], start=2):
        if row[0]:
            ratings_lookup[row[0]] = i

    restored = []
    for p in players_to_restore:
        row_num = ratings_lookup.get(p['name'])
        if row_num:
            ws_ratings.update(f'B{row_num}:C{row_num}', [[p['old_mu'], p['old_sigma']]])
            restored.append(p['name'])

    # Delete game rows from MatchHistory
    ws_history.delete_rows(2, 2 + game_row_count - 1)

    # Sort Stats Summary
    sort_stats_summary(ss)

    return {
        'undone_game_id': int(float(game_id)),
        'players_restored': restored,
    }


def get_stats():
    ss = get_sheet()

    ws_stats = ss.worksheet('Stats Summary')
    stats_data = ws_stats.get_all_values()
    players = []
    for row in stats_data[1:]:
        if not row[0]:
            continue
        players.append({
            'name': row[0],
            'town_games': int(float(row[1])) if row[1] else 0,
            'town_wins': int(float(row[2])) if row[2] else 0,
            'town_win_pct': parse_pct(row[3]),
            'mafia_games': int(float(row[4])) if row[4] else 0,
            'mafia_wins': int(float(row[5])) if row[5] else 0,
            'mafia_win_pct': parse_pct(row[6]),
            'total_games': int(float(row[7])) if row[7] else 0,
            'total_win_pct': parse_pct(row[8]),
            'mu': float(row[9]) if row[9] else 0,
            'sigma': float(row[10]) if row[10] else 0,
            'rating': int(float(row[11])) if row[11] else 0,
        })

    ws_history = ss.worksheet('MatchHistory')
    history_data = ws_history.get_all_values()
    game_results = {}
    for row in history_data[1:]:
        gid = row[0]
        if not gid or gid in game_results:
            continue
        alignment = row[2]
        result = row[3]
        if result == 'Win':
            game_results[gid] = alignment
        elif result == 'Loss':
            game_results[gid] = 'Town' if alignment == 'Mafia' else 'Mafia'

    total_games = len(game_results)
    mafia_wins = sum(1 for w in game_results.values() if w == 'Mafia')
    town_wins = total_games - mafia_wins

    return {
        'players': players,
        'game_summary': {
            'total_games': total_games,
            'mafia_wins': mafia_wins,
            'town_wins': town_wins,
            'mafia_win_pct': round(100 * mafia_wins / total_games, 1) if total_games else 0,
            'town_win_pct': round(100 * town_wins / total_games, 1) if total_games else 0,
        },
    }


def get_player_history(body):
    player_name = body.get('player_name')
    if not player_name:
        raise ValueError('player_name is required')

    ss = get_sheet()
    ws_history = ss.worksheet('MatchHistory')
    history_data = ws_history.get_all_values()

    games = []
    for row in history_data[1:]:
        if row[1] != player_name:
            continue
        entry = {
            'game_id': int(float(row[0])),
            'alignment': row[2],
            'result': row[3],
            'rate_change': int(float(row[4])) if row[4] else 0,
        }
        if row[5]:
            entry['old_rating'] = int(float(row[8]))
            entry['new_rating'] = int(float(row[9]))
        games.append(entry)

    return {'player_name': player_name, 'games': games}


# --- HTTP handler ---

def make_response(data, status=200):
    """Create a JSON response with CORS headers."""
    from flask import make_response as flask_response
    resp = flask_response(json.dumps(data), status)
    resp.headers['Content-Type'] = 'application/json'
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return resp


@functions_framework.http
def main(request):
    # Handle CORS preflight
    if request.method == 'OPTIONS':
        return make_response('', 204)

    try:
        body = request.get_json(silent=True) or json.loads(request.data or '{}')
        action = body.get('action')

        if action == 'getPlayers':
            result = get_players()
        elif action == 'getLastGame':
            result = get_last_game()
        elif action == 'recordGame':
            result = record_game(body)
        elif action == 'undoLastGame':
            result = undo_last_game()
        elif action == 'getStats':
            result = get_stats()
        elif action == 'getPlayerHistory':
            result = get_player_history(body)
        else:
            return make_response({'error': f'Unknown action: {action}'}, 400)

        return make_response(result)

    except Exception as e:
        return make_response({'error': str(e)}, 500)
