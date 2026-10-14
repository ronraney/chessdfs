// A small seeded PRNG for build.ts (Task 29). Python's build loop takes an
// injected random.Random; TS has no seedable equivalent to stand in for it,
// so this is a from-scratch deterministic generator (mulberry32) instead.
// It is NOT bit-for-bit comparable to Python's Mersenne Twister -- the same
// seed number will generally produce a different pick in TS than in
// Python. What carries over, and is all any ported test relies on, is:
// same seed -> same TS pick every time, and that pick always comes from
// the allowed candidate set.

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  // A pseudo-random float in [0, 1).
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // A uniformly-chosen element of `items` -- the stand-in for Python's
  // random.Random.choice.
  choice<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("choice() requires a non-empty array");
    }
    return items[Math.floor(this.next() * items.length)];
  }
}
