#!/usr/bin/env python3
"""One-time script: fetch Lichess Opening Explorer move counts for every
position reached by a book line, saving to data/openings/popularity.json.

NOT part of the dfs_chess engine -- openings.py never touches the network.
Re-run any time to pick up new book lines; it skips positions already in
the output file, so an interrupted run is safe to resume.

ACCESS NOTE (checked 2026-10-12): the documented endpoint is
https://explorer.lichess.org/lichess (per lichess-org/api's OpenAPI spec --
note the .org host, not the older .ovh one some docs/snippets still show),
and its spec declares `security: [OAuth2: []]`. Live probing confirms this
is enforced: both explorer.lichess.org and explorer.lichess.ovh currently
return a bare nginx "401 Authorization Required" for every query path
(/lichess, /masters) with no WWW-Authenticate header and no JSON body --
not lichess's normal API error shape. That means this isn't the standard
"works anonymously, higher limits with a token" pattern most lichess
endpoints use; it looks like the public explorer API is currently gated
entirely. A Lichess personal API token (https://lichess.org/account/oauth/token)
is the only credential this script knows how to send (via
LICHESS_API_TOKEN) -- if that isn't what unlocks it, that's a question for
whoever controls that reverse proxy, not something to work around here.

Usage:
    Put `LICHESS_API_TOKEN=<token>` in a `.env` file at the repo root (never
    committed -- see .gitignore), or export it in the environment; either
    works, .env takes priority. Then: python tools/fetch_popularity.py

Rate limiting: one request at a time, a fixed delay between requests, and
Retry-After is honored on HTTP 429. There are ~6300 unique positions across
the vendored book (data/openings/*.tsv) as of this writing, so a full run
at the default delay takes on the order of two hours -- expected, not a bug.

The token is never logged or printed anywhere in this script.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import chess  # noqa: E402

from dfs_chess.loaders import load_opening_book  # noqa: E402

EXPLORER_URL = "https://explorer.lichess.org/lichess"
OPENINGS_DIR = REPO_ROOT / "data" / "openings"
OUTPUT_PATH = OPENINGS_DIR / "popularity.json"
DOTENV_PATH = REPO_ROOT / ".env"
REQUEST_DELAY_SECONDS = 1.0
USER_AGENT = "chess-dfs-popularity-fetch/0 (one-time tool; see Tasks.md Task 9)"


def _token_from_dotenv() -> str | None:
    if not DOTENV_PATH.exists():
        return None
    for line in DOTENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() == "LICHESS_API_TOKEN":
            return value.strip().strip("'").strip('"')
    return None


def _load_token() -> str | None:
    return _token_from_dotenv() or os.environ.get("LICHESS_API_TOKEN")


def _book_positions() -> list[tuple[str, ...]]:
    """Every proper prefix of every book line (the positions a game could
    still be continuing from), deduped, shortest first.
    """
    book = load_opening_book([OPENINGS_DIR / f"{letter}.tsv" for letter in "abcde"])
    positions: set[tuple[str, ...]] = set()
    for line in book:
        for depth in range(len(line.moves)):
            positions.add(line.moves[:depth])
    return sorted(positions, key=len)


def _san_to_uci(moves: tuple[str, ...]) -> str:
    board = chess.Board()
    uci_moves = []
    for san in moves:
        move = board.parse_san(san)
        uci_moves.append(move.uci())
        board.push(move)
    return ",".join(uci_moves)


def _fetch(moves: tuple[str, ...], token: str) -> dict[str, int]:
    play = _san_to_uci(moves)
    url = f"{EXPLORER_URL}?variant=standard&play={play}" if play else f"{EXPLORER_URL}?variant=standard"
    request = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
    )
    while True:
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.load(response)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                retry_after = int(e.headers.get("Retry-After", "5"))
                print(f"  429 rate limited; sleeping {retry_after}s", file=sys.stderr)
                time.sleep(retry_after)
                continue
            raise
    return {m["san"]: m["white"] + m["draws"] + m["black"] for m in data.get("moves", [])}


def main() -> None:
    token = _load_token()
    if not token:
        print(
            "LICHESS_API_TOKEN is not set (checked .env at the repo root, "
            "then the environment). A Lichess personal API token "
            "(https://lichess.org/account/oauth/token) is required -- see "
            "the ACCESS NOTE at the top of this file for what's currently "
            "known (and not known) about whether that's actually sufficient.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    popularity: dict[str, dict[str, int]] = {}
    if OUTPUT_PATH.exists():
        popularity = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))

    positions = _book_positions()
    todo = [p for p in positions if " ".join(p) not in popularity]
    print(f"{len(positions)} unique positions, {len(todo)} not yet fetched", file=sys.stderr)

    for i, moves in enumerate(todo):
        key = " ".join(moves)
        popularity[key] = _fetch(moves, token)
        OUTPUT_PATH.write_text(json.dumps(popularity, indent=2, sort_keys=True), encoding="utf-8")
        print(f"[{i + 1}/{len(todo)}] {key or '(starting position)'}", file=sys.stderr)
        time.sleep(REQUEST_DELAY_SECONDS)


if __name__ == "__main__":
    main()
