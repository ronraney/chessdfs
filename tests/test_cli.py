import json
import random
from pathlib import Path

import chess

import dfs_chess.cli as cli
from dfs_chess.config import ContestConfig
from dfs_chess.models import BuildState, Move, Piece, Player, Side
from dfs_chess.openings import BookLine, RankedFamily
from dfs_chess.rules import apply_capture_move, apply_move
from dfs_chess.sport import load_sport_config

REPO_ROOT = Path(__file__).resolve().parent.parent
NFL = load_sport_config(REPO_ROOT / "config" / "sports" / "nfl.json")
CONTEST = ContestConfig(field_size=1000, payouts=[])


def _player(id_: str, pos: str, salary: int, proj: float = 10.0) -> Player:
    return Player(
        id=id_, name=id_, positions=(pos,), team="AAA", opp="BBB",
        salary=salary, proj=proj, own_small=0.2, own_large=0.2,
    )

# A tiny 2-slot sport (any one position, "ANY") so a build completes in
# just two White picks -- the CLI itself always defaults to the real NFL
# sport config (no --sport flag exists, per the task), so this patches
# that default for the test rather than hand-scripting a realistic 9-pick
# NFL build through an unpredictable number of Black auto-replies.
TOY_SPORT = {
    "sport": "TOY",
    "salary_cap": 50000,
    "piece_bands": [{"piece": "PAWN", "positions": None, "min_salary": None, "max_salary": None}],
    "roster_slots": [{"name": "ANY", "positions": ["ANY"], "count": 2}],
}


def _write_fixtures(tmp_path):
    sport_path = tmp_path / "toy_sport.json"
    sport_path.write_text(json.dumps(TOY_SPORT))

    etr_path = tmp_path / "etr.csv"
    etr_path.write_text(
        "DK_ID,Player,DK Pos,Team,Opp,DK Salary,DK Proj,Small Field,Large Field\n"
        'p0,Player A,ANY,AAA,BBB,"$1,000",10.0,10.00%,10.00%\n'
        'p1,Player B,ANY,AAA,BBB,"$1,000",9.0,10.00%,10.00%\n'
        'p2,Player C,ANY,AAA,BBB,"$1,000",8.0,10.00%,10.00%\n'
        'p3,Player D,ANY,AAA,BBB,"$1,000",7.0,10.00%,10.00%\n'
    )

    contest_path = tmp_path / "contest.json"
    contest_path.write_text(json.dumps({"field_size": 1000, "payouts": []}))

    return sport_path, etr_path, contest_path


def _scripted_input(responses):
    queue = iter(responses)

    def fake_input(prompt: str = "") -> str:
        try:
            return next(queue)
        except StopIteration:
            raise EOFError("scripted input exhausted") from None

    return fake_input


def test_scripted_run_with_fixed_seed_completes_a_build_without_errors(tmp_path, monkeypatch, capsys):
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)

    # Discovered experimentally for seed 42: White's two pawn pushes
    # complete the 2-slot toy roster, with one real Black auto-reply
    # (Owen Defense, 1...b6) in between. The leading "" declines the
    # King-mode prompt (Task 14 -- defaults to "emerge"); "p" declines
    # the opening-setup screen's suggestion (Task 20) -- free play, as
    # this test has always exercised.
    fake_input = _scripted_input(["", "p", "e4", "1", "d4", "1"])

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "Happy Hunting" in out
    assert "Black plays" in out
    assert "Total salary: $2,000" in out


def _write_synthetic_opening_fixtures(tmp_path):
    """A one-line synthetic book + matching line_stats.json (Task 15's
    setup list is driven by line_stats.json, not the book TSVs directly)
    so the template's exact continuations stay known and controllable --
    the real book's named lines almost all include a non-pawn move
    within a move or two, which TOY_SPORT's all-PAWN player pool can
    never fill.
    """
    openings_dir = tmp_path / "openings"
    openings_dir.mkdir()
    (openings_dir / "test.tsv").write_text("eco\tname\tpgn\nX00\tTest Pawn Line\t1. c4 c5\n")
    (openings_dir / "line_stats.json").write_text(
        json.dumps(
            {
                "_meta": {},
                "lines": [
                    {
                        "eco": "X00",
                        "name": "Test Pawn Line",
                        "moves": ["c4", "c5"],
                        "games": 100,
                        "white_rate": 0.4,
                        "draw_rate": 0.2,
                        "black_rate": 0.4,
                    }
                ],
            }
        )
    )
    return openings_dir


