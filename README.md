# Dive Radio — Episode Analytics

Interactive comparison chart for Dive Radio episode performance across four
destinations: YouTube (Dive Club + DesignerTom) and X (@ridd_design +
@designertom).

- One line per episode, weeks-since-premiere or calendar view
- Cumulative views or weekly delta
- Deterministic trends & insights computed at build time (no model calls)
- Static site — no server, no network calls at view time

Data is exported weekly (Monday noon Phoenix) by an automated pipeline that
also discovers newly published episodes and registers them for tracking.
Built with vanilla JS + Chart.js (MIT, vendored).
