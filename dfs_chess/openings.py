"""Opening book queries — pure (no I/O). Book data is loaded by
`loaders.py` (`load_opening_book`) and handed in here as `list[BookLine]`.
"""
from __future__ import annotations

from dataclasses import dataclass

import chess

from .models import Piece, Player
from .pieces import piece_for_chess_type
from .rules import max_assignable
from .sport import SportConfig


@dataclass(frozen=True)
class BookLine:
    eco: str
    name: str
    moves: tuple[str, ...]  # SAN tokens, no move numbers


def opening_name(moves: tuple[str, ...], book: list[BookLine]) -> str | None:
    """The name of the longest book line that's a prefix of `moves`
    (including an exact match), or None if no line matches at all.
    """
    moves = tuple(moves)
    best: BookLine | None = None
    for line in book:
        if len(line.moves) <= len(moves) and line.moves == moves[: len(line.moves)]:
            if best is None or len(line.moves) > len(best.moves):
                best = line
    return best.name if best else None


def find_opening_lines(query: str, book: list[BookLine]) -> list[BookLine]:
    """Book lines whose name contains `query`, case-insensitively — the
    "search openings by name" lookup for starting a template (RULES.md
    "Opening templates"). An empty/blank query matches every line.
    """
    q = query.strip().lower()
    return [line for line in book if q in line.name.lower()]


def continuing_lines(moves: tuple[str, ...], book: list[BookLine]) -> list[BookLine]:
    """Book lines that start with `moves` and still have at least one
    more move beyond it — the "pick a new named continuation from here"
    lookup once a template ends mid-build (RULES.md "Opening templates").
    """
    moves = tuple(moves)
    depth = len(moves)
    return [line for line in book if len(line.moves) > depth and line.moves[:depth] == moves]


def book_continuations(moves: tuple[str, ...], book: list[BookLine]) -> set[str]:
    """The set of next moves, across all book lines, that extend `moves`."""
    moves = tuple(moves)
    depth = len(moves)
    return {
        line.moves[depth]
        for line in book
        if len(line.moves) > depth and line.moves[:depth] == moves
    }


def book_weights(
    moves: tuple[str, ...], book: list[BookLine], popularity: dict[str, dict[str, int]]
) -> dict[str, int]:
    """Each book continuation after `moves`, weighted by its Lichess game
    count from `popularity` (see `loaders.load_popularity`). If `moves`'
    position has no entry in `popularity` at all, every continuation gets
    equal weight (1) instead -- there's simply no data to rank them by.
    """
    continuations = book_continuations(moves, book)
    counts = popularity.get(" ".join(moves))
    if counts is None:
        return {move: 1 for move in continuations}
    return {move: counts.get(move, 0) for move in continuations}


def split_family(name: str) -> tuple[str, str]:
    """"Ruy Lopez: Berlin Defense, Rio Gambit Accepted" -> ("Ruy Lopez",
    "Berlin Defense, Rio Gambit Accepted") -- the vendored book's names
    follow "Family: Variation" (lichess-org/chess-openings' own
    convention). A name with no colon has no sub-variation to show --
    just the family, on its own.
    """
    if ":" in name:
        family, _, variation = name.partition(":")
        return family.strip(), variation.strip()
    return name.strip(), ""


@dataclass(frozen=True)
class RankedFamily:
    name: str
    rank: int  # 1 = most played
    games: int  # the representative line's own games
    line: BookLine


# Task 20b: "umbrella" families whose own name is too broad/generic to
# usefully suggest (every opening starting 1. e4 is nominally a "King's
# Pawn Game") -- excluded from ranking outright, by name, regardless of
# how many games any of their rows have. Not derived from the data by a
# rule; a caller may override this list via `rank_families`'s own
# parameter.
DEFAULT_EXCLUDED_FAMILIES: frozenset[str] = frozenset(
    {
        "King's Pawn Game",
        "Queen's Pawn Game",
        "King's Knight Opening",
        "Indian Defense",
    }
)


def rank_families(
    line_stats: list[dict], excluded_families: frozenset[str] = DEFAULT_EXCLUDED_FAMILIES
) -> list[RankedFamily]:
    """Ranks each family (Task 20, corrected by Task 20b) --
    `split_family`'s first element -- by its most-played line reaching
    at least 6 plies, from ANY row whose name IS that family or starts
    with "<family>:" (not just a bare-name row -- Task 20's original
    restriction to the bare name was a bug; a named sub-variation's own
    row is a perfectly good representative). Ties: fewest plies, then
    eco. `excluded_families` (default `DEFAULT_EXCLUDED_FAMILIES`) are
    left off entirely regardless of games -- an explicit exclusion
    list, not a rule derived from the data (Task 20b). A family with no
    qualifying row at all is also left off (unranked). Rank 1 = most
    played.
    """
    reps: dict[str, dict] = {}
    for entry in line_stats:
        family, _ = split_family(entry["name"])
        if family in excluded_families or len(entry["moves"]) < 6:
            continue
        current = reps.get(family)
        key = (entry["games"], -len(entry["moves"]), entry["eco"])
        if current is None or key > (current["games"], -len(current["moves"]), current["eco"]):
            reps[family] = entry

    ranked_names = sorted(reps, key=lambda n: (-reps[n]["games"], n))
    return [
        RankedFamily(
            name=name,
            rank=i,
            games=reps[name]["games"],
            line=BookLine(eco=reps[name]["eco"], name=reps[name]["name"], moves=tuple(reps[name]["moves"])),
        )
        for i, name in enumerate(ranked_names, start=1)
    ]


