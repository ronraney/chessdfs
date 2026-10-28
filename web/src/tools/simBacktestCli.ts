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
import {
  DEFAULT_TRIALS,
  parseContestStandings,
  runContestBacktest,
  runProjDiagnostic,
  type LineBacktest,
  type PercentileTriple,
  type RealLines,
} from "./simBacktest";

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

function runBacktestMode(argv: readonly string[]): void {
  const { csvPath, entries, placesPaid, seed, trials, real } = parseCliArgs(argv);
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

interface DiagnoseArgs {
  readonly projCsvPath: string;
  readonly standingsCsvPath: string;
  readonly entries: number;
  readonly seed: number;
  readonly trials: number;
}

function parseDiagnoseArgs(argv: readonly string[]): DiagnoseArgs {
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
    throw new Error("usage: simBacktest diagnose <projCsvPath> <standingsCsvPath> <entries> <seed> [--trials=2000]");
  }
  const [projCsvPath, standingsCsvPath, entriesStr, seedStr] = positional;
  const trials = flags.has("trials") ? Number(flags.get("trials")) : DEFAULT_TRIALS;
  return { projCsvPath, standingsCsvPath, entries: Number(entriesStr), seed: Number(seedStr), trials };
}

function formatTriple(label: string, t: PercentileTriple): string {
  return `  ${label.padEnd(16)} P10 ${t.p10.toFixed(1).padStart(7)}   P50 ${t.p50.toFixed(1).padStart(7)}   P90 ${t.p90.toFixed(1).padStart(7)}`;
}

function runDiagnoseMode(argv: readonly string[]): void {
  const { projCsvPath, standingsCsvPath, entries, seed, trials } = parseDiagnoseArgs(argv);
  const players = loadEtrCsv(readFileSync(projCsvPath, "utf-8"));
  const sport = loadSportConfig(nflConfig);
  const standingsRows = parseContestStandings(readFileSync(standingsCsvPath, "utf-8"));

  const result = runProjDiagnostic(players, sport, standingsRows, entries, seed, trials);

  console.log(`Entries ${entries.toLocaleString()} · seed ${seed} · trials ${trials}`);
  console.log(
    `Real lineups used: ${result.realLineupCount} ` +
      `(skipped malformed ${result.realLineupsSkippedMalformed}, skipped unmatched-name ${result.realLineupsSkippedUnmatched})`,
  );
  console.log(
    `Unmatched names: ${result.distinctUnmatchedNames} distinct (${result.unmatchedNameOccurrences} occurrences)` +
      (result.unmatchedNameSample.length > 0 ? ` -- e.g. ${result.unmatchedNameSample.join(", ")}` : ""),
  );
  console.log(`Avg lineup salary: real $${result.realAvgSalary.toFixed(0)}  sim $${result.simAvgSalary.toFixed(0)}`);
  const sampleNote = result.sampledDown
    ? ` (sampled to ${result.scoredLineupCount} for scoring, per MAX_FIELD_SAMPLE)`
    : "";
  console.log(`Field: ${result.fieldLineupCount} lineups${sampleNote}`);
  console.log(`Avg player (mean sim score - DK Proj): ${result.avgPlayerSimMinusProj.toFixed(2)}`);
  console.log(formatTriple("A real proj", result.realProj));
  console.log(formatTriple("B sim proj", result.simProj));
  console.log(formatTriple("C real points", result.realPoints));
  console.log(formatTriple("D sim scores", result.simScores));
}

function main(): void {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "diagnose") runDiagnoseMode(rest);
  else if (mode === "backtest") runBacktestMode(rest);
  else throw new Error(`usage: simBacktest <backtest|diagnose> ...`);
}

main();
