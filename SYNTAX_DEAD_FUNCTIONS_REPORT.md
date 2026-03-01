# Syntax and Dead Function Check Report

Date: 2026-03-01

## Commands run

- `python scripts/check_syntax_dead_functions.py`
- `rg -n "fetchPulseMetrics|pulseMetrics"`

## Syntax check result

All JavaScript files in the repository root passed `node --check` syntax validation.

## Potential dead functions (heuristic)

The dead-function scan is **heuristic only** (name occurrence counting), so results may include false positives for functions invoked dynamically or from outside a file.

- `Dock Command 0.4.0.user.js`: 0 possible dead functions
- `Failed%20Container%20Moves%20-%20aakalish-5.4-patched-fans-v3.user.js`: 0 possible dead functions
- `Relay_Prototype_0.1.9k.user.js`: 1 possible dead function (`getCaseId`)
- `SSP_Util_1.6.72.user.js`: 35 possible dead functions (see script output)
- `pulseMetrics.js`: 1 possible dead function (`fetchPulseMetrics`)

## Notes

- `pulseMetrics.js` exports `fetchPulseMetrics`, but there is no import usage found in this repository via `rg`.
- `SSP_Util_1.6.72.user.js` includes many utility/debug functions where single-reference detection may be expected.