def _piece_eligible_positions(sport: SportConfig) -> dict[Piece, frozenset[str]]:
    """Which DK positions each `Piece` is eligible for, per `sport`'s own
    piece bands (the inverse of `classify`) — a band with `positions=None`
    (Queen, Pawn in NFL) is eligible for every position any roster slot
    accepts, not just one.
    """
    all_positions: frozenset[str] = frozenset().union(
        *(slot.positions for slot in sport.roster_slots)
    )
    eligible: dict[Piece, frozenset[str]] = {}
    for band in sport.piece_bands:
        band_positions = band.positions if band.positions is not None else all_positions
        eligible[band.piece] = eligible.get(band.piece, frozenset()) | band_positions
    return eligible


def _proxy_player(piece: Piece, eligible: dict[Piece, frozenset[str]]) -> Player:
    """A placeholder `Player` standing in for "some player of this piece
    type" — only `positions` matters for `max_assignable`. A sport with
    no band at all for `piece` (legal -- only a catch-all PAWN band is
    required) gets an empty `positions`, so `max_assignable` correctly
    finds this proxy unassignable to any slot, which is exactly right:
    if the sport can never produce a player of this type, a line
    requiring one is infeasible there, full stop.
    """
    return Player(
        id="",
        name="",
        positions=tuple(eligible.get(piece, frozenset())),
        team="",
        opp="",
        salary=0,
        proj=0.0,
        own_small=0.0,
        own_large=0.0,
    )


def legal_depth(line: tuple[str, ...], sport: SportConfig) -> int | None:
    """The 1-indexed ply at which `line` first makes either side's roster
    impossible to complete, counting piece types only (ignores salary cap
    and captures entirely -- a capture never transfers anything here, it's
    just another move of the capturing piece's type). Castling counts as
    one King pick and one Rook pick at that ply, per CLAUDE.md. Returns
    None if the line never breaks feasibility.
    """
    eligible = _piece_eligible_positions(sport)
    board = chess.Board()
    proxies = {chess.WHITE: [], chess.BLACK: []}

    for ply, san in enumerate(line, start=1):
        move = board.parse_san(san)
        side = board.turn
        pieces_moved = (
            (Piece.KING, Piece.ROOK)
            if board.is_castling(move)
            else (piece_for_chess_type(board.piece_type_at(move.from_square)),)
        )
        proxies[side].extend(_proxy_player(piece, eligible) for piece in pieces_moved)

        if max_assignable(proxies[side], sport.roster_slots) < len(proxies[side]):
            return ply

        board.push(move)

    return None


@dataclass(frozen=True)
class OpeningPreview:
    fen: str
    white_pieces: tuple[Piece, ...]
    black_pieces: tuple[Piece, ...]
    break_ply: int | None


def opening_preview(line: BookLine, sport: SportConfig) -> OpeningPreview:
    """A book line's DFS-relevant preview (Task 17): the final chess
    position (FEN) after playing every one of `line.moves` in full --
    independent of `break_ply` below, this is just the position the
    line's own moves reach; for each side, the ordered sequence of
    piece types its moves would lock (castling counts as one King pick
    then one Rook pick, same convention `legal_depth` already uses);
    and the ply (1-indexed) at which the line first makes either side's
    roster impossible to complete, or None if it never does -- exactly
    `legal_depth`'s own return value, reused rather than re-derived.
    """
    board = chess.Board()
    white_pieces: list[Piece] = []
    black_pieces: list[Piece] = []

    for san in line.moves:
        move = board.parse_san(san)
        side_pieces = white_pieces if board.turn == chess.WHITE else black_pieces
        if board.is_castling(move):
            side_pieces.extend((Piece.KING, Piece.ROOK))
        else:
            side_pieces.append(piece_for_chess_type(board.piece_type_at(move.from_square)))
        board.push(move)

    return OpeningPreview(
        fen=board.fen(),
        white_pieces=tuple(white_pieces),
        black_pieces=tuple(black_pieces),
        break_ply=legal_depth(line.moves, sport),
    )
