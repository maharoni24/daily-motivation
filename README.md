# Kairo Realty

Public website for Kairo Realty buyers and sellers: *Intelligent Real Estate, Perfectly Timed.*

A static, dependency-free site. Deploy the folder to any static host (Netlify, Vercel, GitHub Pages).

## Daily data
Market numbers come from Realtor.com Economic Research's public county data (built from MLS listings, no login). Refresh with:

    python3 scripts/update_moment_scores.py

It rewrites `data/moment-scores.json`, embeds the same data in `src/kairo-realty.html` and rebuilds `index.html`. If the download or validation fails it exits with an error and changes nothing. Edit the page in `src/kairo-realty.html`; `index.html` is generated.

Realtor.com publishes this county data monthly, so the score changes once a month; the daily run checks for the new release and updates the "checked" date.

Markets: Nassau, Suffolk, Kings (Brooklyn), Queens, Bronx, Richmond (Staten Island).

## Before launch
- Connect the lead form (search `TODO: send to CRM` in `index.html`).
- Fill footer links marked `data-todo`: NYS Fair Housing Notice, Standard Operating Procedures, Privacy.
- Add a founder headshot in place of the monogram.