def test_setup_list_pick_drives_both_sides_then_falls_to_free_play(tmp_path, monkeypatch, capsys):
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)
    openings_dir = _write_synthetic_opening_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_OPENINGS_DIR", openings_dir)

    fake_input = _scripted_input(
        [
            "",  # declines the King-mode prompt (Task 14) -- defaults to "emerge"
            # The one-line synthetic template is too short to rank (Task
            # 20 needs 6+ plies), so there's no numbered list/suggestion
            # at all -- it's found by name via search instead.
            "s",
            "Test Pawn Line",
            "1",  # the only match -> active template
            "1",  # White's player pick for the template's c4 (highest proj: Player A)
            # Black's c5 is auto-picked (highest proj, no prompt) -- the
            # template then ends (ran out, not DFS-illegal); the
            # continuation picker has nothing to offer (one-line book),
            # so it's the Task 13b book-exit prompt next.
            "continue",  # continue = free play
            "d4",
            "1",  # White's player pick for d4 (highest proj left: Player C)
        ]
    )

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "Test Pawn Line" in out
    assert "Black plays c5" in out
    assert "The opening template has ended." in out
    assert "There is no longer an opening line." in out
    assert "Happy Hunting" in out
    assert "Total salary: $2,000" in out


def test_setup_list_pages_real_data_at_pick_list_page_size(tmp_path, monkeypatch, capsys):
    # Uses the real, vendored data/openings/ (far more than
    # PICK_LIST_PAGE_SIZE families rank) -- the setup screen's main list
    # must show exactly PICK_LIST_PAGE_SIZE numbered entries on the
    # first page, not more or fewer. Declines the suggestion -> free
    # play, then completes the same 2-slot TOY_SPORT build as the
    # simplest scripted-run test.
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)

    fake_input = _scripted_input(["", "p", "e4", "1", "d4", "1"])

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert f"  {cli.PICK_LIST_PAGE_SIZE}. " in out
    assert f"  {cli.PICK_LIST_PAGE_SIZE + 1}. " not in out


def _write_ranked_opening_fixtures(tmp_path):
    """A single bare-name, 6-ply (Task 20's minimum), all-pawn line --
    unlike `_write_synthetic_opening_fixtures`'s 2-ply one, this
    actually ranks (rank 1, the only family at all), so it's reachable
    by number or 'r' Random -- not just search.
    """
    openings_dir = tmp_path / "openings"
    openings_dir.mkdir()
    (openings_dir / "test.tsv").write_text(
        "eco\tname\tpgn\nX00\tTest Random Line\t1. c4 c5 2. a4 a5 3. b4 b5\n"
    )
    (openings_dir / "line_stats.json").write_text(
        json.dumps(
            {
                "_meta": {},
                "lines": [
                    {
                        "eco": "X00",
                        "name": "Test Random Line",
                        "moves": ["c4", "c5", "a4", "a5", "b4", "b5"],
                        "games": 100,
                        "white_rate": 0.4,
                        "draw_rate": 0.2,
                        "black_rate": 0.4,
                    }
                ],
            }
        )
    )
    return openings_dir


def test_setup_list_random_picks_one_of_the_offered_variations(tmp_path, monkeypatch, capsys):
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)
    openings_dir = _write_ranked_opening_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_OPENINGS_DIR", openings_dir)

    # "r" Random, with only one ranked family, is a sure thing. White's
    # 2nd pick (the template's own "a4", ply 3) completes the 2-slot
    # TOY_SPORT roster immediately -- the build never reaches the rest
    # of the 6-ply line, so there's nothing further to script.
    fake_input = _scripted_input(
        [
            "",  # decline King-mode prompt -- "emerge"
            "r",  # Random
            "1",  # White's player pick for c4
            "1",  # White's player pick for a4 -- completes the roster
        ]
    )

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "Test Random Line" in out
    assert "Happy Hunting" in out


def test_format_piece_sequence_collapses_king_rook_pair_to_castle():
    assert cli._format_piece_sequence((Piece.PAWN, Piece.KNIGHT, Piece.BISHOP)) == "Pawn, Knight, Bishop"
    assert cli._format_piece_sequence((Piece.PAWN, Piece.KING, Piece.ROOK, Piece.PAWN)) == "Pawn, Castle, Pawn"


