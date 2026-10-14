// Task 34: the opening setup screen -- replaces the old "Opening setup —
// coming next" placeholder. UI-only: every rank/suggest/random/preview
// call here is the engine's own function (web/src/engine); the one new
// piece of UI-layer code is appData.ts's BOOK <-> line_stats join, a plain
// data combination for the explorer's per-family variation lists, not a
// new domain rule.
//
// One shared `selection` (initialized to suggestOpening's pick) feeds both
// the top card and the board preview -- tapping any line anywhere on this
// screen (a family's representative, a variation, a search result, or
// Random) updates it, and the one "Play this" button always commits
// whatever is currently selected. This read of the spec was a judgment
// call: the alternative (the top suggested-opening card frozen in place,
// with the explorer's picks needing some second, separate commit action)
// seemed more confusing to use and wasn't spelled out either way -- say
// the word if a frozen top card was actually intended.
import { useMemo, useState } from "react";
import "./OpeningSetupScreen.css";
import { BOOK, LAST_RANK, RANKED_FAMILIES, RANK_BY_FAMILY, previewFor, statsFor, variationsForFamily, type Variation } from "./appData";
import BoardPreview from "./BoardPreview";
import type { ContestPreset } from "./engine/config";
import { Piece } from "./engine/models";
import {
  findOpeningLines,
  randomOpening,
  splitFamily,
  suggestOpening,
  type BookLine,
  type OpeningPreview as OpeningPreviewResult,
  type RankedFamily,
} from "./engine/openings";

export type ChosenOpening = { kind: "line"; line: BookLine } | { kind: "own" };

