// Task 38c: merges App.tsx's old contest/King-mode step and
// OpeningSetupScreen (Task 34) into one screen, matching design/'s combined
// two-column mockup (1-club-setup.png/2-slate-setup.png, club-setup.html/
// slate-setup.html for sizes and spacing) -- Contest card, King mode
// segmented control, Suggested card, and the Explorer panel all visible at
// once, no "Continue" step in between. UI-only: every rank/suggest/random/
// preview/classify call below is the engine's own function (web/src/engine).
//
// Contest is now a <select> (matching the mockups) rather than the old
// button list, and it's internal state here (not a prop) since the whole
// point of the merge is picking it on the same screen as everything else --
// defaults to PRESETS[0], arbitrarily (no "right" default; the mockups'
// own example contest, Mini Gridiron, isn't privileged over any other).
// Changing it re-suggests an opening and resets the tier chip to the new
// contest's own tier, the same "fresh pre-selection" OpeningSetupScreen
// always did on its first mount -- just re-triggered on demand now that
// the contest itself can change after mount instead of being fixed for the
// component's lifetime.
//
// The Explorer's old per-family expand-to-variations accordion is gone:
// the mockups show one flat row per ranked family, already carrying its
// representative line's variation name, full move list, and game count --
// nothing left to expand into. This also removes the performance problem
// Task 38c's own test-timeout fix needed: expanding a deep family (Ruy
// Lopez alone has 235+ book entries) used to render one VariationRow per
// variation, each calling the uncached-per-unique-line `previewFor` (~49ms
// a call per HANDOFF.md) just to show a piece-sequence nobody asked the
// Explorer to show in the first place -- only the Suggested card's own
// single selection still needs a preview at all.
import { useMemo, useState } from "react";
import "./SetupScreen.css";
import {
  BOOK,
  LAST_RANK,
  NFL,
  PRESETS,
  RANKED_FAMILIES,
  RANK_BY_FAMILY,
  previewFor,
  statsFor,
} from "./appData";
import BoardPreview from "./BoardPreview";
import type { ContestPreset } from "./engine/config";
import { KingMode, Piece, type Player } from "./engine/models";
import {
  findOpeningLines,
  randomOpening,
  splitFamily,
  suggestOpening,
  type BookLine,
  type OpeningPreview as OpeningPreviewResult,
} from "./engine/openings";
import { classify } from "./engine/pieces";
import ThemeToggle from "./ThemeToggle";

export type ChosenOpening = { kind: "line"; line: BookLine } | { kind: "own" };

export interface ChosenSetup {
  preset: ContestPreset;
  kingMode: KingMode;
  whiteKing: Player | null;
  blackKing: Player | null;
  opening: ChosenOpening;
}

interface Props {
  players: readonly Player[];
  onChoose: (chosen: ChosenSetup) => void;
}

interface Selection {
  line: BookLine;
  family: string;
  rank: number | null; // null if `family` isn't a ranked family at all (e.g. found only via search)
}

function selectionFor(line: BookLine): Selection {
  const [family] = splitFamily(line.name);
  const ranked = RANK_BY_FAMILY.get(family);
  return { line, family, rank: ranked ? ranked.rank : null };
}

// "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6" -- the design's own move formatting,
// everywhere a line's moves are shown (the Suggested card, every Explorer
// row). BookLine.moves is already a plain SAN array with no move numbers.
function formatMoves(moves: readonly string[]): string {
  const pairs: string[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    const num = i / 2 + 1;
    const black = moves[i + 1];
    pairs.push(black !== undefined ? `${num}. ${moves[i]} ${black}` : `${num}. ${moves[i]}`);
  }
  return pairs.join(" ");
}

const PIECE_LETTER: Record<Piece, string> = {
  [Piece.KING]: "K",
  [Piece.QUEEN]: "Q",
  [Piece.ROOK]: "R",
  [Piece.BISHOP]: "B",
  [Piece.KNIGHT]: "N",
  [Piece.PAWN]: "P",
};

function pieceLetters(pieces: readonly Piece[]): string {
  return pieces.length === 0 ? "—" : pieces.map((p) => PIECE_LETTER[p]).join(" ");
}

function PieceSequence({ preview }: { preview: OpeningPreviewResult }) {
  return (
    <p className="piece-sequence">
      <span>White: {pieceLetters(preview.whitePieces)}</span>
      <span>Black: {pieceLetters(preview.blackPieces)}</span>
    </p>
  );
}

const CHIP_NAMES = ["Small", "Mid", "Large", "XL"] as const;
const ALL_CHIP = "All";
// Same cap/reasoning as Task 34's original MAX_SEARCH_RESULTS: a short
// query can still match hundreds of lines, each row more to render.
const MAX_SEARCH_RESULTS = 20;
const MIN_QUERY_LENGTH = 3;