def test_setup_list_shows_whites_piece_sequence(tmp_path, monkeypatch, capsys):
    # Task 17: the setup list shows each option's piece-type sequence
    # for White, e.g. "Pawn, Knight". A Knight-requiring line is fine to
    # merely *display* under TOY_SPORT (whose pool can't actually play
    # it) since this test never picks it -- it only checks what the
    # setup screen prints before falling to free play.
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)

    openings_dir = tmp_path / "openings"
    openings_dir.mkdir()
    # 6 plies (Task 20's minimum to rank a bare-name family) -- White's
    # pieces are still Pawn, Knight, ... as the test's own name/assertion
    # expect; the extra Bishop plies are irrelevant to the display being
    # checked here (and are never actually played -- declined below).
    (openings_dir / "test.tsv").write_text(
        "eco\tname\tpgn\nX01\tTest Knight Line\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5\n"
    )
    (openings_dir / "line_stats.json").write_text(
        json.dumps(
            {
                "_meta": {},
                "lines": [
                    {
                        "eco": "X01",
                        "name": "Test Knight Line",
                        "moves": ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"],
                        "games": 100,
                        "white_rate": 0.4,
                        "draw_rate": 0.2,
                        "black_rate": 0.4,
                    }
                ],
            }
        )
    )
    monkeypatch.setattr(cli, "DEFAULT_OPENINGS_DIR", openings_dir)

    fake_input = _scripted_input(["", "p", "e4", "1", "d4", "1"])

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "Test Knight Line" in out
    assert "Pawn, Knight" in out


def test_setup_list_no_opening_data_offers_only_free_play(tmp_path, monkeypatch, capsys):
    # No line_stats.json at all (e.g. a fresh checkout) -- the setup
    # screen must not crash, and must fall straight to free play on a
    # blank response since there's nothing to rank.
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)
    openings_dir = tmp_path / "openings"
    openings_dir.mkdir()
    (openings_dir / "test.tsv").write_text("eco\tname\tpgn\nX00\tTest Pawn Line\t1. c4 c5\n")
    monkeypatch.setattr(cli, "DEFAULT_OPENINGS_DIR", openings_dir)

    fake_input = _scripted_input(["", "", "e4", "1", "d4", "1"])

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "(Play your own opening)" in out
    assert "Choose an opening:" not in out  # nothing to rank -- no numbered list
    assert "Happy Hunting" in out


def test_opening_setup_enter_accepts_the_suggestion():
    # Task 20: a blank response accepts the suggested opening (the
    # ranked family at the contest's target rank) directly, rather than
    # falling to free play (Task 15's old behavior).
    line_stats = [
        {
            "eco": "C60",
            "name": "Ruy Lopez",
            "moves": ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"],
            "games": 1000,
            "white_rate": 0.4,
            "draw_rate": 0.2,
            "black_rate": 0.4,
        }
    ]
    fake_input = _scripted_input([""])

    chosen = cli._prompt_for_opening_setup(line_stats, [], CONTEST, NFL, random.Random(1), fake_input)

    assert chosen is not None
    assert chosen.name == "Ruy Lopez"
    assert chosen.moves == ("e4", "e5", "Nf3", "Nc6", "Bb5", "a6")


def test_ordered_opening_rows_tags_an_off_tier_family():
    # Task 20: a family outside the contest's own tier gets a quiet tag
    # (e.g. "XL-style") in the merged, tier-grouped list; one inside it
    # gets none.
    home = RankedFamily(
        name="Home Family",
        rank=1,
        games=100,
        line=BookLine(eco="H", name="Home Family", moves=("d4", "d5", "c4", "c6", "Nc3", "Nf6")),
    )
    deep = RankedFamily(
        name="Deep Family",
        rank=61,  # XL's own low bound by default (61-last)
        games=1,
        line=BookLine(eco="D", name="Deep Family", moves=("e4", "e5", "Nf3", "Nc6", "Bb5", "a6")),
    )
    last_rank = 61
    contest = ContestConfig(field_size=1000, payouts=[])  # Small tier (ranks 1-9)
    own_tier = contest.entry_tier(last_rank)
    assert own_tier.name == "Small"

    rows = cli._ordered_opening_rows([home, deep], contest, own_tier, last_rank)

    tags = {family.name: tag for family, tag in rows}
    assert tags["Home Family"] is None
    assert tags["Deep Family"] == "XL-style"