interface Props {
  preset: ContestPreset;
  onChoose: (chosen: ChosenOpening) => void;
  onBack: () => void;
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
// A short/common query (e.g. a single letter) can match thousands of the
// book's 3,865 lines -- each result row computes its own openingPreview,
// so rendering them all would both jank the page and defeat "mobile-
// friendly." Capped, with a hint to keep typing, rather than silently
// dropping results or doing full per-keystroke virtualization.
const MAX_SEARCH_RESULTS = 20;
const MIN_QUERY_LENGTH = 3;

export default function OpeningSetupScreen({ preset, onChoose, onBack }: Props) {
  const contestTier = useMemo(() => preset.contest.entryTier(LAST_RANK), [preset]);
  const allTiers = useMemo(() => preset.contest.entryTiers(LAST_RANK), [preset]);
  const tierByName = useMemo(() => new Map(allTiers.map((tier) => [tier.name, tier])), [allTiers]);
  const suggestion = useMemo(() => suggestOpening(preset.contest, RANKED_FAMILIES), [preset]);

  const [chip, setChip] = useState<string>(contestTier.name);
  const [expandedFamily, setExpandedFamily] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(() => selectionFor(suggestion.line));

  function selectLine(line: BookLine): void {
    setSelection(selectionFor(line));
  }

  function randomPick(): void {
    const tier = chip === ALL_CHIP ? "all" : tierByName.get(chip)!;
    const seed = Math.floor(Math.random() * 2 ** 31);
    selectLine(randomOpening(RANKED_FAMILIES, tier, seed).line);
  }

  const visibleFamilies = useMemo(() => {
    if (chip === ALL_CHIP) return RANKED_FAMILIES;
    const tier = tierByName.get(chip)!;
    return RANKED_FAMILIES.filter((family) => family.rank >= tier.lowRank && family.rank <= tier.highRank);
  }, [chip, tierByName]);

  // A one- or two-character query can still match hundreds of lines (most
  // short substrings appear in some family or variation name somewhere);
  // MIN_QUERY_LENGTH keeps the earliest keystrokes from rendering (and
  // openingPreview-ing) a huge, practically useless result set.
  const searchResults = useMemo(
    () => (query.trim().length < MIN_QUERY_LENGTH ? null : findOpeningLines(query, BOOK)),
    [query],
  );

  const selectionPreview = useMemo(() => previewFor(selection.line), [selection]);
  const offTierTag = useMemo(() => {
    if (selection.rank === null) return null;
    const tier = preset.contest.rankTier(selection.rank, LAST_RANK);
    return tier.name === contestTier.name ? null : tier.name;
  }, [selection, preset, contestTier]);

  const [family, variation] = splitFamily(selection.line.name);

  return (
    <main className="setup opening-setup">
      <h1>Chess DFS</h1>
      <button type="button" className="back-link" onClick={onBack}>
        ← Back
      </button>

      <section className="selection-card">
        <p className="tier-label">
          {contestTier.name} tier · {preset.contest.fieldSize.toLocaleString()} entries
        </p>
        <h2 className="family-name">{family}</h2>
        {variation !== "" && <p className="variation-name">{variation}</p>}
        {offTierTag !== null && <p className="off-tier-tag">{offTierTag}-style</p>}
        <p className="moves">{selection.line.moves.join(" ")}</p>
        <PieceSequence preview={selectionPreview} />
        <BoardPreview fen={selectionPreview.fen} />
        <button type="button" className="play-this" onClick={() => onChoose({ kind: "line", line: selection.line })}>
          Play this
        </button>
      </section>

      <section className="explorer">
        <h3>Explore openings</h3>
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
            placeholder="Family or variation name…"
          />
          <button type="button" onClick={randomPick}>
            Random
          </button>
        </div>

        {query.trim().length > 0 && query.trim().length < MIN_QUERY_LENGTH && (
          <p className="hint">Keep typing ({MIN_QUERY_LENGTH}+ characters) to search.</p>
        )}

        {searchResults !== null ? (
          <ul className="line-list">
            {searchResults.length === 0 && <li className="hint">No openings match &quot;{query}&quot;.</li>}
            {searchResults.slice(0, MAX_SEARCH_RESULTS).map((line) => (
              <VariationRow key={`${line.eco}|${line.name}|${line.moves.join(" ")}`} line={line} onSelect={selectLine} />
            ))}
            {searchResults.length > MAX_SEARCH_RESULTS && (
              <li className="hint">
                Showing {MAX_SEARCH_RESULTS} of {searchResults.length} matches — keep typing to narrow it down.
              </li>
            )}
          </ul>
        ) : (
          <ul className="family-list">
            {visibleFamilies.map((fam) => (
              <FamilyRow
                key={fam.name}
                family={fam}
                expanded={expandedFamily === fam.name}
                onToggle={() => setExpandedFamily(expandedFamily === fam.name ? null : fam.name)}
                onSelect={selectLine}
              />
            ))}
          </ul>
        )}
      </section>

      <button type="button" className="play-own" onClick={() => onChoose({ kind: "own" })}>
        (Play your own opening)
      </button>
    </main>
  );
}

function FamilyRow({
  family,
  expanded,
  onToggle,
  onSelect,
}: {
  family: RankedFamily;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (line: BookLine) => void;
}) {
  const variations: Variation[] = useMemo(() => (expanded ? variationsForFamily(family.name) : []), [expanded, family.name]);

  return (
    <li className="family-row">
      <button type="button" className="family-button" onClick={onToggle} aria-expanded={expanded}>
        <span className="family-name-small">{family.name}</span>
        <span className="family-detail">
          rank {family.rank} · {family.games.toLocaleString()} games
        </span>
      </button>
      {expanded && (
        <ul className="variation-list">
          {variations.map((v) => (
            <VariationRow key={`${v.line.eco}|${v.line.name}|${v.line.moves.join(" ")}`} line={v.line} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

function VariationRow({ line, onSelect }: { line: BookLine; onSelect: (line: BookLine) => void }) {
  const [, label] = splitFamily(line.name);
  const preview = useMemo(() => previewFor(line), [line]);
  const stats = useMemo(() => statsFor(line), [line]);

  return (
    <li className="variation-row">
      <button type="button" onClick={() => onSelect(line)}>
        <span className="variation-label">{label !== "" ? label : line.name}</span>
        <span className="variation-stats">
          {stats !== null ? `${stats.games.toLocaleString()} games · ${(stats.draw_rate * 100).toFixed(1)}% draws` : "—"}
        </span>
        <PieceSequence preview={preview} />
      </button>
    </li>
  );
}
