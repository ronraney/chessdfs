#!/usr/bin/env python3
"""One-time script (Task 9b): stream a Lichess standard-rated monthly dump
and count, for every position reached by a book line (data/openings/*.tsv),
how often each continuation was played and with what result -- real-world
popularity data for `openings.book_weights`, since the Lichess Opening
Explorer API itself is blocked (401 on every query; see
tools/fetch_popularity.py's ACCESS NOTE).

Source: https://database.lichess.org/standard/ -- CC0, no credentials
needed (unlike explorer.lichess.org). The file is streamed and decompressed
on the fly (python-zstandard); only a small rolling buffer is ever held in
memory, and the connection is closed as soon as enough qualifying games
have been seen -- the ~29GB+ compressed dump is never downloaded or stored
whole.

Qualifying game: both WhiteElo and BlackElo >= MIN_RATING. Walks each
qualifying game's first MAX_PLIES plies.

Writes:
  data/openings/popularity.json -- unchanged top-level shape from
    tools/fetch_popularity.py (`{"<moves joined by ' '>": {<next move
    SAN>: <total count>}}`, directly what `loaders.load_popularity` +
    `openings.book_weights` already read) PLUS two reserved keys no real
    position can collide with (position keys are chess SAN joined by
    spaces or "" for the start; neither can begin with "_"):
      "_meta"    -- source month, qualifying-game count, rating filter, ply depth.
      "_results" -- the same {position: {move: ...}} shape, but each move's
                    value is {"white": n, "draws": n, "black": n} instead
                    of a bare total -- the per-move result counts the task
                    asked for, kept out of the plain-int shape so
                    `book_weights`/`build.temperament_weights` (which does
                    `count ** k`) need no code changes.
  data/openings/line_stats.json -- new; for each named book line (each row
    of the vendored TSVs -- see ASSUMPTION below), games whose first
    len(line.moves) plies exactly equal that line, and the white/draw/black
    rate among them.

ASSUMPTION: "named book line" = each TSV row (eco, name, moves), matching
how openings.py itself treats lines (continuing_lines/opening_name match
by exact moves-prefix, not by name) -- 688 of 3865 rows share a name with
at least one other row (transpositions / vendor duplicates with a
different move order or length), so grouping by name alone would conflate
distinct positions. Flagging this since the task said "named book line"
without specifying the grouping key.

ASSUMPTION: a line longer than MAX_PLIES plies (109 of 3865) can never be
"reached" within the first-MAX_PLIES walk, so it gets zero games in
line_stats.json -- not a bug, just the stated 20-ply window.

ASSUMPTION: games with an unresolved Result header ("*") still count
toward the qualifying-game cap (qualification is rating-only per the
task) but contribute no move/result tally, since there's no white/draw/
black bucket to put them in.

ASSUMPTION: Lichess move-quality annotations (e.g. "f4?!", "Bd6??") are
stripped from each SAN token before comparing against the book (verified
present in this month's dump via a live sample -- see session log).
Check/mate marks ("+"/"#") are real SAN and are NOT stripped.
"""
from __future__ import annotations

import io
import json
import re
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import zstandard

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from dfs_chess.loaders import load_opening_book  # noqa: E402

OPENINGS_DIR = REPO_ROOT / "data" / "openings"
POPULARITY_PATH = OPENINGS_DIR / "popularity.json"
LINE_STATS_PATH = OPENINGS_DIR / "line_stats.json"

MIN_RATING = 1800
MAX_PLIES = 20
TARGET_GAMES = 2_000_000
CHECKPOINT_EVERY = 100_000
PROGRESS_EVERY = 20_000
BASE_URL = "https://database.lichess.org/standard/lichess_db_standard_rated_{month}.pgn.zst"
USER_AGENT = "chess-dfs-popularity-count/0 (one-time tool; Task 9b)"

HEADER_RE = re.compile(r'^\[(\S+)\s+"(.*)"\]$')
COMMENT_RE = re.compile(r"\{[^}]*\}")
MOVE_NUMBER_RE = re.compile(r"^\d+\.+$")
ANNOTATION_SUFFIX_RE = re.compile(r"[!?]+$")
RESULT_TOKENS = {"1-0", "0-1", "1/2-1/2", "*"}
RESULT_KEY_FOR_HEADER = {"1-0": "white", "0-1": "black", "1/2-1/2": "draws"}


def _most_recent_full_month(today: date) -> str:
    first_of_this_month = today.replace(day=1)
    last_day_prev_month = first_of_this_month - timedelta(days=1)
    return last_day_prev_month.strftime("%Y-%m")


def _safe_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _parse_movetext(text: str) -> list[str]:
    text = COMMENT_RE.sub(" ", text)
    moves = []
    for tok in text.split():
        if MOVE_NUMBER_RE.match(tok) or tok in RESULT_TOKENS or tok.startswith("$"):
            continue
        moves.append(ANNOTATION_SUFFIX_RE.sub("", tok))
    return moves


def _iter_games(stream: io.TextIOBase):
    """Yields (headers: dict, movetext: str) per PGN game. Tolerant of
    movetext wrapping across multiple lines, though this dump's doesn't.
    """
    headers: dict[str, str] = {}
    movetext_parts: list[str] = []
    for raw_line in stream:
        line = raw_line.rstrip("\n").rstrip("\r")
        if line.startswith("["):
            m = HEADER_RE.match(line)
            if m:
                headers[m.group(1)] = m.group(2)
            continue
        if not line.strip():
            if movetext_parts:
                yield headers, " ".join(movetext_parts)
                headers = {}
                movetext_parts = []
            continue
        movetext_parts.append(line)
    if movetext_parts:
        yield headers, " ".join(movetext_parts)


