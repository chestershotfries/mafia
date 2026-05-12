"""GCS-backed JSON spreadsheet that mimics the gspread interface.

The whole spreadsheet is one JSON object in a Cloud Storage bucket:

    {
      "tabs": {
        "MatchRatings": [[...header...], [row], [row], ...],
        "MatchHistory": [[...header...], [row], [row], ...]
      }
    }

All cells are stored as strings to match gspread's get_all_values() return
shape. Writes are deferred — the dispatcher calls .flush() once per request
so a multi-step handler (e.g. record_game) is a single atomic upload.

"Stats Summary" is computed on read from MatchHistory + MatchRatings;
writes to it are no-ops because it's regenerated each time.
"""

import json
import os
import re
from typing import Any


class WorksheetNotFound(Exception):
    pass


def _default_storage_client():
    # Imported lazily so tests can inject a fake client without pulling
    # in google-cloud-storage (and its cryptography dep) at module load.
    from google.cloud import storage
    return storage.Client()


_A1_RE = re.compile(r"^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$")


def _col_to_idx(letters: str) -> int:
    n = 0
    for c in letters:
        n = n * 26 + (ord(c) - ord("A") + 1)
    return n - 1  # 0-based


def _parse_a1(a1: str) -> tuple[int, int, int, int]:
    """Returns (row_start, row_end, col_start, col_end), all 0-based inclusive."""
    m = _A1_RE.match(a1.strip())
    if not m:
        raise ValueError(f"unsupported A1 range: {a1}")
    col_s = _col_to_idx(m.group(1))
    row_s = int(m.group(2)) - 1
    col_e = _col_to_idx(m.group(3)) if m.group(3) else col_s
    row_e = int(m.group(4)) - 1 if m.group(4) else row_s
    return row_s, row_e, col_s, col_e


def _stringify(v: Any) -> str:
    if v is None or v == "":
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float):
        # match gspread which renders floats compactly
        return repr(v)
    return str(v)


class JsonWorksheet:
    def __init__(self, parent: "JsonSpreadsheet", title: str):
        self._parent = parent
        self.title = title

    @property
    def id(self) -> int:
        return 0  # only used in sheets-specific copyPaste, harmless

    def _data(self) -> list[list[str]]:
        if self.title == "Stats Summary":
            return self._parent._stats_summary()
        return self._parent._tab(self.title)

    def _ensure_min_cols(self, row: list[str], n: int) -> list[str]:
        while len(row) < n:
            row.append("")
        return row

    def get_all_values(self) -> list[list[str]]:
        return [list(r) for r in self._data()]

    def append_row(self, row, value_input_option: str | None = None) -> None:
        data = self._data()
        if self.title == "Stats Summary":
            return  # computed virtual tab — ignore writes
        data.append([_stringify(v) for v in row])
        self._parent._mark_dirty()

    def append_rows(self, rows, value_input_option: str | None = None) -> None:
        for r in rows:
            self.append_row(r, value_input_option)

    def insert_rows(self, rows, row: int = 1, value_input_option: str | None = None) -> None:
        if self.title == "Stats Summary":
            return
        data = self._data()
        insert_at = max(0, row - 1)
        for i, r in enumerate(rows):
            data.insert(insert_at + i, [_stringify(v) for v in r])
        self._parent._mark_dirty()

    def delete_rows(self, start: int, end: int | None = None) -> None:
        if self.title == "Stats Summary":
            return
        data = self._data()
        s = start - 1
        e = (end - 1) if end is not None else s
        if s < 0 or e >= len(data) or s > e:
            return
        del data[s : e + 1]
        self._parent._mark_dirty()

    def update(self, a1: str, values, value_input_option: str | None = None) -> None:
        if self.title == "Stats Summary":
            return
        row_s, row_e, col_s, col_e = _parse_a1(a1)
        data = self._data()
        width = col_e - col_s + 1
        for ri, row_vals in enumerate(values):
            target_row = row_s + ri
            while target_row >= len(data):
                data.append([])
            self._ensure_min_cols(data[target_row], col_e + 1)
            for ci in range(width):
                v = row_vals[ci] if ci < len(row_vals) else ""
                data[target_row][col_s + ci] = _stringify(v)
        self._parent._mark_dirty()

    def sort(self, *args, **kwargs) -> None:
        # Sheets-only sort op. Skip; data ordering for the JSON backend
        # is the responsibility of the read path.
        pass

    def row_values(self, n: int) -> list[str]:
        data = self._data()
        if 1 <= n <= len(data):
            return list(data[n - 1])
        return []


