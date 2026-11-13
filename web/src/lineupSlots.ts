// "Slot-ordered lineups" task: a fixed, DK-ordered roster grid for
// DISPLAY -- every place a lineup is listed (build screen You/Field,
// finish screen, saved lineup view) shows the same rosterSize rows, in
// `rosterSlots`' own definition order (NFL's own roster_slots config is
// QB(1), RB(2), WR(3), TE(1), FLEX(1), DST(1) -- exactly this task's own
// "QB, RB, RB, WR, WR, WR, TE, FLEX, DST"), each either the entry
// occupying it or null (an empty placeholder row).
//
// Deliberately NOT engine/rules.ts's own assignRosterSlots: that one is a
// bipartite matching (Kuhn's algorithm) built for completability checks,
// which can reassign an EARLIER entry to a different slot instance to fit
// a LATER one -- correct for "is this roster assignable at all," but its
// own header comment admits the specific dedicated-vs-FLEX choice for
// interchangeable same-position entries is "whatever the augmenting
// search finds first... cosmetic only," i.e. not guaranteed to match pick
// order. This task asks for exactly that guarantee ("same pick order
// within a position"), so this is a separate, simpler, greedy, NEVER-
// reassigning placement: each entry's own dedicated slot first, in pick
// order; only an entry whose own dedicated slots are already full
// overflows into a shared slot (e.g. FLEX), also in pick order. Calling
// this fresh from the CURRENT entries list (not incrementally patching a
// prior result) is what makes re-slotting after a capture removes
// someone well-defined: a full recompute always places the same
// survivors the same way, with no stale leftover gap and no entry stuck
// in FLEX once its own dedicated slot frees up.
//
// Generic over the entry type: engine Player objects (live build) and
// savedLineupsStore's plain SavedLineupPlayer records (the Saved lineups
// screen) both need this, and share no common type beyond "has some real-
// world position."
export interface RosterSlotLike {
  readonly name: string;
  readonly positions: ReadonlySet<string>;
  readonly count: number;
}

export interface SlotGridRow<T> {
  readonly slotName: string;
  readonly entry: T | null;
}

export function slotGridRows<T>(
  entries: readonly T[],
  getPosition: (entry: T) => string,
  rosterSlots: readonly RosterSlotLike[],
): SlotGridRow<T>[] {
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

  return instances.map((slot, idx) => {
    const playerIdx = occupant[idx];
    return { slotName: slot.name, entry: playerIdx === null ? null : entries[playerIdx] };
  });
}
