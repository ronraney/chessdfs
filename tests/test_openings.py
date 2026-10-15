from pathlib import Path

import chess

from dfs_chess.loaders import load_opening_book
from dfs_chess.models import Piece
from dfs_chess.loaders import load_line_stats
from dfs_chess.openings import (
    BookLine,
    book_continuations,
    book_weights,
    continuing_lines,
    find_opening_lines,
    legal_depth,
    opening_name,
    opening_preview,
    rank_families,
    split_family,
)
from dfs_chess.sport import PieceBand, RosterSlot, SportConfig, load_sport_config

OPENINGS_DIR = Path(__file__).resolve().parent.parent / "data" / "openings"
BOOK = load_opening_book([OPENINGS_DIR / f"{letter}.tsv" for letter in "abcde"])
NFL = load_sport_config(
    Path(__file__).resolve().parent.parent / "config" / "sports" / "nfl.json"
)

RUY_LOPEZ = ("e4", "e5", "Nf3", "Nc6", "Bb5")
MORPHY_DEFENSE = ("e4", "e5", "Nf3", "Nc6", "Bb5", "a6")  # Ruy Lopez: Morphy Defense, C70
NAJDORF = ("e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6")
FRIED_LIVER = ("e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "Ng5", "d5", "exd5", "Nxd5", "Nxf7")
# Italian Game: Classical Variation, Albin Gambit, C50 -- castles early (ply 7).
ITALIAN_CASTLES = ("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "c3")


def test_opening_name_ruy_lopez():
    assert opening_name(RUY_LOPEZ, BOOK) == "Ruy Lopez"


def test_opening_name_none_when_no_line_matches():
    assert opening_name(("Qzz9",), BOOK) is None  # not a real SAN token; no line starts with it


def test_book_continuations_after_e4():
    continuations = book_continuations(("e4",), BOOK)
    assert {"e5", "c5", "e6", "c6"} <= continuations


def test_legal_depth_najdorf_breaks_at_ply_9():
    assert legal_depth(NAJDORF, NFL) == 9


def test_legal_depth_fried_liver_breaks_at_ply_10():
    assert legal_depth(FRIED_LIVER, NFL) == 10


def test_legal_depth_none_when_line_never_breaks():
    assert legal_depth(RUY_LOPEZ, NFL) is None


def test_legal_depth_handles_a_sport_missing_a_piece_band():
    # A sport with only the required PAWN catch-all band -- a line
    # requiring a Knight has no eligible band at all, so it must break
    # right there (not crash with a KeyError -- Task 17 wired
    # legal_depth into a live cli.py path for the first time, via
    # opening_preview, and this surfaced against a sport fixture this
    # minimal).
    toy_sport = SportConfig(
        sport="TOY",
        salary_cap=50000,
        piece_bands=[PieceBand(piece=Piece.PAWN, positions=None, exclude_positions=None, min_salary=None, max_salary=None)],
        roster_slots=[RosterSlot(name="ANY", positions=frozenset({"ANY"}), count=9)],
    )
    assert legal_depth(("e4", "e5", "Nf3"), toy_sport) == 3  # Nf3 at ply 3: no Knight band exists


# --- opening preview (Task 17) ------------------------------------------------

def test_opening_preview_morphy_defense_gives_white_pawn_knight_bishop():
    line = BookLine(eco="C70", name="Ruy Lopez: Morphy Defense", moves=MORPHY_DEFENSE)
    preview = opening_preview(line, NFL)
    assert preview.white_pieces == (Piece.PAWN, Piece.KNIGHT, Piece.BISHOP)
    assert preview.black_pieces == (Piece.PAWN, Piece.KNIGHT, Piece.PAWN)
    assert preview.fen == _board_after(MORPHY_DEFENSE).fen()
    assert preview.break_ply is None


def test_opening_preview_castling_line_lists_king_and_rook():
    line = BookLine(eco="C50", name="Italian Game: Classical Variation, Albin Gambit", moves=ITALIAN_CASTLES)
    preview = opening_preview(line, NFL)
    assert preview.white_pieces == (
        Piece.PAWN, Piece.KNIGHT, Piece.BISHOP, Piece.KING, Piece.ROOK, Piece.PAWN,
    )


def test_opening_preview_najdorf_reports_whites_break_at_ply_9():
    line = BookLine(eco="B90", name="Najdorf", moves=NAJDORF)
    preview = opening_preview(line, NFL)
    assert preview.break_ply == 9 == legal_depth(NAJDORF, NFL)


def _board_after(moves: tuple[str, ...]) -> chess.Board:
    board = chess.Board()
    for san in moves:
        board.push(board.parse_san(san))
    return board


# --- popularity weights ------------------------------------------------------
# Synthetic popularity fixtures -- deliberately not the real
# data/openings/popularity.json. Tests must stay deterministic and
# network-free regardless of whether that file has been populated yet
# (see Tasks.md Task 9: the Lichess explorer API currently requires
# credentials this project doesn't have, so it hasn't been).

def test_book_weights_ranks_e5_and_c5_above_b6_after_e4():
    assert "b6" in book_continuations(("e4",), BOOK)  # Owen Defense; a real, rare line
    popularity = {"e4": {"e5": 1_000_000, "c5": 800_000, "b6": 500}}

    weights = book_weights(("e4",), BOOK, popularity)

    assert weights["e5"] > weights["b6"]
    assert weights["c5"] > weights["b6"]


def test_book_weights_equal_when_position_has_no_data():
    weights = book_weights(("e4",), BOOK, {})
    continuations = book_continuations(("e4",), BOOK)

    assert set(weights) == continuations
    assert len(set(weights.values())) == 1  # every continuation weighted the same


def test_book_weights_missing_continuation_defaults_to_zero():
    # A continuation the book has but the fetched position's data doesn't
    # mention still gets a weight -- just the lowest one (0), not dropped.
    popularity = {"e4": {"e5": 100}}
    weights = book_weights(("e4",), BOOK, popularity)
    assert weights["c5"] == 0
    assert weights["e5"] == 100


# --- template search / continuation lookups (Task 13) ------------------------

def test_find_opening_lines_matches_by_name_case_insensitively():
    matches = find_opening_lines("ruy lopez", BOOK)
    assert any(line.name == "Ruy Lopez" for line in matches)
    assert all("ruy lopez" in line.name.lower() for line in matches)


def test_find_opening_lines_blank_query_matches_everything():
    assert find_opening_lines("", BOOK) == BOOK


def test_find_opening_lines_no_match():
    assert find_opening_lines("not a real opening name", BOOK) == []


def test_continuing_lines_after_e4_includes_ruy_lopez_and_excludes_shorter_lines():
    matches = continuing_lines(("e4",), BOOK)
    assert any(line.name == "Ruy Lopez" for line in matches)
    assert all(line.moves[0] == "e4" for line in matches)
    assert all(len(line.moves) > 1 for line in matches)  # each has a next move


# --- family ranking (Task 20, corrected by Task 20b) -------------------------
# Synthetic line_stats-shaped fixtures -- deliberately not the real
# data/openings/line_stats.json, so these stay deterministic regardless
# of what that file currently contains.

def _stat(eco: str, name: str, moves: list[str], games: int) -> dict:
    return {"eco": eco, "name": name, "moves": moves, "games": games}


_SIX_PLY = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]
_SEVEN_PLY = _SIX_PLY + ["O-O"]
_FIVE_PLY = _SIX_PLY[:-1]


def test_rank_families_orders_by_the_representative_lines_games():
    line_stats = [
        _stat("C60", "Ruy Lopez", _SIX_PLY, 1000),
        _stat("B01", "Scandinavian Defense", _SIX_PLY, 2000),
    ]
    ranked = rank_families(line_stats)
    assert [f.name for f in ranked] == ["Scandinavian Defense", "Ruy Lopez"]
    assert [f.rank for f in ranked] == [1, 2]


def test_rank_families_a_subvariation_substitutes_for_a_too_short_bare_name():
    # Task 20b's correction: the bare name's own row is only 5 plies, but
    # a named sub-variation reaching 6+ plies DOES substitute for it --
    # unlike Task 20's original (buggy) bare-name-only restriction.
    line_stats = [
        _stat("C60", "Ruy Lopez", _FIVE_PLY, 1000),
        _stat("C60x", "Ruy Lopez: Morphy Defense", _SIX_PLY, 50_000),
    ]
    ranked = rank_families(line_stats)
    assert len(ranked) == 1
    assert ranked[0].name == "Ruy Lopez"
    assert ranked[0].line.name == "Ruy Lopez: Morphy Defense"
    assert ranked[0].games == 50_000


def test_rank_families_a_subvariation_is_a_valid_representative_with_no_bare_row():
    # No bare-name row at all for this family -- its only row is a named
    # sub-variation, which is a perfectly good representative (Task 20b).
    line_stats = [_stat("C60x", "Ruy Lopez: Morphy Defense", _SIX_PLY, 50_000)]
    ranked = rank_families(line_stats)
    assert len(ranked) == 1
    assert ranked[0].name == "Ruy Lopez"
    assert ranked[0].line.name == "Ruy Lopez: Morphy Defense"


def test_rank_families_picks_the_most_played_qualifying_row_in_the_family():
    # Mixed bare and colon-named rows at various ply depths; only the
    # 6- and 7-ply ones qualify, and the 7-ply one has more games.
    line_stats = [
        _stat("C60a", "Ruy Lopez", _FIVE_PLY, 90_000),
        _stat("C60b", "Ruy Lopez", _SIX_PLY, 1_000),
        _stat("C60c", "Ruy Lopez: Morphy Defense", _SEVEN_PLY, 5_000),
    ]
    ranked = rank_families(line_stats)
    assert len(ranked) == 1
    assert ranked[0].games == 5_000
    assert ranked[0].line.moves == tuple(_SEVEN_PLY)


def test_rank_families_rank_1_is_most_played():
    line_stats = [
        _stat("A", "Alpha", _SIX_PLY, 100),
        _stat("B", "Beta", _SIX_PLY, 300),
        _stat("C", "Gamma", _SIX_PLY, 200),
    ]
    ranked = rank_families(line_stats)
    assert [f.name for f in ranked] == ["Beta", "Gamma", "Alpha"]
    assert ranked[0].rank == 1


def test_rank_families_excludes_configured_umbrella_families():
    # Task 20b: excluded by name, regardless of games -- not derived
    # from the data by a rule (this family would easily qualify
    # otherwise: a bare 6-ply row with plenty of games).
    line_stats = [_stat("C00", "King's Pawn Game", _SIX_PLY, 1_000_000)]
    assert rank_families(line_stats) == []


def test_rank_families_excluded_families_list_can_be_overridden():
    line_stats = [
        _stat("C60", "Ruy Lopez", _SIX_PLY, 1000),
        _stat("B01", "Scandinavian Defense", _SIX_PLY, 2000),
    ]
    ranked = rank_families(line_stats, excluded_families=frozenset({"Scandinavian Defense"}))
    assert [f.name for f in ranked] == ["Ruy Lopez"]


def test_kings_pawn_game_is_unranked_with_real_data():
    line_stats = load_line_stats(OPENINGS_DIR / "line_stats.json")
    names = {f.name for f in rank_families(line_stats)}
    assert "King's Pawn Game" not in names
    assert "Queen's Pawn Game" not in names
    assert "King's Knight Opening" not in names
    assert "Indian Defense" not in names


def test_sicilian_is_rank_1_with_real_data():
    line_stats = load_line_stats(OPENINGS_DIR / "line_stats.json")
    ranked = rank_families(line_stats)
    assert ranked[0].name == "Sicilian Defense"
    assert ranked[0].rank == 1


def test_ruy_lopez_representative_is_morphy_defense_with_real_data():
    line_stats = load_line_stats(OPENINGS_DIR / "line_stats.json")
    ranked = {f.name: f for f in rank_families(line_stats)}
    ruy_lopez = ranked["Ruy Lopez"]
    assert ruy_lopez.line.name == "Ruy Lopez: Morphy Defense"
    assert ruy_lopez.line.moves == ("e4", "e5", "Nf3", "Nc6", "Bb5", "a6")


def test_about_85_or_more_families_rank_with_real_data():
    line_stats = load_line_stats(OPENINGS_DIR / "line_stats.json")
    assert len(rank_families(line_stats)) >= 85


def test_the_top_9_families_are_pinned_in_order_with_real_data():
    line_stats = load_line_stats(OPENINGS_DIR / "line_stats.json")
    ranked = rank_families(line_stats)
    assert [f.name for f in ranked[:9]] == [
        "Sicilian Defense",
        "Scotch Game",
        "Caro-Kann Defense",
        "Scandinavian Defense",
        "Italian Game",
        "French Defense",
        "Ruy Lopez",
        "Queen's Gambit Declined",
        "Nimzo-Indian Defense",
    ]


# --- family / variation split (Task 15) --------------------------------------

def test_split_family_with_a_colon():
    name = "Ruy Lopez: Berlin Defense, Rio Gambit Accepted"
    assert split_family(name) == ("Ruy Lopez", "Berlin Defense, Rio Gambit Accepted")


def test_split_family_with_no_colon_has_no_variation():
    assert split_family("Ruy Lopez") == ("Ruy Lopez", "")


def test_continuing_lines_empty_when_nothing_matches():
    assert continuing_lines(("Qzz9",), BOOK) == []  # not a real SAN token; no line starts with it