class JsonSpreadsheet:
    """gspread.Spreadsheet stand-in backed by a single GCS JSON object."""

    def __init__(self, bucket_name: str, object_name: str, client=None):
        self._client = client if client is not None else _default_storage_client()
        self._bucket = self._client.bucket(bucket_name)
        self._blob_name = object_name
        self._doc: dict | None = None
        self._generation: int | None = None
        self._dirty = False

    # --- load / flush ---

    def _ensure_loaded(self) -> None:
        if self._doc is not None:
            return
        blob = self._bucket.blob(self._blob_name)
        if not blob.exists():
            self._doc = {"tabs": {}}
            self._generation = 0
            return
        blob.reload()
        text = blob.download_as_text()
        self._doc = json.loads(text) if text else {"tabs": {}}
        self._generation = blob.generation

    def _tab(self, name: str) -> list[list[str]]:
        self._ensure_loaded()
        tabs = self._doc.setdefault("tabs", {})
        if name not in tabs:
            raise WorksheetNotFound(name)
        return tabs[name]

    def _stats_summary(self) -> list[list[str]]:
        """Compute Stats Summary on the fly from MatchHistory + MatchRatings."""
        self._ensure_loaded()
        tabs = self._doc.get("tabs", {})
        history = tabs.get("MatchHistory", [])
        ratings = tabs.get("MatchRatings", [])

        header = [
            "Player",
            "Town Games",
            "Town Wins",
            "Town Win %",
            "Mafia Games",
            "Mafia Wins",
            "Mafia Win %",
            "Total Games",
            "Total Win %",
            "mu",
            "sigma",
            "Rating",
        ]

        per = {}
        for row in history[1:]:
            if len(row) < 4 or not row[1]:
                continue
            name, role, result = row[1], row[2], row[3]
            if result not in ("Win", "Loss"):
                continue
            alignment = "Mafia" if role == "Mafia" else "Town"
            e = per.setdefault(
                name,
                {"town_games": 0, "town_wins": 0, "mafia_games": 0, "mafia_wins": 0},
            )
            if alignment == "Mafia":
                e["mafia_games"] += 1
                if result == "Win":
                    e["mafia_wins"] += 1
            else:
                e["town_games"] += 1
                if result == "Win":
                    e["town_wins"] += 1

        rows = [header]
        for r in ratings[1:]:
            if len(r) < 3 or not r[0]:
                continue
            name = r[0]
            try:
                mu = float(r[1])
                sigma = float(r[2])
            except (ValueError, IndexError):
                continue
            s = per.get(
                name,
                {"town_games": 0, "town_wins": 0, "mafia_games": 0, "mafia_wins": 0},
            )
            total_games = s["town_games"] + s["mafia_games"]
            total_wins = s["town_wins"] + s["mafia_wins"]
            rating = round((mu - 1.5 * sigma) * 68)
            town_pct = (100 * s["town_wins"] / s["town_games"]) if s["town_games"] else 0
            mafia_pct = (100 * s["mafia_wins"] / s["mafia_games"]) if s["mafia_games"] else 0
            total_pct = (100 * total_wins / total_games) if total_games else 0
            rows.append([
                name,
                str(s["town_games"]),
                str(s["town_wins"]),
                f"{town_pct:.1f}%",
                str(s["mafia_games"]),
                str(s["mafia_wins"]),
                f"{mafia_pct:.1f}%",
                str(total_games),
                f"{total_pct:.1f}%",
                repr(mu),
                repr(sigma),
                str(rating),
            ])
        rows[1:] = sorted(rows[1:], key=lambda r: int(r[11]), reverse=True)
        return rows

    def _mark_dirty(self) -> None:
        self._dirty = True

    def flush(self) -> None:
        if not self._dirty or self._doc is None:
            return
        blob = self._bucket.blob(self._blob_name)
        body = json.dumps(self._doc, indent=2, ensure_ascii=False)
        kwargs = {"content_type": "application/json"}
        if self._generation is not None:
            kwargs["if_generation_match"] = self._generation
        blob.upload_from_string(body, **kwargs)
        blob.reload()
        self._generation = blob.generation
        self._dirty = False

    # --- gspread.Spreadsheet API ---

    def worksheet(self, name: str) -> JsonWorksheet:
        if name == "Stats Summary":
            return JsonWorksheet(self, name)
        self._tab(name)  # raises WorksheetNotFound
        return JsonWorksheet(self, name)

    def batch_update(self, body: dict) -> None:
        # Sheets-specific copyPaste; no-op for JSON store.
        pass


def get_json_spreadsheet(
    bucket: str | None = None, obj: str | None = None
) -> JsonSpreadsheet:
    bucket = bucket or os.environ["JSON_BUCKET"]
    obj = obj or os.environ.get("JSON_OBJECT", "mafia.json")
    return JsonSpreadsheet(bucket, obj)
