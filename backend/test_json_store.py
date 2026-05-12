"""Smoke test for json_store + main.py against a fake GCS bucket.

Run from /home/user/mafia/backend:
    python test_json_store.py
"""

import json
import os


# --- Fake GCS client ---

class _FakeBlob:
    def __init__(self, store, name):
        self._store = store
        self._name = name
        self.generation = 0

    def exists(self):
        return self._name in self._store._data

    def reload(self):
        self.generation = self._store.get_generation(self._name)

    def download_as_text(self):
        return self._store.get(self._name) or ""

    def upload_from_string(self, body, content_type=None, if_generation_match=None):
        if (
            if_generation_match is not None
            and if_generation_match != self._store.get_generation(self._name)
        ):
            raise RuntimeError("generation precondition failed")
        self._store.put(self._name, body)
        self.generation = self._store.get_generation(self._name)


class _FakeBucket:
    def __init__(self, store):
        self._store = store

    def blob(self, name):
        return _FakeBlob(self._store, name)


class _FakeStore:
    def __init__(self):
        self._data = {}
        self._gen = {}

    def get(self, name):
        return self._data.get(name)

    def get_generation(self, name):
        return self._gen.get(name, 0)

    def put(self, name, body):
        self._data[name] = body
        self._gen[name] = self._gen.get(name, 0) + 1


class _FakeClient:
    def __init__(self, store):
        self._store = store

    def bucket(self, _name):
        return _FakeBucket(self._store)


# --- Test setup ---

STORE = _FakeStore()
STORE.put(
    "test.json",
    json.dumps({
        "tabs": {
            "MatchRatings": [["Player", "mu", "sigma"]],
            "MatchHistory": [[
                "GameID", "Player", "Alignment", "Result", "RateChange",
                "old_mu", "new_mu", "new_sigma", "old_rating", "new_rating", "old_sigma",
            ]],
        }
    }),
)

os.environ["STORAGE"] = "gcs_json"
os.environ["JSON_BUCKET"] = "test"
os.environ["JSON_OBJECT"] = "test.json"
os.environ["GAME_PASSWORD"] = "x"

import json_store
import main

json_store.get_json_spreadsheet = lambda bucket=None, obj=None: json_store.JsonSpreadsheet(
    "test", "test.json", client=_FakeClient(STORE)
)


def run(action, **body):
    body["action"] = action
    body.setdefault("password", "x")
    main._reset_storage_state()
    if action == "getPlayers":
        r = main.get_players()
    elif action == "getLastGame":
        r = main.get_last_game()
    elif action == "recordGame":
        r = main.record_game(body)
    elif action == "undoLastGame":
        r = main.undo_last_game()
    elif action == "getStats":
        r = main.get_stats()
    elif action == "getMatchHistory":
        r = main.get_match_history()
    else:
        raise ValueError(action)
    main._flush_storage()
    return r


# 1. Empty store: getPlayers returns [].
r = run("getPlayers")
assert r == {"players": []}, r
print("PASS: getPlayers on empty store")

# 2. Record a game with 15 players (3 mafia, 1 cop, 1 medic, 1 vigi, 9 town).
names = [f"P{i}" for i in range(1, 16)]
assignments = []
for i, name in enumerate(names, start=1):
    role = (
        "Mafia" if i <= 3 else
        "Cop" if i == 4 else
        "Medic" if i == 5 else
        "Vigilante" if i == 6 else
        "Town"
    )
    assignments.append({"position": i, "name": name, "role": role, "is_ghost": False})

r = run("recordGame", assignments=assignments, winner="Town", night0_kills=[])
assert r["game_id"] == 46, r
assert len(r["players"]) == 15
print(f"PASS: recordGame returned game_id={r['game_id']}")

# 3. getLastGame reflects the new game.
r = run("getLastGame")
assert r["game"]["game_id"] == 46, r
assert len(r["game"]["players"]) == 15
p1 = next(p for p in r["game"]["players"] if p["player"] == "P1")
assert p1["result"] == "Loss"
assert p1["rate_change"] < 0
print("PASS: getLastGame reflects new game and ratings")

# 4. getPlayers lists 15 players.
r = run("getPlayers")
assert len(r["players"]) == 15
print("PASS: getPlayers lists 15 players")

# 5. getMatchHistory has the game and the full role set.
r = run("getMatchHistory")
assert len(r["games"]) == 1
assert r["games"][0]["game_id"] == 46
roles = sorted({p["role"] for p in r["games"][0]["players"]})
assert roles == ["Cop", "Mafia", "Medic", "Town", "Vigilante"], roles
print(f"PASS: getMatchHistory has 1 game with roles {roles}")

# 6. getStats computes Stats Summary on the fly.
r = run("getStats")
assert len(r["players"]) == 15, r
p1 = next(p for p in r["players"] if p["name"] == "P1")
assert p1["mafia_games"] == 1
assert p1["mafia_wins"] == 0
print("PASS: getStats computes summary virtually")

# 7. Record a second game (Mafia wins).
r = run("recordGame", assignments=assignments, winner="Mafia", night0_kills=[])
assert r["game_id"] == 47, r
print(f"PASS: second recordGame returned game_id={r['game_id']}")

# 8. undoLastGame removes game 47.
r = run("undoLastGame")
assert r["undone_game_id"] == 47, r
print("PASS: undoLastGame removed game 47")

r = run("getLastGame")
assert r["game"]["game_id"] == 46
print("PASS: undo brought back game 46 as latest")

# 9. Confirm GCS state is persisted between flushes.
final_doc = json.loads(STORE.get("test.json"))
assert "MatchRatings" in final_doc["tabs"]
assert len(final_doc["tabs"]["MatchHistory"]) == 16  # header + 15 game-46 rows
print(f"PASS: final blob has {len(final_doc['tabs']['MatchHistory'])} history rows (1 header + 15)")

print("\nAll smoke tests passed.")
