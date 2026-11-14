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
          → sends the forms for signature automatically (your SkySlope pending-review automation checks them before approval)
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

## MLS listing tab (Seller and Landlord deals)
On a Seller or Landlord deal, the editor has a fourth tab, **MLS listing**. It mirrors OneKey MLS's Matrix input sheet for the property type the agent picks, the same list as the **+** button in Matrix Listing Manager.

| Matrix + menu | Side | Ready |
|---|---|---|
| Residential, Residential - Coop, Residential - Condo, Land, Res Income - Multi 2-4 | Seller | Yes |
| Rental | Landlord | Yes |
| Commercial - Multi 5+, Commercial Sale, Business Opportunity | Seller | Needs OneKey's input sheet |
| Commercial Lease | Landlord | Needs OneKey's input sheet |

- **Prefilled from the deal:** address (street suffix split out the way Matrix wants it), zip, county, year built, list price or rent, listing and expiration dates, owner name(s), agent name, co-agent and security deposit. When agents fill in their own listing, their MLS ID (their sign-in PIN) becomes the List Agent ID. Prefill only fills blanks; it never overwrites.
- **Required fields** match the starred fields on OneKey's sheet. Follow-up fields appear only when they apply (Garage Spaces after Garage = Yes; Rental's Short Term/Seasonal block only for that lease term). Remarks are checked for compensation wording.
- **Photos and documents** go to Drive: **Deal Tracker MLS Media / <Deal ID> / Photos | Documents** in Mac's Drive. Agents set the photo order (photo 1 is primary) and captions.
- **Saving the deal saves the MLS listing too.** It's stored in the **MLS Listings** tab, one row per deal.
- **Download PDF:** a Matrix entry sheet in Matrix's field order, with missing required fields in red and the photo order. A copy is kept in the deal's Drive folder.
- **Send to Matrix:** only once every required field and at least one photo are in. It renames the photos `01 - …`, `02 - …` in the agent's order, writes **Matrix Payload JSON**, and sets **Matrix Status = Queued**. The Matrix task (`MATRIX_TASK.md`) then enters the listing in Matrix in your Chrome and **saves it as Incomplete**. You or the agent review it and submit it in Matrix; nothing is submitted automatically.
- Matrix statuses: Draft → Queued → Entered (Incomplete) → (submitted by you in Matrix). Needs Info / Needs Review come with a note. Editing after it's entered shows "Changed since sent"; Send to Matrix again queues an update.

The field definitions are in `matrix/*.js`, shared with the standalone `matrix-listing-intake` app. After changing them, run `python3 build.py` to regenerate `MatrixSchemas.gs` and `DealTracker.gs`.

## Listing changes tab (Seller and Landlord deals on the MLS)
Once a listing deal is saved and has an **MLS #**, the editor shows **Listing changes**. The agent (or you) picks a change and fills in a short form:

| Change | OneKey form (in `forms/`) | Signed by | In Matrix once signed | On the deal |
|---|---|---|---|---|
| Price change | Status Change Form | Seller(s) + agent | New price | List price updated |
| Temporarily off market | Status Change Form | Seller(s) + agent | Status TOM | Status TOM (inventory too) |
| Back on market | Status Change Form | Seller(s) + agent | Status Active | Status Active |
| Withdraw listing | Listing Withdrawal Form | Seller(s) + firm representative | Status Withdrawn | Status Withdrawn |
| Cancel listing | Listing Cancellation Form | Seller(s) + firm representative | Status Cancelled | Status Cancelled |
| Extend listing | Extension Agreement | Seller(s) + agent | New expiration date + signed form uploaded | Expiration date updated |
| Other change | Status Change Form (All Other Changes) | Agent | The change described | — |

How a request moves:
1. **Requested.** The request is saved in the **Listing Changes** tab with a ready-to-fill payload (office, agent, MLS #, owners, address, listing dates and the new values).
2. **Out for signature.** The SkySlope task (`SKYSLOPE_TASK.md`, part D) adds the OneKey form to the deal's SkySlope file, fills it in, checks it, and **sends it for signature automatically**. If a signer has no email or a field can't be filled, it doesn't send and marks the request Needs Info. The signature link shows on the deal.
3. **Signed.** The SkySlope task sees the envelope is fully signed and queues the change for Matrix.
4. **Changed in Matrix.** The Matrix task (`MATRIX_TASK.md`, part C) makes exactly that change on the live listing and submits it. This is the only time the Matrix task submits anything, because the owner signed for it.
5. **Deal updated.** Within 5 minutes the Deal Tracker updates the deal's price, expiration or status. TOM is also written to the office inventory; other changes are left for you on the inventory sheet.

Guard rails:
- One open request per listing. The agent can withdraw a request until it's signed; if the form already went out, the SkySlope task voids that unsigned envelope.
- A listing can only go TOM or be withdrawn while it's on the market, and only come back from TOM or Withdrawn.
- Withdraw and Cancel require the agent to confirm that no negotiations are pending.
- An extension is refused more than 30 days after expiration (OneKey's rule: enter it as a new listing instead).
- **Withdrawn** is a new deal status. Like TOM and Cancelled, it isn't held to the stage requirements.

**Before first use:**
- MLS office codes (Dix Hills BRMN17, Farmingdale BRMN13) are set in `OFFICE_MLS_CODES` at the top of `ListingChanges.gs` and print on every form.
- Make sure the four OneKey forms are in your SkySlope forms library. The PDFs are in `forms/`.
- The firm representative defaults to you. To change it, set Script Properties `FIRM_REP_NAME` and `FIRM_REP_EMAIL`.

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
   - **One paste:** paste `DealTracker.gs` over the default code. It includes everything below.
   - **Or file by file:** paste `Code.gs` over the default code, add script files `Matrix.gs`, `ListingChanges.gs` and `MatrixSchemas.gs`, and add an HTML file named `Index` with `Index.html`.
   - Turn on "Show appsscript.json" in Project Settings, then paste `appsscript.json`.
3. **Run `setup`** and approve the permissions. That creates the tabs Deals, Agents, Milestone Log, Sync Log, Documents, MLS Listings and Listing Changes, and points at your Office Sheets. The MLS photo folder is created in your Drive the first time an agent uploads a photo.
4. **Fill in the Agents tab**:

   | Name | Email | PIN | Role | Active | Office | SkySlope Name |
   |---|---|---|---|---|---|---|

   - **Name** must match the Roster, so it lines up in the Agent(s) column.
   - **SkySlope Name** must match SkySlope's File Owner list exactly, e.g. "Kevin A. Key", "Abderrahmane "Joe" Messaoud", "Milly (Iankel) Baez".
   - **Office** is Dix Hills or Farmingdale.
   - **Role** is Admin for you; you'll see every agent's deals.
5. **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*. Send agents the `/exec` link.
6. **Create the SkySlope task** from the Claude desktop app using `SKYSLOPE_TASK.md`.
7. **Create the Matrix task** the same way using `MATRIX_TASK.md`. First confirm with OneKey MLS that assisted entry in your own signed-in browser is allowed.

**Already running the Deal Tracker?** Paste the new `DealTracker.gs` (or the four files), run `setup` once more to add the MLS Listings and Listing Changes tabs, then use **Deploy → Manage deployments → Edit → New version**. Agents keep the same link.

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
- The SkySlope task sends forms for signature automatically once they're filled in and checked (it holds them back if a signer has no email or details are missing). It never deletes or approves anything in SkySlope; your pending-review automation handles approval. The only thing it ever voids is the unsigned envelope of a listing change the agent withdrew.