class _CountingReader:
    """Wraps a file-like object, counting bytes read -- lets us report how
    much compressed data was actually streamed without needing the server
    to tell us (Content-Length is the whole file; we stop partway through).
    """

    def __init__(self, inner):
        self._inner = inner
        self.bytes_read = 0

    def read(self, size=-1):
        chunk = self._inner.read(size)
        self.bytes_read += len(chunk)
        return chunk

    def readable(self):
        return True


def _write_popularity(
    popularity: dict[tuple[str, ...], dict[str, dict[str, int]]],
    meta: dict,
) -> None:
    out: dict = {"_meta": meta, "_results": {}}
    for prefix, moves in popularity.items():
        key = " ".join(prefix)
        out[key] = {move: sum(counts.values()) for move, counts in moves.items()}
        out["_results"][key] = moves
    POPULARITY_PATH.write_text(json.dumps(out, indent=2, sort_keys=True), encoding="utf-8")


def _write_line_stats(book, line_results: list[list[int]], meta: dict) -> None:
    lines = []
    for line, (white, draws, black) in zip(book, line_results):
        games = white + draws + black
        lines.append(
            {
                "eco": line.eco,
                "name": line.name,
                "moves": list(line.moves),
                "games": games,
                "white_rate": white / games if games else None,
                "draw_rate": draws / games if games else None,
                "black_rate": black / games if games else None,
            }
        )
    LINE_STATS_PATH.write_text(
        json.dumps({"_meta": meta, "lines": lines}, indent=2, sort_keys=True), encoding="utf-8"
    )


def main() -> None:
    start = time.monotonic()
    month = _most_recent_full_month(date.today())
    url = BASE_URL.format(month=month)

    book = load_opening_book([OPENINGS_DIR / f"{letter}.tsv" for letter in "abcde"])

    position_set: set[tuple[str, ...]] = set()
    for line in book:
        depth_cap = min(len(line.moves), MAX_PLIES)
        for d in range(depth_cap):
            position_set.add(line.moves[:d])

    full_position_lines: dict[tuple[str, ...], list[int]] = {}
    for idx, line in enumerate(book):
        if len(line.moves) <= MAX_PLIES:
            full_position_lines.setdefault(line.moves, []).append(idx)

    popularity: dict[tuple[str, ...], dict[str, dict[str, int]]] = {}
    line_results: list[list[int]] = [[0, 0, 0] for _ in book]
    result_index = {"white": 0, "draws": 1, "black": 2}

    scanned = 0
    qualifying = 0
    unresolved_results = 0

    def meta(final: bool) -> dict:
        return {
            "source": f"database.lichess.org/standard/lichess_db_standard_rated_{month}.pgn.zst",
            "month": month,
            "min_rating": MIN_RATING,
            "ply_depth": MAX_PLIES,
            "games_scanned": scanned,
            "qualifying_games": qualifying,
            "unresolved_result_games": unresolved_results,
            "complete": final,
        }

    print(f"Fetching {url}", file=sys.stderr)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    response = urllib.request.urlopen(request, timeout=60)
    counting = _CountingReader(response)
    dctx = zstandard.ZstdDecompressor()
    reader = dctx.stream_reader(counting, read_across_frames=True)
    text_stream = io.TextIOWrapper(reader, encoding="utf-8", errors="replace")

    completed = False
    try:
        for headers, movetext in _iter_games(text_stream):
            scanned += 1
            white_elo = _safe_int(headers.get("WhiteElo"))
            black_elo = _safe_int(headers.get("BlackElo"))
            if white_elo is None or black_elo is None:
                continue
            if white_elo < MIN_RATING or black_elo < MIN_RATING:
                continue

            qualifying += 1
            result_key = RESULT_KEY_FOR_HEADER.get(headers.get("Result", "*"))

            if result_key is None:
                unresolved_results += 1
            else:
                moves = _parse_movetext(movetext)[:MAX_PLIES]

                for d in range(len(moves)):
                    prefix = tuple(moves[:d])
                    if prefix in position_set:
                        mv = moves[d]
                        bucket = popularity.setdefault(prefix, {}).setdefault(
                            mv, {"white": 0, "draws": 0, "black": 0}
                        )
                        bucket[result_key] += 1

                for length in range(1, len(moves) + 1):
                    key = tuple(moves[:length])
                    idxs = full_position_lines.get(key)
                    if idxs:
                        for idx in idxs:
                            line_results[idx][result_index[result_key]] += 1

            if qualifying % PROGRESS_EVERY == 0:
                elapsed = time.monotonic() - start
                print(
                    f"  {qualifying:,} qualifying / {scanned:,} scanned, "
                    f"{counting.bytes_read / 1e9:.2f} GB in, {elapsed:.0f}s elapsed",
                    file=sys.stderr,
                )

            if qualifying % CHECKPOINT_EVERY == 0:
                _write_popularity(popularity, meta(final=False))
                _write_line_stats(book, line_results, meta(final=False))

            if qualifying >= TARGET_GAMES:
                completed = True
                break
    finally:
        response.close()
        _write_popularity(popularity, meta(final=completed))
        _write_line_stats(book, line_results, meta(final=completed))

    elapsed = time.monotonic() - start
    print(
        f"Done: {qualifying:,} qualifying / {scanned:,} scanned games, "
        f"{counting.bytes_read / 1e9:.2f} GB compressed streamed, {elapsed:.0f}s",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