def test_illegal_move_and_illegal_pick_are_handled_without_crashing(tmp_path, monkeypatch, capsys):
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)

    fake_input = _scripted_input(
        [
            "",  # declines the King-mode prompt (Task 14) -- defaults to "emerge"
            "p",  # declines the opening setup's suggestion (Task 20) -- free play
            "not a move",  # invalid SAN -> should say why and re-prompt
            "e4",
            "99",  # out-of-range pick -> should say why and re-prompt
            "1",
            "d4",
            "1",
        ]
    )

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "Illegal move" in out
    assert "Not a valid choice" in out
    assert "Happy Hunting" in out


def test_dead_end_is_reported_and_build_stops_without_crashing(tmp_path, monkeypatch, capsys):
    sport_path, _, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)

    # An ETR pool whose only position ("OTHER") doesn't match the toy
    # sport's one slot ("ANY") -- every legal move's classify-eligible
    # candidates all fail the roster/slot check, so White has no move at
    # all, on the very first turn.
    etr_path = tmp_path / "etr_no_fits.csv"
    etr_path.write_text(
        "DK_ID,Player,DK Pos,Team,Opp,DK Salary,DK Proj,Small Field,Large Field\n"
        'p0,Player X,OTHER,AAA,BBB,"$1,000",10.0,10.00%,10.00%\n'
    )

    # The King-mode prompt (Task 14) and the opening-template search
    # (Task 13) are always the first two prompts, regardless of board
    # state -- "" declines both (emerge / free play). Nothing past that
    # should ever be read, since White has no legal move on the very
    # first turn; `_scripted_input` raises EOFError if it is.
    fake_input = _scripted_input(["", ""])

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "You have hit a dead end." in out
    assert "The build process is done. Happy Hunting." in out
    assert "Open slots: ANY x2" in out
    assert "Your final lineup:" not in out  # the normal-completion path, not taken


# --- Task 13b --------------------------------------------------------------

def test_template_player_pick_back_out_reprompts_instead_of_ending_template():
    candidates = [_player("p1", "WR", 3000), _player("p2", "WR", 3100, proj=11.0)]
    fake_input = _scripted_input(["b", "2"])  # 'b' no longer ends the template

    chosen = cli._prompt_player_choice(candidates, CONTEST, 0.0, "Bishop", fake_input, allow_cancel=False)

    assert chosen is candidates[1]


def test_prompt_for_continuation_excludes_a_dfs_illegal_line(capsys):
    ok_line = BookLine(eco="X1", name="OK Line", moves=("e4", "e5"))
    # Needs a Knight-band pick; the pool below has none, so this is
    # DFS-illegal and must not be offered (Task 13b: same feasibility
    # check as Black's own book choices).
    illegal_line = BookLine(eco="X2", name="Illegal Line", moves=("Nf3", "Nc6"))
    book = [ok_line, illegal_line]
    pool = [_player("w1", "WR", 3000)]  # Pawn-band only

    fake_input = _scripted_input(["1"])
    chosen = cli._prompt_for_continuation(BuildState(), (), book, NFL, CONTEST, pool, fake_input)

    out = capsys.readouterr().out
    assert "OK Line" in out
    assert "Illegal Line" not in out
    assert chosen is ok_line


def test_prompt_for_continuation_book_exit_continue_means_free_play(capsys):
    fake_input = _scripted_input(["continue"])

    result = cli._prompt_for_continuation(BuildState(), (), [], NFL, CONTEST, [], fake_input)

    out = capsys.readouterr().out
    assert "There is no longer an opening line." in out
    assert result is None


def test_prompt_for_continuation_book_exit_start_again_returns_restart_sentinel():
    fake_input = _scripted_input(["again"])

    result = cli._prompt_for_continuation(BuildState(), (), [], NFL, CONTEST, [], fake_input)

    assert result is cli.RESTART_BUILD


def test_start_again_at_book_exit_restarts_a_brand_new_build(tmp_path, monkeypatch, capsys):
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)
    openings_dir = _write_synthetic_opening_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_OPENINGS_DIR", openings_dir)

    fake_input = _scripted_input(
        [
            "",  # Build 1: decline King-mode prompt (Task 14) -- "emerge"
            # Build 1: the one-line synthetic template is too short to
            # rank (Task 20 needs 6+ plies), so it's found by name via
            # search; let it run out (one-line book -> no continuations),
            # then restart.
            "s",
            "Test Pawn Line",
            "1",
            "1",  # White's player pick for c4
            "again",  # book-exit prompt -> start a brand new build
            # Build 2: decline King-mode prompt again (re-asked per build),
            # then free play from scratch, completes normally.
            "",
            "",
            "e4",
            "1",
            "d4",
            "1",
        ]
    )

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    # Task 14: restart uses a fresh seed -- with --seed N, N+1 per restart.
    assert "Seed: 42" in out
    assert "Seed: 43" in out
    assert "There is no longer an opening line." in out
    assert "Happy Hunting" in out
    assert "Total salary: $2,000" in out


