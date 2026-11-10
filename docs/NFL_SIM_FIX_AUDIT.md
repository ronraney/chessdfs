# NFL Sim Fix Audit — chess-dfs

Read-only investigation. No chess-dfs code was modified; every diagnostic
below was run from standalone scratch scripts outside this repo, importing
only chess-dfs's own exported, pure functions (`drawSlateOutcomes`,
`internalAnchorForTargetMean`, `loadEtrCsv`, `generateSimulatedField`,
`runSimulation`, `SeededRandom`, etc.) against the real sample slate
`data/samples/DraftKings NFL DFS Projections -- Main Slate (6).csv` (279
players). Nothing in this doc ports a fix; it only reports what's there.

**Context that shapes every finding below:** chess-dfs's `web/src/engine/sim`
is a near-literal TS port of rraney/nfl-dfs's own Monte Carlo engine. The
underlying players are still modeled as NFL roster positions (QB/RB/WR/TE/
DST) against `config/sports/nfl.json` and a correlation matrix measured from
real NFL data (`real_correlation_targets.json`) — the chess-move/piece UI is
a skin on top of an otherwise-NFL DFS build screen. So this comparison is
close to apples-to-apples, not an analogy across sports.

## Summary table

| # | Issue | Applies? | File:function | Evidence |
|---|---|---|---|---|
| 1 | Regime shifts biasing own distribution | **Doesn't apply** | [draws.ts](../web/src/engine/sim/draws.ts) module header, `drawSlateOutcomes` | Vegas/dome additive mean-shift was explicitly removed on 2026‑10‑27 (commit `a5c7af1`), predating the NFL fix window (2026‑11‑09/10); no regime/shootout scaling of correlation loading exists at all — the correlation matrices are static, loaded verbatim from `real_correlation_targets.json`, never regime-adjusted |
| 2 | Marginal diagnostics | **Measured — mixed** | `drawOutcome` / `internalAnchorForTargetMean` ([draws.ts:86](../web/src/engine/sim/draws.ts#L86), [draws.ts:106](../web/src/engine/sim/draws.ts#L106)) | u≥0.85 share **15.01%** (target ~15%) and Z-clip rate **0.0073%** both look fixed; median-vs-proj accuracy is **4.0%** within ±3% — NFL's own *pre-fix* number was 7.6%, post-fix target was 58.1%. See detail below. |
| 3 | Special-case early returns | **Doesn't apply** | `drawSlateOutcomes` ([draws.ts:456-504](../web/src/engine/sim/draws.ts#L456-L504)) | Every player, DST included, goes through the identical Z-clip → `normCDF` → `drawOutcome` pipeline; no early return, no `Math.random()`-gated bypass anywhere in the file |
| 4 | Calibration gate percentile mismatch | **Doesn't apply (no mechanism)** | — | chess-dfs has no calibration/validation gate against historical conditional rates at all — no `calibrateCorrelation`-equivalent, no ceiling-gate percentile, nothing to mismatch |
| 5 | Control-lineup ROI test | **Measured — no inflation; different-direction gap found** | `runSimulation` / `generateSimulatedField` ([run.ts:216](../web/src/engine/sim/run.ts#L216), [field.ts:247](../web/src/engine/sim/field.ts#L247)) | avg Sim_ROI across sampled control lineups ran **more negative** than the rake target (opposite sign from NFL's inflation bug) — see detail below |
| 6 | Config cached across passes | **Doesn't apply (no mechanism)** | — | No A/B toggle, no legacy-mode flag, no memoized correlation config anywhere in `engine/sim` — nothing to go stale |
| 7 | Ownership source mismatch | **Doesn't apply** | `Player.ownFor` ([models.ts:93](../web/src/engine/models.ts#L93)), `field.ts:283`, `metrics.ts` | Every call site (field generation, pick-list sort metrics, build stats, hover tooltips) resolves ownership through the one `player.ownFor(contest.fieldTier())` path, driven by the same `ContestConfig`. No call site hardcodes `ownSmall`/`ownLarge`. |
| 8 | Low-ownership bias | **Applies (by design)** | `leverage` / `relativeLeverage` ([metrics.ts:24](../web/src/engine/metrics.ts#L24), [metrics.ts:53](../web/src/engine/metrics.ts#L53)) | Both pick-list metrics treat ownership *only* as competition to discount away — `value * (1 - ownership)` — never as a signal a cheap/underowned player might be correctly priced low |
| 9 | Metrics surfaced | **Partial overlap** | `SimResult` / `aggregateResults` ([run.ts:96](../web/src/engine/sim/run.ts#L96), [run.ts:194](../web/src/engine/sim/run.ts#L194)); [BuildScreen.tsx:1840](../web/src/BuildScreen.tsx#L1840) | Mean `roi` (NFL's own flagged-unreliable "Sim_ROI") is the headlined number in the UI; `cashRate` (NFL's reliable metric) is only secondary text. No degenerate `Median_ROI`. `top1PctRate` is a place-frequency, not a dollar ROI, so it structurally avoids NFL's saturating `Top1pct_ROI` — confirmed by the function's own doc comment. |
| 10 | Sheets display gotcha | **N — no Sheets integration** | — | chess-dfs is a client-only Vite/React SPA with no backend at all; no Google Sheets/gspread/Sheets-API code anywhere in the repo |

## #2 — Marginal diagnostics (detail)

**Method:** scratch script `marginalDiag.ts` (outside the repo) imports
`drawSlateOutcomes` and `internalAnchorForTargetMean` directly from
`draws.ts`. Ran 20,000 trials of `drawSlateOutcomes` over the real 279-player
slate (seed 12345). For each draw, recovered the underlying percentile `u`
via the exact closed-form inverse of `drawOutcome`'s own 4 piecewise
segments (algebra solved backward from the known floor/proj/ceiling/posMin/k
for that player — no approximation). Computed the two Z-clip boundary
u-values (`normCDF(±3.9)`) by replicating `draws.ts`'s own
Abramowitz-Stegun `normCDF` formula verbatim, to detect clip events without
needing to export any internal state.

```
players=279 trials=20000 seed=12345
u>=0.85 share: 15.01%  (target ~15%, total draws=5,580,000)
Z-clip rate: 0.0073%  (hi=271 lo=135 of 5,580,000)
median within +/-3% of proj: 11/278 = 4.0%
```

Breakdown by minimum projection (excludes the proj≈0 division-by-zero
guard):

| proj ≥ | within ±3% |
|---|---|
| 0 | 11/278 = 4.0% |
| 3 | 11/172 = 6.4% |
| 5 | 11/143 = 7.7% |
| 10 | 11/72 = 15.3% |

The worst gaps are dominated by sub-3-point bench players (median rounds to
`0.00` against a proj of 0.1–2.9 — a 100% "gap" that's really a rounding
artifact of a tiny denominator, not a real miscalibration). But the pattern
holds for meaningful-projection players too, and runs in one direction —
**median below proj**, not scattered around it:

```
Tyjae Spears        proj= 6.40  med= 4.18  gap=34.7%
Woody Marks          proj=16.90  med=13.75  gap=18.6%
Harold Fannin Jr.    proj= 8.60  med= 6.31  gap=26.6%
Quinshon Judkins     proj=12.90  med=10.32  gap=20.0%
Trey McBride         proj=15.10  med=13.09  gap=13.3%
George Kittle        proj=19.30  med=17.23  gap=10.7%
```

**This is not the NFL regime-bias bug** — there's no additive boost and the
upper-tail (u≥0.85) and clip-rate numbers both land right where NFL's fixed
state landed. It's a direct, acknowledged consequence of `draws.ts`'s own
2026‑10‑27 fix (commit `a5c7af1`): `drawOutcome`'s anchor is solved so the
curve's **mean** equals DK Proj, not its **median** — correct per that
task's own stated goal ("average draw = DK Proj, not median," see
[draws.ts:16-34](../web/src/engine/sim/draws.ts#L16-L34)). For any
right-skewed curve (ceiling gap wider than floor gap, which is the normal
case), mean-anchoring mechanically pulls the median below proj. NFL's own
"median within ±3%" diagnostic was built to catch a *different* failure mode
(one-sided regime inflation) and happens to also flag this *deliberate,
documented* design choice as a miss. Flagging for Ron rather than treating
as a bug: the NFL target (58.1%) assumes median-anchoring; chess's own
mean-anchoring design will structurally never hit that target the same way,
and that tradeoff was made on purpose in a different task.

## #5 — Control-lineup ROI test (detail)

**Method:** scratch script `controlRoi.ts` builds a field via the exact
production tier-builder path (`generateSimulatedField` with
`BUILD_ATTEMPT_CAP=10000`, `TARGET_DISTINCT_LINEUPS` — same constants
`buildFieldCache.ts`'s real Admin build uses), using the same "Fair Catch"
contest shape as chess-dfs's own
[run.fieldRoiSanity.test.ts](../web/src/engine/sim/run.fieldRoiSanity.test.ts)
($12 buy-in, 2,450 entries, $25,000 prize pool, 10% to first, $25 min cash,
563 paid places — rake identity target **‑14.97%**). Sampled a modest number
of **distinct** lineups uniformly (unweighted), mirroring nfl-dfs's own "25
field-sampled control lineups" methodology — deliberately *not*
`run.fieldRoiSanity.test.ts`'s own check, which grades literally every field
lineup against itself and is a closed-population payout identity by
construction (guaranteed to land near the rake target regardless of any
distributional bias — it cannot detect this failure mode). Each sampled
lineup graded via the production `runSimulation` entry point against the
built field.

Run A (25 control lineups, 2,000 trials each, seed 777):

```
field: 9403 distinct lineups, lineupWeight=0.26
expected ROI (rake identity): -14.97%
avg Sim_ROI across 25 control lineups: -21.90%
median Sim_ROI across control lineups: -19.70%
avg Cash_Rate across control lineups: 23.28%
per-lineup ROI: -16.4, -39.1, -42.9, -14.3, -42.9, -49.4, -76.2, -49.6, 76.9,
  -13.2, -20.9, -59.7, -14.3, 28.0, -3.8, -24.6, 28.1, -19.7, -17.1, -15.1,
  -76.3, -48.8, -22.9, 4.0, -17.4
```

Run B (larger sample — 100 control lineups, 1,500 trials each, seed 909) was
run to check Run A wasn't just n=25 noise (the per-lineup spread above is
wide, -76% to +77%):

```
field: 9414 distinct lineups, lineupWeight=0.26
expected ROI (rake identity): -14.97%
avg Sim_ROI across 100 control lineups: -21.76%
median Sim_ROI across control lineups: -20.62%
avg Cash_Rate across control lineups: 22.76%
```

Run B lands within a point of Run A on every number (avg ROI -21.76% vs
-21.90%, median -20.62% vs -19.70%, Cash_Rate 22.76% vs 23.28%) despite a
4x larger sample, a different seed, and a freshly-built field. **This is a
real, reproducible ~7-point gap, not n=25 sampling noise.**

**Reading this against the NFL check's own stated rule — "positive ROI for
average lineups = inflated sim" — chess-dfs does *not* show that pattern.**
If anything it's the opposite sign: control lineups underperform the rake
identity, not beat it. That's a real, separate gap from the theoretical
target worth Ron's attention, but it is **not** the NFL inflation bug, and
it plausibly ties back to the same #2 finding (mean-anchored, not
median-anchored, curves): if the *typical* trial outcome for most players
runs below proj while a thin right tail pulls the mean up to proj, a
uniformly-sampled control lineup (which doesn't benefit from the field's own
ownership-biased stacking the way the field's *other* members might) can
plausibly underperform a pure rake identity in a convex payout structure.
This is a hypothesis, not confirmed — flagged for further digging if Ron
wants it, not something this read-only pass can settle.

## #8 — Low-ownership bias (interpretation)

`leverage(player, contest)` ([metrics.ts:24](../web/src/engine/metrics.ts#L24))
is literally `value(player) * (1 - player.ownFor(tier))` — a cheap,
low-owned player gets almost no discount at all (full value), while a
high-owned/chalky player gets discounted hard, regardless of whether the
market's ownership number reflects real information about that player's
quality. `relativeLeverage` (Bishop's own pick-list sort metric,
[metrics.ts:53](../web/src/engine/metrics.ts#L53)) does the same thing
relative to the position's highest-owned player instead of an absolute
ownership fraction — same effect. This is the exact philosophy NFL's own
audit called out: *"ownership is treated only as competition, never as
evidence a player may be bad."* Unlike NFL's version of this finding (about
which lineups the sim's own field favors), chess's version lives one layer
up, in the pick-list recommendation metric a human actually sees while
building — Bishop and Pawn pieces are explicitly sorted to surface cheap,
underowned players first ([metrics.ts:69-80](../web/src/engine/metrics.ts#L69-L80)).
Not independently measured against field-level low-own/cheap lineup counts
in this pass (time-boxed as interpretation per the task's own instructions)
— the code-level evidence above is direct enough that a count likely
wouldn't change the conclusion.

## #9 — Metrics surfaced (detail)

`SimResult` ([run.ts:96](../web/src/engine/sim/run.ts#L96)) carries `roi`,
`cashRate`, `winRate`, `top1PctRate`, `finishPercentiles` (P10/P25/P50/P75/
P90 of *finish place*, not of ROI). The UI
([BuildScreen.tsx:1840](../web/src/BuildScreen.tsx#L1840)) headlines `roi`
(large text, `side-sim-roi` class) with `cashRate`/`top1PctRate` as small
secondary text underneath. Against NFL's own reliable/unreliable split:

- **`roi`** (mean $ ROI over trials) is structurally the same metric as
  NFL's own flagged-unreliable "Sim_ROI (mean)" — and it's chess-dfs's
  *headline* number, not a footnote.
- **`cashRate`** matches NFL's reliable "Cash_Rate" — present, but only as
  secondary text.
- No `Median_ROI` exists, so chess-dfs can't hit NFL's degenerate
  "‑100% when cashing <50%" case.
- `top1PctRate` is explicitly documented
  ([run.ts:84-95](../web/src/engine/sim/run.ts#L84-L95)) as a place-based
  *frequency*, not nfl-dfs's dollar-ranked "Top1pct_ROI" — the function's own
  comment calls out the name collision and confirms this was a deliberate
  design choice that avoids NFL's saturation bug.
- No `Bottom99pct_ROI` equivalent exists either (NFL's other reliable
  metric) — not present in either direction.

Net: chess-dfs avoided two of NFL's three known-bad metrics by construction,
but still headlines the one NFL metric found least trustworthy (mean ROI)
while relegating the one NFL trusts most (`cashRate`) to secondary text.

## Recommended fix order

This is an audit, not a change request — nothing below is implemented or
proposed as code. In priority order, for Ron's own judgment:

1. **#2/#5 together** — decide whether the mean-anchored `drawOutcome` curve
   (2026‑10‑27 fix) is still the intended design given it structurally fails
   NFL's own median-accuracy diagnostic, and whether the #5 control-lineup
   ROI gap (more negative than the rake target) is sampling noise or a real,
   reproducible effect — the Run B sample above should settle that.
2. **#9** — consider whether `cashRate` (not `roi`) should be the headlined
   UI number, given NFL independently found mean ROI the least trustworthy
   of its own metrics.
3. **#8** — flag for awareness; `leverage`/`relativeLeverage`'s "low
   ownership = pure opportunity" framing is a deliberate design choice NFL's
   own audit found risky, not an oversight, so this is Ron's call, not a bug.
4. **#1, #3, #4, #6, #7, #10** — no action: each either doesn't apply or no
   such mechanism exists in chess-dfs at all.