export default function SetupScreen({ players, onChoose }: Props) {
  const [presetIndex, setPresetIndex] = useState(0);
  const [kingMode, setKingMode] = useState<KingMode>(KingMode.EMERGE);
  const [whiteKingId, setWhiteKingId] = useState<string | null>(null);

  const preset = PRESETS[presetIndex];
  const contestTier = useMemo(() => preset.contest.entryTier(LAST_RANK), [preset]);
  const allTiers = useMemo(() => preset.contest.entryTiers(LAST_RANK), [preset]);
  const tierByName = useMemo(() => new Map(allTiers.map((tier) => [tier.name, tier])), [allTiers]);

  const [chip, setChip] = useState<string>(contestTier.name);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(() => selectionFor(suggestOpening(preset.contest, RANKED_FAMILIES).line));

  const qbs = useMemo(
    () => players.filter((p) => classify(p, NFL) === Piece.KING).sort((a, b) => b.proj - a.proj),
    [players],
  );
  const whiteKing = qbs.find((p) => p.id === whiteKingId) ?? null;
  // cli.py's `_prompt_and_place_kings`: Black's QB is the highest-projection
  // QB other than White's own pick -- not a user choice.
  const blackKing = whiteKing ? qbs.find((p) => p.id !== whiteKing.id) ?? null : null;
  const canPlay = kingMode === KingMode.EMERGE || whiteKing !== null;

  function selectLine(line: BookLine): void {
    setSelection(selectionFor(line));
  }

  function selectPreset(index: number): void {
    setPresetIndex(index);
    const nextPreset = PRESETS[index];
    setChip(nextPreset.contest.entryTier(LAST_RANK).name);
    setSelection(selectionFor(suggestOpening(nextPreset.contest, RANKED_FAMILIES).line));
  }

  function randomPick(): void {
    const tier = chip === ALL_CHIP ? "all" : tierByName.get(chip)!;
    const seed = Math.floor(Math.random() * 2 ** 31);
    selectLine(randomOpening(RANKED_FAMILIES, tier, seed).line);
  }

  function choose(opening: ChosenOpening): void {
    if (!canPlay) return;
    onChoose({ preset, kingMode, whiteKing, blackKing, opening });
  }

  const visibleFamilies = useMemo(() => {
    if (chip === ALL_CHIP) return RANKED_FAMILIES;
    const tier = tierByName.get(chip)!;
    return RANKED_FAMILIES.filter((family) => family.rank >= tier.lowRank && family.rank <= tier.highRank);
  }, [chip, tierByName]);

  // A one- or two-character query can still match hundreds of lines;
  // MIN_QUERY_LENGTH keeps the earliest keystrokes from rendering a huge,
  // practically useless result set.
  const searchResults = useMemo(
    () => (query.trim().length < MIN_QUERY_LENGTH ? null : findOpeningLines(query, BOOK)),
    [query],
  );

  const selectionPreview = useMemo(() => previewFor(selection.line), [selection]);
  const selectionStats = useMemo(() => statsFor(selection.line), [selection]);
  const offTierTag = useMemo(() => {
    if (selection.rank === null) return null;
    const tier = preset.contest.rankTier(selection.rank, LAST_RANK);
    return tier.name === contestTier.name ? null : tier.name;
  }, [selection, preset, contestTier]);

  const [family, variation] = splitFamily(selection.line.name);

  return (
    <main className="setup-screen">
      <header className="setup-header">
        <div className="setup-wordmark-group">
          <span className="setup-wordmark">Chess DFS</span>
          <span className="setup-tagline">DFS lineups, built from chess openings.</span>
        </div>
        <ThemeToggle />
      </header>

      <div className="setup-layout">
        <section className="setup-left">
          <div className="setup-card contest-card">
            <label htmlFor="contest-select" className="setup-eyebrow">
              1 · Contest
            </label>
            <select id="contest-select" value={presetIndex} onChange={(event) => selectPreset(Number(event.target.value))}>
              {PRESETS.map((p, index) => (
                <option key={p.name} value={index}>
                  {p.name} — {p.contest.fieldSize.toLocaleString()} entries
                </option>
              ))}
            </select>
            <p className="setup-card-detail">
              ${preset.buyIn.toLocaleString()} buy-in · <span className="accent">{contestTier.name} field</span>
            </p>
          </div>

          <div className="setup-card">
            <p className="setup-eyebrow">2 · King mode</p>
            <div className="king-mode-control">
              <label className={kingMode === KingMode.EMERGE ? "king-mode-option selected" : "king-mode-option"}>
                <input type="radio" name="king-mode" checked={kingMode === KingMode.EMERGE} onChange={() => setKingMode(KingMode.EMERGE)} />
                Let him emerge
              </label>
              <label className={kingMode === KingMode.PLACED ? "king-mode-option selected" : "king-mode-option"}>
                <input type="radio" name="king-mode" checked={kingMode === KingMode.PLACED} onChange={() => setKingMode(KingMode.PLACED)} />
                Place your King now
              </label>
            </div>

            {kingMode === KingMode.PLACED && (
              <div className="qb-picker">
                {qbs.length === 0 ? (
                  <p className="hint">No QBs found in that file.</p>
                ) : (
                  <>
                    <label htmlFor="white-qb">White&apos;s QB</label>
                    <select id="white-qb" value={whiteKingId ?? ""} onChange={(event) => setWhiteKingId(event.target.value || null)}>
                      <option value="">Choose a QB…</option>
                      {qbs.map((qb) => (
                        <option key={qb.id} value={qb.id}>
                          {qb.name} — ${qb.salary.toLocaleString()} — {qb.proj.toFixed(1)} pts
                        </option>
                      ))}
                    </select>
                    {blackKing && <p className="hint">Black&apos;s QB: {blackKing.name}</p>}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="setup-card suggested-card">
            <div className="suggested-text">
              <p className="suggested-eyebrow">Suggested · {contestTier.name} field</p>
              <h2 className="family-name">{family}</h2>
              {variation !== "" && <p className="variation-name">{variation}</p>}
              {offTierTag !== null && <p className="off-tier-tag">{offTierTag}-style</p>}
              <p className="moves">{formatMoves(selection.line.moves)}</p>
              <PieceSequence preview={selectionPreview} />
              <p className="eco-games">
                {selection.line.eco} · {selectionStats !== null ? `${selectionStats.games.toLocaleString()} games` : "—"}
              </p>
              <button type="button" className="play-this" disabled={!canPlay} onClick={() => choose({ kind: "line", line: selection.line })}>
                Play this
              </button>
            </div>
            <BoardPreview fen={selectionPreview.fen} />
          </div>
        </section>

        <section className="setup-right">
          <div className="explorer-header">
            <h3>Opening explorer</h3>
            <button type="button" onClick={randomPick}>
              Random
            </button>
          </div>
          <div className="chips">
            {CHIP_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                className={chip === name ? "chip selected" : "chip"}
                aria-pressed={chip === name}
                onClick={() => setChip(name)}
              >
                {name}
              </button>
            ))}
            <button
              type="button"
              className={chip === ALL_CHIP ? "chip selected" : "chip"}
              aria-pressed={chip === ALL_CHIP}
              onClick={() => setChip(ALL_CHIP)}
            >
              {ALL_CHIP}
            </button>
          </div>

          <div className="search-row">
            <label htmlFor="opening-search">Search openings</label>
            <input
              id="opening-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${BOOK.length.toLocaleString()} named lines…`}
            />
          </div>

          {query.trim().length > 0 && query.trim().length < MIN_QUERY_LENGTH && (
            <p className="hint">Keep typing ({MIN_QUERY_LENGTH}+ characters) to search.</p>
          )}

          {searchResults !== null ? (
            <ul className="explorer-list">
              {searchResults.length === 0 && <li className="hint">No openings match &quot;{query}&quot;.</li>}
              {searchResults.slice(0, MAX_SEARCH_RESULTS).map((line) => {
                const [lineFamily, lineVariation] = splitFamily(line.name);
                return (
                  <ExplorerRow
                    key={`${line.eco}|${line.name}|${line.moves.join(" ")}`}
                    rank={RANK_BY_FAMILY.get(lineFamily)?.rank ?? null}
                    family={lineFamily}
                    variation={lineVariation}
                    moves={line.moves}
                    games={statsFor(line)?.games ?? null}
                    onSelect={() => selectLine(line)}
                  />
                );
              })}
              {searchResults.length > MAX_SEARCH_RESULTS && (
                <li className="hint">
                  Showing {MAX_SEARCH_RESULTS} of {searchResults.length} matches — keep typing to narrow it down.
                </li>
              )}
            </ul>
          ) : (
            <ul className="explorer-list">
              {visibleFamilies.map((fam) => {
                const [, famVariation] = splitFamily(fam.line.name);
                return (
                  <ExplorerRow
                    key={fam.name}
                    rank={fam.rank}
                    family={fam.name}
                    variation={famVariation}
                    moves={fam.line.moves}
                    games={fam.games}
                    onSelect={() => selectLine(fam.line)}
                  />
                );
              })}
            </ul>
          )}

          <button type="button" className="play-own" disabled={!canPlay} onClick={() => choose({ kind: "own" })}>
            (Play your own opening)
          </button>
        </section>
      </div>
    </main>
  );
}

function ExplorerRow({
  rank,
  family,
  variation,
  moves,
  games,
  onSelect,
}: {
  rank: number | null;
  family: string;
  variation: string;
  moves: readonly string[];
  games: number | null;
  onSelect: () => void;
}) {
  return (
    <li className="explorer-row">
      <button type="button" onClick={onSelect}>
        <span className="explorer-rank">{rank ?? "—"}</span>
        <span className="explorer-name">
          <span className="explorer-family">{family}</span>
          {variation !== "" && (
            <>
              {" · "}
              <span className="explorer-variation">{variation}</span>
            </>
          )}
        </span>
        <span className="explorer-moves">{formatMoves(moves)}</span>
        <span className="explorer-games">{games !== null ? games.toLocaleString() : "—"}</span>
      </button>
    </li>
  );
}