def test_stopping_with_a_core_ends_the_build_cleanly(tmp_path, monkeypatch, capsys):
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)

    fake_input = _scripted_input(
        [
            "",  # decline King-mode prompt (Task 14) -- "emerge"
            "p",  # decline the opening setup's suggestion (Task 20) -- free play
            "e4",
            "1",  # one White pick locked (Player A, $1,000)
            "stop",  # end early, before the 2-slot roster is full
        ]
    )

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "Happy Hunting" in out
    assert "Your final lineup:" in out
    assert "Total salary: $1,000" in out  # only the one pick -- stopped before the second


def test_black_dead_end_ends_the_build_with_the_right_message(tmp_path, monkeypatch, capsys):
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)

    def _no_legal_move(*args, **kwargs):
        raise RuntimeError("Black has no legal move available")

    monkeypatch.setattr(cli, "play_black_move", _no_legal_move)

    fake_input = _scripted_input(["", "", "e4", "1"])  # decline King-mode, decline template; White's only move

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "Black has hit a dead end." in out
    assert "The build process is done. Happy Hunting." in out
    assert "Open slots: ANY x1" in out  # White locked 1 of 2 -- still incomplete
    assert "Your final lineup:" not in out


def test_salary_and_ownership_table_matches_locked_players():
    white_pick = _player("w1", "WR", 3000, proj=10.0)
    black_pick = _player("b1", "TE", 4600, proj=12.0)
    state = BuildState(
        white_moves=[Move(side=Side.WHITE, piece=Piece.PAWN, san="e4", player=white_pick)],
        black_moves=[Move(side=Side.BLACK, piece=Piece.KNIGHT, san="Nc6", player=black_pick)],
    )

    table = cli.format_salary_ownership_table(state, NFL, CONTEST)

    tier = CONTEST.field_tier()
    expected_white_remaining = CONTEST.effective_cap(NFL) - white_pick.salary
    expected_black_remaining = CONTEST.effective_cap(NFL) - black_pick.salary
    expected_white_own = white_pick.own_for(tier) * 100
    expected_black_own = black_pick.own_for(tier) * 100

    assert f"${expected_white_remaining:,}" in table
    assert f"${expected_black_remaining:,}" in table
    assert f"{expected_white_own:.1f}%" in table
    assert f"{expected_black_own:.1f}%" in table


# --- projection totals (Task 16) ---------------------------------------------

def test_proj_total_matches_sum_of_locked_players():
    white_a = _player("w1", "WR", 3000, proj=10.0)
    white_b = _player("w2", "TE", 4600, proj=7.5)
    black_a = _player("b1", "RB", 5200, proj=12.0)
    state = BuildState(
        white_moves=[
            Move(side=Side.WHITE, piece=Piece.PAWN, san="e4", player=white_a),
            Move(side=Side.WHITE, piece=Piece.KNIGHT, san="Nc3", player=white_b),
        ],
        black_moves=[Move(side=Side.BLACK, piece=Piece.ROOK, san="Nc6", player=black_a)],
    )

    assert cli.proj_total(state, Side.WHITE) == 17.5
    assert cli.proj_total(state, Side.BLACK) == 12.0


def test_salary_ownership_table_shows_projection_totals():
    white_pick = _player("w1", "WR", 3000, proj=10.0)
    black_pick = _player("b1", "TE", 4600, proj=12.0)
    state = BuildState(
        white_moves=[Move(side=Side.WHITE, piece=Piece.PAWN, san="e4", player=white_pick)],
        black_moves=[Move(side=Side.BLACK, piece=Piece.KNIGHT, san="Nc6", player=black_pick)],
    )

    table = cli.format_salary_ownership_table(state, NFL, CONTEST)

    assert "Core projection: 10.0 pts" in table
    assert "Core projection: 12.0 pts" in table


def test_prompt_player_choice_preview_equals_base_plus_candidate_projection(capsys):
    candidates = [_player("p1", "WR", 3000, proj=8.0), _player("p2", "WR", 3100, proj=11.0)]
    fake_input = _scripted_input(["1"])

    cli._prompt_player_choice(candidates, CONTEST, 25.0, "Bishop", fake_input)

    out = capsys.readouterr().out
    assert "-> 33.0 total pts" in out  # preview_base (25.0) + p1's own 8.0
    assert "-> 36.0 total pts" in out  # preview_base (25.0) + p2's own 11.0


