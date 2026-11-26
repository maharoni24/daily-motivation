# Kairo Realty

Public website for Kairo Realty buyers and sellers: *Intelligent Real Estate, Perfectly Timed.*

A static, dependency-free site. Deploy the folder to any static host (Netlify, Vercel, GitHub Pages).

## Daily data
The Kairo Moment Score reads `data/moment-scores.json`. Update that one file each day:
- `updated`: date of the data (YYYY-MM-DD)
- `sample`: `true` shows "Sample data"; set to `false` once real data is in, and the badge reads "Updated <date>"
- `markets[]`: `name`, `area`, `score` (0-100), `signal` (`Act now` | `Good time` | `Wait & watch`), `why`, `median`, `dom`, `supply`, `trend` (12 monthly values)

The highest-scoring market also feeds the "Today's Kairo Moment" card in the hero.

## Before launch
- Connect the lead form (search `TODO: send to CRM` in `index.html`).
- Fill footer links marked `data-todo`: NYS Fair Housing Notice, Standard Operating Procedures, Privacy.
- Add a founder headshot in place of the monogram.
