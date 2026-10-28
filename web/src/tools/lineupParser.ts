// Parses one DraftKings contest-standings "Lineup" cell -- a single string
// listing every roster slot's own label token (QB/RB/WR/TE/FLEX/DST)
// immediately followed by that slot's player name (for DST, the team
// nickname instead -- DK's own convention), with no separator between one
// slot's name and the next slot's label token. Confirmed against the real
// file's own rows, e.g.:
//   "DST Falcons  FLEX Tyler Higbee QB Joe Burrow RB Bijan Robinson RB Tony
//    Pollard TE Tucker Kraft WR Amon-Ra St. Brown WR Tee Higgins WR KC
//    Concepcion Jr."
// Slot order in the raw string is DK's own export order (alphabetical by
// slot label: DST, FLEX, QB, RB, RB, TE, WR, WR, WR -- NOT roster order),
// preserved here rather than re-sorted. A caller matching each returned
// slot to a projections player should use BOTH `name` and `slot` (a
// player's position must be compatible with the slot, FLEX accepting
// RB/WR/TE) -- `slot` alone disambiguates the rare case of two same-named
// players at different positions.
export interface LineupSlot {
  readonly slot: string;
  readonly name: string;
}

const SLOT_TOKENS = new Set(["QB", "RB", "WR", "TE", "FLEX", "DST"]);

export function parseLineupString(lineup: string): LineupSlot[] {
  const words = lineup.trim().split(/\s+/).filter((w) => w.length > 0);
  const slots: LineupSlot[] = [];
  let currentSlot: string | null = null;
  let currentWords: string[] = [];

  function flush(): void {
    if (currentSlot !== null) slots.push({ slot: currentSlot, name: currentWords.join(" ") });
  }

  for (const word of words) {
    if (SLOT_TOKENS.has(word)) {
      flush();
      currentSlot = word;
      currentWords = [];
    } else if (currentSlot !== null) {
      currentWords.push(word);
    } // else: stray text before the first recognized slot token -- dropped
  }
  flush();

  return slots;
}
