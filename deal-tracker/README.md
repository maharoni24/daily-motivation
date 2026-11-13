# Agent Deal Tracker

A private web form where your agents submit **Seller, Buyer, Tenant or Landlord** deals, edit them later, check off milestones as they happen, and upload documents. Each save:

1. Writes or updates a row in your **Google Sheet** (one row per deal, one column per field).
2. Logs every milestone change in a **Milestone Log** tab.
3. Sends the full deal as JSON to your **SkySlope** and **Darwin** automations (plus any other webhooks).

It runs on Google Apps Script, so there is no hosting cost and no new software for agents. They just open a link.

---

## What agents see

| Screen | What it does |
|---|---|
| Sign in | Email + PIN (or automatic, if your agents are on your Google Workspace domain) |
| My deals | Their deals only, with search, side/status filters, a progress bar and the next milestone |
| New deal | Pick Seller / Buyer / Tenant / Landlord, then only that side's fields appear |
| Deal details | Edit any field at any time |
| Milestones | Checklist with dates and notes. Checking "Under contract" / "Lease signed" moves the status to **Under Contract**, and "Closed" / "Move-in" moves it to **Closed** |
| Documents | Upload contracts, leases, disclosures and similar files into a Drive folder for that deal |

Admins (Role = `Admin` in the Agents tab) see every agent's deals and can filter by agent.

---

## Setup (about 15 minutes)

### 1. Create the Sheet and script
1. Create a new Google Sheet, for example "Deal Tracker".
   *If your existing automations already read from a specific Sheet, you can use that Sheet instead. See "Using an existing sheet" below.*
2. In the Sheet: **Extensions → Apps Script**.
3. Replace the contents of `Code.gs` with this repo's `Code.gs`.
4. **File → New → HTML**, name it `Index` (no `.html`), and paste in `Index.html`.
5. **Project Settings (gear) → check "Show appsscript.json"**, then replace it with this repo's `appsscript.json`. Change `timeZone` if you are not in Eastern time.

### 2. Run setup
1. In the editor's function dropdown choose **`setup`** and click **Run**. Approve the permissions (Sheets, Drive, and outbound requests for the webhooks).
2. Your Sheet now has four tabs: **Deals, Agents, Milestone Log, Sync Log**.
3. Open **Agents**. Your own row was added as Admin with a random PIN. Add one row per agent:

| Name | Email | PIN | Role | Active | Darwin Agent ID | SkySlope Agent ID |
|---|---|---|---|---|---|---|
| Jordan Smith | jordan@… | 4821 | Agent | Yes | (optional) | (optional) |

To remove someone, set **Active = No**. That takes effect immediately.

### 3. Connect SkySlope and Darwin
**Project Settings → Script Properties.** Fill in:

| Property | What to put |
|---|---|
| `SKYSLOPE_WEBHOOK_URL` | The webhook / "catch hook" URL of the Zap, Make scenario or other automation that creates and updates the transaction in SkySlope |
| `DARWIN_WEBHOOK_URL` | Same, for Darwin |
| `EXTRA_WEBHOOK_URLS` | Optional: more URLs, comma-separated (Slack alerts, CRM, etc.) |
| `WEBHOOK_SECRET` | Optional: any password. Each request then carries an `X-Deal-Tracker-Signature` header (HMAC-SHA256, base64) so the receiver can check that the request really came from this form |
| `DOCS_FOLDER_ID` | Optional: the Drive folder ID where deal folders go (otherwise one is created) |
| `SPREADSHEET_ID` | Optional: only if the script is not bound to the Sheet |

Then run **`sendTestWebhook`** once. Your Zapier/Make trigger receives a sample payload, so you can map fields.

**If your SkySlope/Darwin automations currently trigger from a Google Sheet row** (for example, "New or updated row in Google Sheets"), you don't need the webhook URLs. Point those automations at the **Deals** tab. The column headers are stable and listed in `Code.gs` (`FIELDS[].col`).

### 4. Publish the form
1. **Deploy → New deployment → Web app.**
2. *Execute as:* **Me**. *Who has access:* **Anyone with a Google account** (or **Anyone** if some agents don't use Google; the PIN still protects the data).
3. Copy the `/exec` URL and send it to your agents. They can add it to their phone's home screen.

After you change the code later: **Deploy → Manage deployments → Edit → Version: New version**. The URL stays the same.

---

## What gets sent to SkySlope / Darwin

The payload is the same on every save. The `event` field tells your automation what happened:

| `event` | When |
|---|---|
| `deal.created` | Agent submits a new deal |
| `deal.updated` | Agent edits fields (see `changed_fields`) |
| `milestone.updated` | One or more milestones were checked, unchecked, re-dated or noted (see `milestone_changes`) |
| `document.uploaded` | A document was uploaded (see `document.url`) |

```json
{
  "event": "milestone.updated",
  "deal": {
    "deal_id": "D261113-928D", "side": "Buyer", "status": "Under Contract",
    "agent_name": "...", "agent_email": "...",
    "property_address": "42 Oak Lane", "city": "Austin", "state": "TX", "zip": "78701",
    "full_address": "42 Oak Lane, Austin, TX, 78701",
    "client_name": "...", "price": "450000", "contract_date": "2026-11-10", "closing_date": "2026-12-15",
    "current_milestone": "Offer accepted / under contract", "next_milestone": "Earnest money delivered",
    "milestone_under_contract_done": true, "milestone_under_contract_date": "2026-11-13",
    "...": "every field and every milestone"
  },
  "agent": { "darwin_agent_id": "DW-77", "skyslope_agent_id": "SS-42" },
  "changed_fields": [],
  "milestone_changes": [{ "key": "under_contract", "label": "Offer accepted / under contract", "change": "completed", "date": "2026-11-13" }]
}
```

Tip for Zapier/Make: add a **filter on `event`** so that, for example, only `deal.created` creates a SkySlope transaction and the other events run an "update" step keyed on `deal_id`.

Every webhook call is recorded in the **Sync Log** tab. The deal's **Last Sync Result** column shows OK/FAILED, and the agent sees a warning if a sync fails.

---

## Customizing

Everything lives at the top of `Code.gs`:

- **Fields:** add, remove or relabel entries in `FIELDS`. `sides` controls which deal types show the field, `required: true` makes it mandatory, and `col` is the Sheet column header. After adding fields, run `upgradeColumns` to add the new columns without touching existing data.
- **Milestones:** edit the lists in `MILESTONES` for each side.
- **Auto-status:** `STATUS_TRIGGERS` maps a milestone to the status it sets.
- **Statuses:** `STATUSES`.

## Using an existing sheet
Put the script in that Sheet (Extensions → Apps Script) or set `SPREADSHEET_ID`. `setup` only adds missing tabs and columns and never deletes anything. Columns that other automations add to the Deals tab are kept when agents edit a deal.

## Security notes
- Agents can only see and edit their own deals. This is enforced on the server, not just hidden in the page.
- After 5 wrong PINs, that email is locked for 15 minutes. Sessions expire after 6 hours.
- PINs sit in the Agents tab, so share the Sheet only with admins.
- Uploaded documents go to a Drive folder owned by you. The agent is added as an editor of their own deal folders.
