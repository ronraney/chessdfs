// "Slot-ordered lineups" task: a fixed, DK-ordered roster grid for
// DISPLAY -- every place a lineup is listed (build screen You/Field,
// finish screen, saved lineup view) shows the same rosterSize rows, in
// `rosterSlots`' own definition order (NFL's own roster_slots config is
// QB(1), RB(2), WR(3), TE(1), FLEX(1), DST(1) -- exactly this task's own
// "QB, RB, RB, WR, WR, WR, TE, FLEX, DST"), each either the entry
// occupying it or null (an empty placeholder row).
//
// "DraftKings upload CSV" task: this is now ALSO the one slot-assignment
// Copy lineup, the saved record's own `.slot` field, and the DK upload
// CSV all read -- engine/rules.ts's OLD assignRosterSlots (a bipartite
// matching that could reassign an EARLIER entry to a different slot
// instance to fit a LATER one -- correct for "is this roster assignable
// at all," but its own header comment admitted the dedicated-vs-FLEX
// choice for interchangeable same-position entries was "whatever the
// augmenting search finds first... cosmetic only," not guaranteed to
// match pick order) has been retired now that nothing needs it any more.
// This is deliberately simpler and greedy, and NEVER reassigns: each
// entry's own dedicated slot first, in pick order; only an entry whose
// own dedicated slots are already full overflows into a shared slot
// (e.g. FLEX), also in pick order. Calling this fresh from the CURRENT
// entries list (not incrementally patching a prior result) is what makes
// re-slotting after a capture removes someone well-defined: a full
// recompute always places the same survivors the same way, with no
// stale leftover gap and no entry stuck in FLEX once its own dedicated
// slot frees up.
//
// Only ever looks at `getPosition(entry)` -- a single, primary position
// -- not a full multi-position eligibility list the way engine/rules.ts's
// own maxAssignable/lineupStillCompletable do; every real Player loaded
// from a CSV only ever has exactly one position anyway (loaders.ts always
// builds a single-element `positions` array), so this never actually
// diverges from those checks for real data. A roster that's ALREADY
// legal (lineupStillCompletable gated every lock that built it) can also
// never have more entries competing for a position-family's dedicated +
// shared slots than that family actually has room for, so this always
// finds a full placement for a genuinely valid roster -- it just never
// needs to consider reassignment to prove that.
//
// Generic over the entry type: engine Player objects (live build) and
// savedLineupsStore's plain SavedLineupPlayer records (the Saved lineups
// screen, the DK CSV export) both need this, and share no common type
// beyond "has some real-world position."
export interface RosterSlotLike {
  readonly name: string;
  readonly positions: ReadonlySet<string>;
  readonly count: number;
}

export interface SlotGridRow<T> {
  readonly slotName: string;
  readonly entry: T | null;
}

interface Placement {
  readonly instances: readonly RosterSlotLike[]; // one per slot instance, expanded by count
  readonly occupantByInstance: readonly (number | null)[]; // index into `entries`, or null
}

function computePlacement<T>(
  entries: readonly T[],
  getPosition: (entry: T) => string,
  rosterSlots: readonly RosterSlotLike[],
): Placement {
  const instances: RosterSlotLike[] = [];
  for (const slot of rosterSlots) {
    for (let i = 0; i < slot.count; i++) instances.push(slot);
  }
  const occupant: (number | null)[] = new Array(instances.length).fill(null);
  const placed: boolean[] = new Array(entries.length).fill(false);

  function place(dedicatedOnly: boolean): void {
    for (let i = 0; i < entries.length; i++) {
      if (placed[i]) continue;
      const position = getPosition(entries[i]).toUpperCase();
      const slotIdx = instances.findIndex(
        (slot, idx) => occupant[idx] === null && slot.positions.has(position) && (!dedicatedOnly || slot.positions.size === 1),
      );
      if (slotIdx !== -1) {
        occupant[slotIdx] = i;
        placed[i] = true;
      }
    }
  }
  place(true); // each entry's own dedicated slot(s), in pick order
  place(false); // overflow (e.g. FLEX), also in pick order

  return { instances, occupantByInstance: occupant };
}

// The fixed, rosterSize-length grid -- for anywhere a lineup is LISTED on
// screen, blanks included.
export function slotGridRows<T>(
  entries: readonly T[],
  getPosition: (entry: T) => string,
  rosterSlots: readonly RosterSlotLike[],
): SlotGridRow<T>[] {
  const { instances, occupantByInstance } = computePlacement(entries, getPosition, rosterSlots);
  return instances.map((slot, idx) => {
    const playerIdx = occupantByInstance[idx];
    return { slotName: slot.name, entry: playerIdx === null ? null : entries[playerIdx] };
  });
}

// The same placement, but as a plain slot-name array PARALLEL to
// `entries` (same order, same length, no blanks) -- for anywhere a
// lineup is only ever a list of its REAL entries: Copy lineup's own
// "Slot" column, the saved record's own `.slot` field, and the DK upload
// CSV's own column lookup (savedLineupsStore.SavedLineupPlayer.slot is
// filled from exactly this).
export function slotNamesForEntries<T>(
  entries: readonly T[],
  getPosition: (entry: T) => string,
  rosterSlots: readonly RosterSlotLike[],
): string[] {
  const { instances, occupantByInstance } = computePlacement(entries, getPosition, rosterSlots);
  const names: string[] = new Array(entries.length).fill("");
  instances.forEach((slot, idx) => {
    const playerIdx = occupantByInstance[idx];
    if (playerIdx !== null) names[playerIdx] = slot.name;
  });
  return names;
}
