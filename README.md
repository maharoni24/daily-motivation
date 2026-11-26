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

## Kairo Concierge (24/7 AI)
The concierge lives in the page (`src/kairo-realty.html`, search "Kairo Concierge") and talks to a small server in `concierge/` (Cloudflare Worker).

Visitor flow: tap through 6 quick questions -> contact + consent -> personal Moment Plan (live county data, next steps, matched agent, how they want to be worked with) -> ask-anything chat.
Team alerts: an email (and optional webhook, e.g. Zapier -> text) when a visitor **starts**, and again with the full profile when they **finish**. The website contact form alerts the team the same way.
Chat: Claude (`claude-opus-5-5`, low effort) with the rules in `concierge/system-prompt.md` (AI disclosure, no price opinions or legal advice, fair-housing guardrails, NY process). Each Q&A is saved on the lead so the agent can read it.

### Go live
1. `cd concierge && npm install`
2. `npx wrangler kv namespace create LEADS` and paste the id into `wrangler.toml`
3. `npx wrangler secret put ANTHROPIC_API_KEY` and `npx wrangler secret put RESEND_API_KEY` (verify your sending domain in Resend)
4. Set `NOTIFY_EMAIL`, `SITE_URL` and `ALLOWED_ORIGINS` in `wrangler.toml`
5. `npx wrangler deploy`, then put the Worker URL in `CONCIERGE_API` in `src/kairo-realty.html` and run `python3 scripts/update_moment_scores.py`

### Agent roster
Decision (Nov 26, 2026): keep the generic hand-off ("A licensed Kairo agent who knows Queens will reach out by text in the morning, as you asked."), so `data/agents.json` stays empty. Optional later: `data/agents.json` drives a named agent recommendation. Each entry: `name`, `title`, `photo` (https URL), `counties` (e.g. `["Nassau","Suffolk"]`, names as in the Moment Score), `languages` (e.g. `["English","Español"]`). Empty list = "being matched now".

### Home search + favorites (MLS / IDX)
Buyers describe a home in plain words; the server turns it into MLS filters (Claude, structured output) and queries a RESO Web API IDX feed, e.g. New York State MLS. Hearts save favorites. Every search and favorite is stored on the lead and included in alert emails (favorite alerts at most every 30 minutes per visitor). Until the feed is connected, searches are still saved for the agent and no listings are shown.

Connect the feed (values come from the MLS / IDX vendor):
- `npx wrangler secret put LISTINGS_API_URL` (the RESO OData base URL)
- either `npx wrangler secret put LISTINGS_TOKEN`, or `LISTINGS_TOKEN_URL`, `LISTINGS_CLIENT_ID`, `LISTINGS_CLIENT_SECRET` (OAuth client credentials)
- in `wrangler.toml` `[vars]`: `LISTINGS_MLS_NAME` and `LISTINGS_DISCLAIMER` (the MLS's required IDX notice)
Field names follow the RESO Data Dictionary; adjust `concierge/src/listings.js` if the MLS names property types differently.
