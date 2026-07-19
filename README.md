# Cycle Companion

A private, local-first PWA for tracking a partner's menstrual cycle and turning it into practical day-to-day guidance: current phase, hormone context, expected energy and mood, and phase-appropriate suggestions.

- **100% on-device** — all data lives in the browser's localStorage. No servers, no accounts, no analytics. This repository contains only code; no personal data is ever stored here.
- **Installable** — add it to your home screen from Chrome (⋮ menu → *Add to Home screen*). Works fully offline after the first load.
- **No build step** — plain HTML/CSS/JS. Serve the folder from any static host.

## How it works

You log the first day of each period. The app computes:

- **Cycle day & phase** — menstrual, follicular, ovulation, luteal
- **Ovulation day** — cycle length − 14
- **Fertile window** — the 5 days before ovulation plus ovulation day
- **Pregnancy likelihood** — day-specific chance of conception from unprotected sex (population averages, Wilcox et al. 1995)
- **Cycle length** — averaged automatically from your logged history (falls back to a manual setting until two starts are logged)

## Disclaimer

Estimates only. Not medical advice, and not reliable as a contraception method.
