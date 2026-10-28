// CLI entry for simBacktest.ts -- kept separate from that file (which has
// no top-level side effects at all, so it's safe for a unit test to import
// its pure exports) because this file's own `main()` call at the bottom
// runs immediately on import, which would fire against a test's own
// process.argv if the two were combined.
//
// Not runnable with plain `node` directly: this app's own tsconfig uses
// extensionless, bundler-style imports ("moduleResolution": "bundler"),
// which plain Node's ESM resolver can't follow. `npm run backtest` instead
// bundles this file for Node first (vite.backtest.config.ts, a standalone
// config used ONLY by that script -- the app's own vite.config.ts is
// untouched), then runs the bundled output with `node`.
import { readFileSync } from "node:fs";
import nflConfig from "../data/config/sports/nfl.json";
import { loadEtrCsv } from "../engine/loaders";
import { loadSportConfig } from "../engine/sport";
import { DEFAULT_TRIALS, runContestBacktest, type LineBacktest, type RealLines } from "./simBacktest";

interface CliArgs {
  readonly csvPath: string;
  readonly entries: number;
  readonly placesPaid: number;
  readonly seed: number;
  readonly trials: number;
  readonly real?: RealLines;
}

const REAL_FLAGS = ["real-win", "real-top1", "real-cash", "real-median"] as const;

function parseCliArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) throw new Error(`malformed flag (expected --name=value): ${arg}`);
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      positional.push(arg);
    }
  }
  if (positional.length < 4) {
    throw new Error(
      "usage: simBacktest <csvPath> <entries> <placesPaid> <seed> [--trials=2000] " +
        "[--real-win=N --real-top1=N --real-cash=N --real-median=N]",
    );
  }
  const [csvPath, entriesStr, placesPaidStr, seedStr] = positional;
  const trials = flags.has("trials") ? Number(flags.get("trials")) : DEFAULT_TRIALS;

  const givenRealFlags = REAL_FLAGS.filter((flag) => flags.has(flag));
  if (givenRealFlags.length > 0 && givenRealFlags.length < REAL_FLAGS.length) {
    throw new Error(`real lines must be given all-or-nothing: ${REAL_FLAGS.map((f) => `--${f}`).join(", ")}`);
  }
  const real: RealLines | undefined =
    givenRealFlags.length === REAL_FLAGS.length
      ? {
          win: Number(flags.get("real-win")),
          top1: Number(flags.get("real-top1")),
          cash: Number(flags.get("real-cash")),
          median: Number(flags.get("real-median")),
        }
      : undefined;

  return { csvPath, entries: Number(entriesStr), placesPaid: Number(placesPaidStr), seed: Number(seedStr), trials, real };
}

function formatLine(line: LineBacktest): string {
  const base =
    `  ${line.name.padEnd(6)} rank ${String(line.rank).padStart(7)}` +
    `   P10 ${line.p10.toFixed(1).padStart(7)}   P50 ${line.p50.toFixed(1).padStart(7)}   P90 ${line.p90.toFixed(1).padStart(7)}`;
  if (line.real === undefined || line.realPercentile === undefined) return base;
  return `${base}   real ${line.real.toFixed(1).padStart(6)} -> sim P${line.realPercentile.toFixed(1)}`;
}

function main(): void {
  const { csvPath, entries, placesPaid, seed, trials, real } = parseCliArgs(process.argv.slice(2));
  const csvText = readFileSync(csvPath, "utf-8");
  const players = loadEtrCsv(csvText);
  const sport = loadSportConfig(nflConfig);

  const result = runContestBacktest(players, sport, entries, placesPaid, seed, trials, real);

  const sampleNote = result.sampledDown
    ? ` (sampled to ${result.scoredLineupCount} for scoring, per MAX_FIELD_SAMPLE)`
    : "";
  console.log(
    `Entries ${entries.toLocaleString()} · Paid ${placesPaid.toLocaleString()} · seed ${seed} · trials ${trials} · ` +
      `field ${result.fieldLineupCount} lineups${sampleNote} · lineupWeight ${result.lineupWeight.toFixed(2)}`,
  );
  for (const line of result.lines) console.log(formatLine(line));
}

main();
