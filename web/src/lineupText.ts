// Shared "plain tab-separated text" formatter behind the Finish screen's
// own "Copy lineup" (BuildScreen.tsx) and the Saved lineups screen's
// per-row Copy (SavedLineupsScreen.tsx) -- factored out so the two can't
// drift apart on format, same "shared helper" precedent BuildScreen.tsx
// already uses for simEyebrowSuffix/BOTTOM_99_ROI_LABEL etc. One row per
// roster entry (Slot/Piece-or-"(optimizer)"/Player/Pos/Team/Salary) plus a
// blank line and a totals block.
export interface LineupTextRow {
  readonly slot: string;
  readonly label: string;
  readonly name: string;
  readonly pos: string;
  readonly team: string;
  readonly salary: number;
}

export interface LineupTextTotals {
  readonly salaryUsed: number;
  readonly salaryRemaining: number;
  readonly projection: number;
  readonly ownership: number; // fraction 0..1
  readonly opening: string;
  readonly moves: string; // already formatted, e.g. "1. e4 e5 2. Nf3"
}

export function formatLineupText(rows: readonly LineupTextRow[], totals: LineupTextTotals): string {
  const rowLines = rows.map((row) => [row.slot, row.label, row.name, row.pos, row.team, `$${row.salary.toLocaleString()}`].join("\t"));
  const totalLines = [
    `Salary used: $${totals.salaryUsed.toLocaleString()}`,
    `Salary remaining: $${totals.salaryRemaining.toLocaleString()}`,
    `Projection: ${totals.projection.toFixed(1)} pts`,
    `Ownership: ${(totals.ownership * 100).toFixed(1)}%`,
    `Opening: ${totals.opening}`,
    `Moves: ${totals.moves}`,
  ];
  return [...rowLines, "", ...totalLines].join("\n");
}

// "1. e4 e5 2. Nf3 Nc6" -- a plain SAN history array, numbered in pairs.
export function formatMoveList(history: readonly string[]): string {
  const pairs: string[] = [];
  for (let i = 0; i < history.length; i += 2) {
    const num = i / 2 + 1;
    const black = history[i + 1];
    pairs.push(black !== undefined ? `${num}. ${history[i]} ${black}` : `${num}. ${history[i]}`);
  }
  return pairs.join(" ");
}
