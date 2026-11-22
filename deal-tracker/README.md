# Agent Deal Tracker

A private web form where agents at the **Dix Hills** and **Farmingdale** offices submit **Seller, Buyer, Tenant or Landlord** deals, edit them, and check off milestones. The fields follow SkySlope's own new-file screens (captured 13 Nov 2026). Only the **address and office** are required; agents can fill in the rest as they go.

## How it flows

```
Agent submits / edits a deal
   │
   ├─▶ Deals tab (this spreadsheet): every field + a ready-to-type SkySlope payload
   │
   ├─▶ Office Sheets → "Dix Hills Inventory" or "Farmingdale Inventory"
   │      new deal → new yellow row inside the data block (above TOTAL)
   │      existing deal (same MLS # or street) → fills blank cells, moves Status forward only
   │
   └─▶ SkySlope Status = "Queued"
          the SkySlope task (SKYSLOPE_TASK.md, runs in your Chrome) opens the file:
          Forms (brokerage template) → Transaction details → Contacts → Commission
          → prepares the signature request for the agent or you to review and send
          → Darwin picks the file up from SkySlope
```

## What agents fill in

| Section | Fields (all optional except ★) |
|---|---|
| SkySlope setup | Office ★ (prefilled from the agent's profile), dual agency, SkySlope checklist type, **brokerage template**, seller net sheet (seller), co-agent + split, lead source, office lead |
| Property | MLS #, street number ★, direction, street name ★, unit, city, state, zip, county, year built |
| Your client | Entity checkbox + company, first/last, email (forms are signed here), phone, second client |
| Price & dates | List price, listing date + expiration (listings), accepted price / rent, offer accepted date, contract signed date, closing date + time, lease end, deposits, renewal/purchase options (leases) |
| Commission | Listing-side and buyer-side % or $, personal deal, referral (type/agent/brokerage/% or $), notes |
| Other side | Other party, other agent + brokerage |
| Attorneys, lender & title | Both attorneys, cash deal / loan type / amount / lender / loan officer, title company |

The dropdowns use SkySlope's exact wording, so the SkySlope task can pick the matching option without guessing.

- **Checklist types** are the 13 Dix Hills / Farmingdale checklists, filtered by side.
- **Brokerage templates only:**
  - Buyer: Buyer Broker Template, Unrepresented Buyer
  - Seller: Residential Listing, Co-op Condo Listing, Land Listing
  - Tenant: Tenant Representation, Unrepresented Tenant
  - Landlord: Rental Listing, Rental Listing - NYC

  No personal templates (Yearly Forms) and no onboarding templates.

### Milestones → inventory status
Checking a milestone moves the status forward (never back):

| Milestone | Status |
|---|---|
| Coming Soon on MLS | Coming Soon |
| Active on MLS | Active |
| Accepted offer / application approved | Accepted Offer |
| Contract fully signed / lease signed | Under Contract |
| Closing scheduled | Closing Set |
| Closed / move-in | Sold |

## Office Sheets rules (same as the daily inventory sync)
- A deal already on either tab (MLS # or street number + street name) is **never duplicated**.
- New rows go **inside the data block** of the agent's office tab, next to rows with the same status, so the TOTAL row still counts them. They are highlighted yellow for your review, with **Skyslope = "Needs To Be Added"**.
- On existing rows, only **blank** cells are filled: Listing Date, Expired Date, Listing Price, UC Date, UC Price, Commission, Closing Date & Time.
- Address, MLS #, Represents, Skyslope and Agent(s) are never changed.
- Status only moves forward. TOM and Sold rows are left alone.
- The Commission column is our side's dollars: % × accepted price, or the flat $, with both sides counted on dual deals.
- A "Cancelled" deal never changes the inventory. It's left for you.

## Setup
1. **Create a new Google Sheet** called "Deal Tracker". Keep it separate from Office Sheets, which holds passwords. Then go to **Extensions → Apps Script**.
2. Paste in the files:
   - Paste `Code.gs` over the default code.
   - Add an HTML file named `Index` and paste `Index.html` into it.
   - Turn on "Show appsscript.json" in Project Settings, then paste `appsscript.json`.
3. **Run `setup`** and approve the permissions. That creates the tabs Deals, Agents, Milestone Log and Sync Log, and points at your Office Sheets.
4. **Fill in the Agents tab**:

   | Name | Email | PIN | Role | Active | Office | SkySlope Name |
   |---|---|---|---|---|---|---|

   - **Name** must match the Roster, so it lines up in the Agent(s) column.
   - **SkySlope Name** must match SkySlope's File Owner list exactly, e.g. "Kevin A. Key", "Abderrahmane "Joe" Messaoud", "Milly (Iankel) Baez".
   - **Office** is Dix Hills or Farmingdale.
   - **Role** is Admin for you; you'll see every agent's deals.
5. **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*. Send agents the `/exec` link.
6. **Create the SkySlope task** from the Claude desktop app using `SKYSLOPE_TASK.md`.

After any code change: **Deploy → Manage deployments → Edit → New version**. The link stays the same.

## Customizing
Everything is at the top of `Code.gs`:
- `FIELDS`: add a field, or make one required with `req: true` or `req: ['Buyer']`.
- `MILESTONES`: the milestone lists.
- `SKY_CHECKLISTS` / `SKY_TEMPLATES`: the SkySlope dropdowns.

After adding fields, run `upgradeColumns`.

## Security
- Agents only see and edit their own deals. This is enforced on the server.
- After 5 wrong PINs the account is locked for 15 minutes. Sessions last 6 hours.
- The form reads Office Sheets only to find and write the two inventory tabs. It never touches Roster, Office Passwords or any other tab.
- The SkySlope task never sends anything for signature on its own and never deletes or approves anything in SkySlope.