def test_ending_shows_whites_final_projection_total(capsys):
    white_a = _player("w1", "WR", 3000, proj=10.0)
    white_b = _player("w2", "TE", 4600, proj=7.5)
    state = BuildState(
        white_moves=[
            Move(side=Side.WHITE, piece=Piece.PAWN, san="e4", player=white_a),
            Move(side=Side.WHITE, piece=Piece.KNIGHT, san="Nc3", player=white_b),
        ],
    )

    cli._print_ending(state, CONTEST)

    out = capsys.readouterr().out
    assert "Total projection: 17.5 pts" in out


def test_capture_moves_the_captured_players_projection_between_sides():
    # Task 18: the captured player IS the capturing move's pick -- no
    # separate new pick for the capturing pawn itself.
    w_pawn1 = _player("w_pawn1", "WR", 3000, proj=9.0)
    b_pawn1 = _player("b_pawn1", "WR", 3000, proj=6.0)

    state = apply_move(BuildState(), chess.Move.from_uci("e2e4"), w_pawn1, NFL, CONTEST)
    state = apply_move(state, chess.Move.from_uci("d7d5"), b_pawn1, NFL, CONTEST)
    before_white = cli.proj_total(state, Side.WHITE)
    assert before_white == 9.0
    assert cli.proj_total(state, Side.BLACK) == 6.0

    capture_move = chess.Move.from_uci("e4d5")
    assert state.board.is_capture(capture_move)
    new_state = apply_capture_move(state, capture_move, NFL, CONTEST)

    # White keeps everything already locked (w_pawn1) plus b_pawn1's
    # projection, transferred over; Black loses exactly that much --
    # nothing invented or lost.
    assert cli.proj_total(new_state, Side.WHITE) == before_white + b_pawn1.proj
    assert cli.proj_total(new_state, Side.BLACK) == 0.0


# --- play-test fixes (Task 18) ------------------------------------------------

def _write_capture_template_fixtures(tmp_path):
    """A one-line synthetic template -- 1. e4 d5 2. exd5 -- so both
    sides' moves are fully determined: White's e4 is a normal pick
    (Player A), Black's d5 auto-picks (Player B, template placeholder),
    and White's exd5 is a capture, with no reliance on Black's own
    book-choice heuristics picking an unpredictable reply.
    """
    openings_dir = tmp_path / "openings"
    openings_dir.mkdir()
    (openings_dir / "test.tsv").write_text("eco\tname\tpgn\nX00\tTest Capture Line\t1. e4 d5 2. exd5\n")
    (openings_dir / "line_stats.json").write_text(
        json.dumps(
            {
                "_meta": {},
                "lines": [
                    {
                        "eco": "X00",
                        "name": "Test Capture Line",
                        "moves": ["e4", "d5", "exd5"],
                        "games": 100,
                        "white_rate": 0.4,
                        "draw_rate": 0.2,
                        "black_rate": 0.4,
                    }
                ],
            }
        )
    )
    return openings_dir


def test_capture_through_the_cli_prompts_for_no_pick_and_completes_the_build(tmp_path, monkeypatch, capsys):
    # 1. e4 (locks Player A) d5 (Black auto-locks Player B) 2. exd5 --
    # under the new capture rule, exd5 needs no pick prompt at all: it
    # just transfers Player B to White, completing the 2-slot roster
    # (Player A + Player B) immediately.
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)
    openings_dir = _write_capture_template_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_OPENINGS_DIR", openings_dir)

    # Decline King-mode; the 3-ply line is too short to rank (Task 20
    # needs 6+ plies), so it's found by name via search instead of a
    # numbered pick; then White's e4 pick.
    fake_input = _scripted_input(["", "s", "Test Capture Line", "1", "1"])

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "Eligible Pawn players" in out  # White's e4 pick did prompt
    # No second "Eligible Pawn players" prompt for the capture itself.
    assert out.count("Eligible Pawn players") == 1
    assert "Happy Hunting" in out
    assert "Total salary: $2,000" in out  # Player A + the captured Player B


def test_capture_message_names_the_captured_player(tmp_path, monkeypatch, capsys):
    sport_path, etr_path, contest_path = _write_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)
    openings_dir = _write_capture_template_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_OPENINGS_DIR", openings_dir)

    fake_input = _scripted_input(["", "s", "Test Capture Line", "1", "1"])

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "You play exd5, capturing the Field's Player B." in out


