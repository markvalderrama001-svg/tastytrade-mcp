# Swing-structure engine (`get_swing_structure`)

A read-only market-structure classifier. It never places orders and never
returns a trade instruction. It labels where price sits in a breakout sequence
so a human can decide.

## Vocabulary

| State | Meaning |
|---|---|
| **No Trade Zone** | Price is between the last confirmed swing high and swing low; neither is broken. |
| **Indication** | A close beyond a swing level. Direction is now possible, not confirmed. Not an entry. |
| **Correction** | The pullback toward the broken level. Still not an entry. |
| **Continuation** | Price closes back beyond the high (bullish) or low (bearish) made before the correction. The only state that gets entry / stop / target levels. |
| **Invalidated** | During the sequence, price closes beyond the *opposite* swing level. Treated as a failed setup, not a reversal signal. |

## How it works

1. **Pivots.** Bar *i* is a swing high when its high is strictly above the
   *N* bars on each side (mirror for lows). A pivot is only "known" *N* bars
   after it prints, so the state machine never peeks at the future.
2. **Forward state machine.** Walks the bars once, moving
   No Trade Zone -> Indication -> Correction -> Continuation, with
   invalidation checked on every bar of an active sequence.
3. **Levels on Continuation only.** Entry = the pre-correction extreme,
   stop = the correction extreme, target = the next opposing swing beyond the
   entry (falls back to the higher timeframe). R:R below 1:3 is flagged.
4. **Two timeframes.** Daily bars define the setup and levels; 1H bars time the
   entry. An entry is "armed" only when the 1H continuation agrees with the
   daily direction.
5. **Badges, not blockers.** US/Eastern session state and 1H volatility vs its
   own baseline are reported as flags.

Unit tests in `worker/test/worker.test.mjs` cover a bullish sequence, its
bearish mirror, invalidation, and the insufficient-data path.

Position size and risk are the user's call. Automated pivot detection is a
heuristic aid; verify on a chart.
