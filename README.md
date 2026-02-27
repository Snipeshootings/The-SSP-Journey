# SSP Journey (Tampermonkey/Greasemonkey Utilities)

This repository contains browser userscripts for internal transportation and logistics workflows, plus experimental dashboard prototypes.

## Scripts in this repo

### 1) `SSP_Util_1.6.42.user.js`
Primary SSP enhancement script focused on execution support.

- CPT utilization helpers
- Action/Lane panels
- IB4CPT export
- Planning panel and staffing-to-cutoff views
- Relay connectivity for selected data lookups

### 2) `Dock Command (All-in-One Preview)-0.4.0.user.js`
Prototype dock command experience that launches an overlay workspace.

- Grid-based layout powered by GridStack
- Toolbox grouped by execution/data/people/comms
- Hotkey-triggered panel behavior
- Save/restore of workspace layout state

### 3) `Relay_Prototype_0.1.9k.user.js`
Relay integration prototype and bridge utilities.

- Token capture/handshake helpers for Relay auth flow
- SSP-side integration hooks for Relay-backed data
- Lightweight diagnostics/logging for prototype iteration

### 4) `Failed%20Container%20Moves%20-%20aakalish-5.4-patched-fans-v3.user.js`
Notification utility for failed container moves.

- Detects failed move conditions in supported sort center pages
- Adds notification workflows and follow-up routing helpers
- Includes compatibility patches and FANS connectivity support

## Recommended setup

1. Install a userscript manager extension:
   - Tampermonkey (recommended)
   - Violentmonkey / Greasemonkey (as applicable)
2. Open the script file you want to use.
3. Install into your userscript manager.
4. Verify `@match`, `@connect`, and network permissions align with your environment.

## Versioning and workflow

- Scripts are currently tracked as versioned file names.
- Prototype and production-ready behaviors may coexist in this repository.
- Keep script headers (`@name`, `@version`, `@match`, `@grant`, `@connect`) accurate when making updates.

## Notes

- These scripts target internal Amazon logistics web applications and may not run outside those domains.
- Review script metadata before sharing or deploying to ensure domain and endpoint correctness.

## License

This project is licensed under GPL-3.0. See [`LICENSE`](./LICENSE).