def test_capture_of_an_unmoved_pawn_prompts_a_pawn_pick_and_adds_one_player(capsys):
    # Task 19: White's queen captures Black's f7 pawn (classic Scholar's
    # Mate pattern) -- f7 never had a locked player (no lock history),
    # so the capturing side picks a Pawn instead of transferring one.
    board = chess.Board()
    for san in ("e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6"):
        board.push_san(san)
    state = BuildState(board=board)
    capture_move = board.parse_san("Qxf7+")
    assert board.is_capture(capture_move)
    expected_san = board.san(capture_move)

    pawn_pool = [_player(f"p{i}", "WR", 3000 + i, proj=float(10 - i)) for i in range(3)]
    fake_input = _scripted_input(["1"])

    result = cli._play_capture_move(state, capture_move, NFL, CONTEST, pawn_pool, [], fake_input, allow_cancel=True)

    out = capsys.readouterr().out
    assert f"You play {expected_san}, capturing an unmoved pawn: pick a Pawn." in out
    assert "Eligible Pawn players" in out

    assert result is not None
    assert len(result.state.white_moves) == 1
    assert result.state.white_moves[0].player.id == "p0"
    assert result.state.white_moves[0].piece is Piece.PAWN


def test_capture_of_an_unmoved_knight_prompts_a_knight_pick(capsys):
    # Task 19: White's bishop captures Black's knight, still on its
    # home square g8 (White only develops its OTHER knight) -- no lock
    # history, so the capturing side picks a Knight.
    board = chess.Board()
    for san in ("e4", "f6", "Bc4", "Nc6"):
        board.push_san(san)
    state = BuildState(board=board)
    capture_move = board.parse_san("Bxg8")
    assert board.is_capture(capture_move)
    expected_san = board.san(capture_move)

    knight_pool = [_player(f"te{i}", "TE", 4600 + i, proj=float(10 - i)) for i in range(3)]
    fake_input = _scripted_input(["1"])

    result = cli._play_capture_move(state, capture_move, NFL, CONTEST, knight_pool, [], fake_input, allow_cancel=True)

    out = capsys.readouterr().out
    assert f"You play {expected_san}, capturing an unmoved knight: pick a Knight." in out
    assert "Eligible Knight players" in out

    assert result is not None
    assert len(result.state.white_moves) == 1
    assert result.state.white_moves[0].player.id == "te0"
    assert result.state.white_moves[0].piece is Piece.KNIGHT


FOUR_SLOT_TOY_SPORT = {
    "sport": "TOY4",
    "salary_cap": 50000,
    "piece_bands": [{"piece": "PAWN", "positions": None, "min_salary": None, "max_salary": None}],
    "roster_slots": [{"name": "ANY", "positions": ["ANY"], "count": 4}],
}


def _write_never_moved_capture_fixtures(tmp_path):
    """A 4-slot toy sport/template (rather than the 2-slot `TOY_SPORT`
    other capture fixtures use) so White's build doesn't complete before
    reaching the capture: 1. e4 a6 2. e5 a5 3. e6 a4 4. exf7 -- White's
    e4/e5/e6 are three ordinary picks, and Black's own a-pawn shuffles
    leave its f7 pawn (captured on White's 4th and final pick) with no
    lock history at all.
    """
    sport_path = tmp_path / "toy4_sport.json"
    sport_path.write_text(json.dumps(FOUR_SLOT_TOY_SPORT))

    etr_path = tmp_path / "etr.csv"
    etr_path.write_text(
        "DK_ID,Player,DK Pos,Team,Opp,DK Salary,DK Proj,Small Field,Large Field\n"
        + "".join(
            f'p{i},Player {chr(65 + i)},ANY,AAA,BBB,"$1,000",{20 - i}.0,10.00%,10.00%\n' for i in range(8)
        )
    )

    contest_path = tmp_path / "contest.json"
    contest_path.write_text(json.dumps({"field_size": 1000, "payouts": []}))

    openings_dir = tmp_path / "openings"
    openings_dir.mkdir()
    (openings_dir / "test.tsv").write_text(
        "eco\tname\tpgn\nX00\tTest Never-Moved Pawn Capture\t1. e4 a6 2. e5 a5 3. e6 a4 4. exf7\n"
    )
    (openings_dir / "line_stats.json").write_text(
        json.dumps(
            {
                "_meta": {},
                "lines": [
                    {
                        "eco": "X00",
                        "name": "Test Never-Moved Pawn Capture",
                        "moves": ["e4", "a6", "e5", "a5", "e6", "a4", "exf7"],
                        "games": 100,
                        "white_rate": 0.4,
                        "draw_rate": 0.2,
                        "black_rate": 0.4,
                    }
                ],
            }
        )
    )

    return sport_path, etr_path, contest_path, openings_dir


def test_capture_of_an_unmoved_pawn_through_the_cli_end_to_end(tmp_path, monkeypatch, capsys):
    # Live, full `cli.run()` exercise of Task 19 (not just a direct
    # `_play_capture_move` call): White marches a pawn to e6 while Black
    # shuffles its a-pawn, then exf7 captures Black's never-moved f7
    # pawn -- White's 4th and final pick, completing the 4-slot roster.
    sport_path, etr_path, contest_path, openings_dir = _write_never_moved_capture_fixtures(tmp_path)
    monkeypatch.setattr(cli, "DEFAULT_SPORT_PATH", sport_path)
    monkeypatch.setattr(cli, "DEFAULT_OPENINGS_DIR", openings_dir)

    # Decline King mode; pick the template; then one pick each for e4, e5,
    # e6, and finally the never-moved-pawn capture's own Pawn pick.
    fake_input = _scripted_input(["", "1", "1", "1", "1", "1"])

    cli.run(etr_path, contest_path, seed=42, input_func=fake_input)

    out = capsys.readouterr().out
    assert "You play exf7+, capturing an unmoved pawn: pick a Pawn." in out  # exf7 also checks the king
    assert out.count("Eligible Pawn players") == 4  # e4, e5, e6, and the capture's own pick
    assert "Happy Hunting" in out
    assert "Total salary: $4,000" in out  # 4 picks @ $1,000 each


def test_prompt_player_choice_shows_only_15_initially(capsys):
    candidates = [_player(f"p{i}", "WR", 3000 + i, proj=float(20 - i)) for i in range(20)]
    fake_input = _scripted_input(["1"])

    cli._prompt_player_choice(candidates, CONTEST, 0.0, "Bishop", fake_input)

    out = capsys.readouterr().out
    assert "  15. p14 |" in out
    assert "  16. p15 |" not in out  # page 2 not shown yet


def test_prompt_player_choice_more_reveals_next_page_with_stable_numbering(capsys):
    candidates = [_player(f"p{i}", "WR", 3000 + i, proj=float(20 - i)) for i in range(20)]
    fake_input = _scripted_input(["m", "16"])

    chosen = cli._prompt_player_choice(candidates, CONTEST, 0.0, "Bishop", fake_input)

    out = capsys.readouterr().out
    assert "  16. p15 |" in out
    assert chosen is candidates[15]  # #16 is still candidates[15] -- numbering never shifted


def test_prompt_player_choice_search_by_name_keeps_original_numbering(capsys):
    candidates = [_player(f"p{i}", "WR", 3000 + i, proj=float(20 - i)) for i in range(20)]
    fake_input = _scripted_input(["s", "p17", "18"])  # p17 is candidates[17], shown as "18."

    chosen = cli._prompt_player_choice(candidates, CONTEST, 0.0, "Bishop", fake_input)

    out = capsys.readouterr().out
    assert "  18. p17 |" in out
    assert chosen is candidates[17]


def _board_after_sans(*sans: str) -> chess.Board:
    board = chess.Board()
    for san in sans:
        board.push_san(san)
    return board


def test_check_notice_in_turn_header_when_white_is_in_check(capsys):
    # 1. f3 e5 2. g4 Qh4+ -- a real checking move, White to move in check.
    board = _board_after_sans("f3", "e5", "g4", "Qh4+")
    assert board.is_check() and board.turn == chess.WHITE
    state = BuildState(board=board)

    cli._print_turn_header(state, NFL, CONTEST, [])

    assert "You're in check" in capsys.readouterr().out


def test_check_notice_prints_blacks_message(capsys):
    # 1. e4 f6 2. Qh5+ -- f7 vacated opens the h5-e8 diagonal; Black to
    # move, in check.
    board = _board_after_sans("e4", "f6", "Qh5+")
    assert board.is_check() and board.turn == chess.BLACK
    state = BuildState(board=board)

    cli._print_check_notice(state)

    assert "Black is in check" in capsys.readouterr().out


def test_check_notice_silent_when_not_in_check(capsys):
    cli._print_check_notice(BuildState())
    assert capsys.readouterr().out == ""
