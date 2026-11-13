/**
 * AGENT DEAL TRACKER
 * Google Apps Script web app: agents submit, edit and update milestones on
 * Seller / Buyer / Tenant / Landlord deals. Google Sheets is the system of
 * record; every save is pushed to SkySlope, Darwin and any other webhook.
 *
 * Setup: see README.md. Run `setup()` once from the editor.
 */

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

var APP_NAME = 'Agent Deal Tracker';

var SHEETS = {
  DEALS: 'Deals',
  AGENTS: 'Agents',
  MILESTONE_LOG: 'Milestone Log',
  SYNC_LOG: 'Sync Log'
};

var SIDES = ['Seller', 'Buyer', 'Tenant', 'Landlord'];

var STATUSES = ['Active', 'Under Contract', 'Closed', 'On Hold', 'Cancelled'];

var ALL = SIDES;
var SALE = ['Seller', 'Buyer'];
var LEASE = ['Tenant', 'Landlord'];

/**
 * Every deal field. `col` is the column header in the Deals sheet (keep these
 * stable if other automations map to them). `labels` overrides the on-screen
 * label per side.
 */
var FIELDS = [
  // ---- Property
  { key: 'property_address', col: 'Property Address', label: 'Street address', type: 'text', sides: ALL, section: 'Property', required: true },
  { key: 'unit', col: 'Unit', label: 'Unit / Apt #', type: 'text', sides: ALL, section: 'Property' },
  { key: 'city', col: 'City', label: 'City', type: 'text', sides: ALL, section: 'Property', required: true },
  { key: 'state', col: 'State', label: 'State', type: 'text', sides: ALL, section: 'Property', required: true },
  { key: 'zip', col: 'Zip', label: 'Zip', type: 'text', sides: ALL, section: 'Property', required: true },
  { key: 'county', col: 'County', label: 'County', type: 'text', sides: ALL, section: 'Property' },
  { key: 'mls_number', col: 'MLS #', label: 'MLS #', type: 'text', sides: ALL, section: 'Property' },
  { key: 'property_type', col: 'Property Type', label: 'Property type', type: 'select', sides: ALL, section: 'Property',
    options: ['Single Family', 'Condo', 'Townhome', 'Multi-Family', 'Land', 'Commercial', 'Manufactured', 'Other'] },

  // ---- Client
  { key: 'client_name', col: 'Client Name', label: 'Client name', type: 'text', sides: ALL, section: 'Client', required: true,
    labels: { Seller: 'Seller name', Buyer: 'Buyer name', Tenant: 'Tenant name', Landlord: 'Landlord / owner name' } },
  { key: 'client2_name', col: 'Client 2 Name', label: 'Co-client name', type: 'text', sides: ALL, section: 'Client' },
  { key: 'client_email', col: 'Client Email', label: 'Client email', type: 'email', sides: ALL, section: 'Client', required: true },
  { key: 'client_phone', col: 'Client Phone', label: 'Client phone', type: 'tel', sides: ALL, section: 'Client', required: true },
  { key: 'client_address', col: 'Client Mailing Address', label: 'Client mailing address (if different)', type: 'text', sides: ALL, section: 'Client' },
  { key: 'lead_source', col: 'Lead Source', label: 'Lead source', type: 'select', sides: ALL, section: 'Client',
    options: ['Sphere / Referral', 'Past Client', 'Online Lead', 'Open House', 'Sign Call', 'Company Lead', 'Agent Referral', 'Social Media', 'Other'] },

  // ---- Sale terms (Seller)
  { key: 'listing_agreement_date', col: 'Listing Agreement Date', label: 'Listing agreement signed', type: 'date', sides: ['Seller', 'Landlord'], section: 'Terms' },
  { key: 'listing_expiration', col: 'Listing Expiration', label: 'Listing expiration', type: 'date', sides: ['Seller', 'Landlord'], section: 'Terms' },
  { key: 'list_price', col: 'List Price', label: 'List price', type: 'money', sides: ['Seller'], section: 'Terms' },
  { key: 'buyer_agreement_date', col: 'Buyer Agreement Date', label: 'Buyer agreement signed', type: 'date', sides: ['Buyer'], section: 'Terms' },
  { key: 'buyer_agreement_expiration', col: 'Buyer Agreement Expiration', label: 'Buyer agreement expiration', type: 'date', sides: ['Buyer'], section: 'Terms' },
  { key: 'price', col: 'Sale / Purchase Price', label: 'Contract price', type: 'money', sides: SALE, section: 'Terms',
    labels: { Seller: 'Accepted sale price', Buyer: 'Purchase price' } },
  { key: 'contract_date', col: 'Contract / Effective Date', label: 'Contract effective date', type: 'date', sides: SALE, section: 'Terms' },
  { key: 'closing_date', col: 'Closing Date', label: 'Scheduled closing date', type: 'date', sides: SALE, section: 'Terms' },
  { key: 'earnest_money', col: 'Earnest Money', label: 'Earnest money', type: 'money', sides: SALE, section: 'Terms' },
  { key: 'option_fee', col: 'Option Fee', label: 'Option / due-diligence fee', type: 'money', sides: SALE, section: 'Terms' },
  { key: 'option_end_date', col: 'Option Period End', label: 'Option / inspection period ends', type: 'date', sides: SALE, section: 'Terms' },
  { key: 'financing_type', col: 'Financing Type', label: 'Financing type', type: 'select', sides: SALE, section: 'Terms',
    options: ['Conventional', 'FHA', 'VA', 'USDA', 'Cash', 'Jumbo', 'Seller Finance', 'Other'] },
  { key: 'appraisal_deadline', col: 'Appraisal Deadline', label: 'Appraisal deadline', type: 'date', sides: SALE, section: 'Terms' },
  { key: 'financing_deadline', col: 'Financing Deadline', label: 'Financing contingency deadline', type: 'date', sides: SALE, section: 'Terms' },
  { key: 'seller_concessions', col: 'Seller Concessions', label: 'Seller concessions', type: 'money', sides: SALE, section: 'Terms' },

  // ---- Lease terms
  { key: 'monthly_rent', col: 'Monthly Rent', label: 'Monthly rent', type: 'money', sides: LEASE, section: 'Terms',
    labels: { Landlord: 'Monthly rent (listed / leased)' } },
  { key: 'application_date', col: 'Application Date', label: 'Application date', type: 'date', sides: LEASE, section: 'Terms' },
  { key: 'lease_start', col: 'Lease Start', label: 'Lease start', type: 'date', sides: LEASE, section: 'Terms' },
  { key: 'lease_end', col: 'Lease End', label: 'Lease end', type: 'date', sides: LEASE, section: 'Terms' },
  { key: 'lease_term_months', col: 'Lease Term (Months)', label: 'Lease term (months)', type: 'number', sides: LEASE, section: 'Terms' },
  { key: 'security_deposit', col: 'Security Deposit', label: 'Security deposit', type: 'money', sides: LEASE, section: 'Terms' },
  { key: 'pets', col: 'Pets', label: 'Pets', type: 'select', sides: LEASE, section: 'Terms', options: ['No', 'Yes'] },
  { key: 'property_management', col: 'Property Management', label: 'Service type', type: 'select', sides: ['Landlord'], section: 'Terms',
    options: ['Lease only', 'Lease & manage'] },

  // ---- Compensation
  { key: 'commission_pct', col: 'Commission %', label: 'Commission %', type: 'number', sides: ALL, section: 'Compensation' },
  { key: 'commission_flat', col: 'Commission Flat $', label: 'Commission flat $ (if not %)', type: 'money', sides: ALL, section: 'Compensation' },
  { key: 'other_side_comp', col: 'Other-Side Compensation', label: 'Compensation offered to other side', type: 'text', sides: ALL, section: 'Compensation' },
  { key: 'referral_fee', col: 'Referral Fee', label: 'Referral fee owed (% or $, to whom)', type: 'text', sides: ALL, section: 'Compensation' },
  { key: 'co_agent', col: 'Co-Agent / Split', label: 'Co-agent & split', type: 'text', sides: ALL, section: 'Compensation' },

  // ---- Other parties
  { key: 'other_party_name', col: 'Other Party Name', label: 'Other party name', type: 'text', sides: ALL, section: 'Other Parties',
    labels: { Seller: 'Buyer name', Buyer: 'Seller name', Tenant: 'Landlord / property manager', Landlord: 'Tenant name' } },
  { key: 'other_agent_name', col: 'Other Agent', label: 'Other agent', type: 'text', sides: ALL, section: 'Other Parties' },
  { key: 'other_agent_brokerage', col: 'Other Brokerage', label: 'Other brokerage', type: 'text', sides: ALL, section: 'Other Parties' },
  { key: 'other_agent_email', col: 'Other Agent Email', label: 'Other agent email', type: 'email', sides: ALL, section: 'Other Parties' },
  { key: 'other_agent_phone', col: 'Other Agent Phone', label: 'Other agent phone', type: 'tel', sides: ALL, section: 'Other Parties' },
  { key: 'title_company', col: 'Title / Escrow Company', label: 'Title / escrow company', type: 'text', sides: SALE, section: 'Other Parties' },
  { key: 'title_contact', col: 'Escrow Officer', label: 'Escrow officer (name, email, phone)', type: 'text', sides: SALE, section: 'Other Parties' },
  { key: 'lender_name', col: 'Lender', label: 'Lender', type: 'text', sides: SALE, section: 'Other Parties' },
  { key: 'loan_officer', col: 'Loan Officer', label: 'Loan officer (name, email, phone)', type: 'text', sides: SALE, section: 'Other Parties' },

  // ---- Notes
  { key: 'notes', col: 'Notes', label: 'Notes for the office / transaction coordinator', type: 'textarea', sides: ALL, section: 'Notes' }
];

/** Milestone checklists per side, in the order they normally happen. */
var MILESTONES = {
  Seller: [
    { key: 'listing_signed', label: 'Listing agreement signed' },
    { key: 'listed_live', label: 'Active on MLS' },
    { key: 'under_contract', label: 'Offer accepted / under contract' },
    { key: 'em_received', label: 'Earnest money received by title' },
    { key: 'inspection', label: 'Inspection completed' },
    { key: 'option_ends', label: 'Option / due-diligence period ended' },
    { key: 'appraisal', label: 'Appraisal completed' },
    { key: 'financing', label: 'Buyer loan approved' },
    { key: 'clear_to_close', label: 'Clear to close' },
    { key: 'closed', label: 'Closed & funded' }
  ],
  Buyer: [
    { key: 'buyer_agreement', label: 'Buyer agreement signed' },
    { key: 'preapproval', label: 'Pre-approval / proof of funds received' },
    { key: 'offer_submitted', label: 'Offer submitted' },
    { key: 'under_contract', label: 'Offer accepted / under contract' },
    { key: 'em_delivered', label: 'Earnest money delivered' },
    { key: 'inspection', label: 'Inspection completed' },
    { key: 'option_ends', label: 'Option / due-diligence period ended' },
    { key: 'appraisal', label: 'Appraisal completed' },
    { key: 'financing', label: 'Loan approved' },
    { key: 'clear_to_close', label: 'Clear to close' },
    { key: 'final_walkthrough', label: 'Final walkthrough' },
    { key: 'closed', label: 'Closed & funded' }
  ],
  Tenant: [
    { key: 'rep_agreement', label: 'Tenant representation agreement signed' },
    { key: 'showings', label: 'Showings started' },
    { key: 'application', label: 'Application submitted' },
    { key: 'approved', label: 'Application approved' },
    { key: 'lease_signed', label: 'Lease signed' },
    { key: 'deposit_paid', label: 'Deposit & first month paid' },
    { key: 'move_in', label: 'Move-in / keys delivered' }
  ],
  Landlord: [
    { key: 'listing_signed', label: 'Lease listing agreement signed' },
    { key: 'listed_live', label: 'Active on MLS' },
    { key: 'application', label: 'Application received' },
    { key: 'screening', label: 'Tenant screened & approved' },
    { key: 'lease_signed', label: 'Lease signed' },
    { key: 'deposit_collected', label: 'Deposit & first month collected' },
    { key: 'move_in', label: 'Move-in / keys delivered' }
  ]
};

/** Milestones that automatically move the deal status forward. */
var STATUS_TRIGGERS = {
  under_contract: 'Under Contract',
  lease_signed: 'Under Contract',
  closed: 'Closed',
  move_in: 'Closed'
};

var SYSTEM_COLUMNS_START = [
  'Deal ID', 'Created At', 'Updated At', 'Agent Name', 'Agent Email', 'Side', 'Status',
  'Current Milestone', 'Current Milestone Date', 'Next Milestone', 'Milestones Done'
];
var SYSTEM_COLUMNS_END = ['Milestone Summary', 'Milestones JSON', 'Documents Folder', 'Last Sync Result'];

var MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
var SESSION_HOURS = 6;

// ---------------------------------------------------------------------------
// WEB APP ENTRY
// ---------------------------------------------------------------------------

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Everything the front end needs to build the forms. */
function getAppConfig() {
  return {
    appName: APP_NAME,
    sides: SIDES,
    statuses: STATUSES,
    fields: FIELDS,
    milestones: MILESTONES,
    maxUploadBytes: MAX_UPLOAD_BYTES
  };
}

// ---------------------------------------------------------------------------
// SETUP (run once from the Apps Script editor)
// ---------------------------------------------------------------------------

function setup() {
  var ss = getSpreadsheet_();
  formatDealColumns_(ensureSheet_(ss, SHEETS.DEALS, dealHeaders_()));
  var agents = ensureSheet_(ss, SHEETS.AGENTS, ['Name', 'Email', 'PIN', 'Role', 'Active', 'Darwin Agent ID', 'SkySlope Agent ID']);
  ensureSheet_(ss, SHEETS.MILESTONE_LOG, ['Timestamp', 'Deal ID', 'Side', 'Property Address', 'Agent Email', 'Milestone', 'Change', 'Milestone Date', 'Note']);
  ensureSheet_(ss, SHEETS.SYNC_LOG, ['Timestamp', 'Deal ID', 'Event', 'Target', 'HTTP Status', 'Response (first 500 chars)']);

  if (agents.getLastRow() < 2) {
    var me = Session.getEffectiveUser().getEmail();
    agents.appendRow(['Broker / Admin', me, String(randomPin_()), 'Admin', 'Yes', '', '']);
  }
  agents.getRange('C:C').setNumberFormat('@'); // keep PIN leading zeros

  var props = PropertiesService.getScriptProperties();
  ['SKYSLOPE_WEBHOOK_URL', 'DARWIN_WEBHOOK_URL', 'EXTRA_WEBHOOK_URLS', 'WEBHOOK_SECRET', 'DOCS_FOLDER_ID'].forEach(function (k) {
    if (props.getProperty(k) === null) props.setProperty(k, '');
  });

  Logger.log('Setup complete. Open the "Agents" tab to add your agents and their PINs.');
}

/** Adds any new columns (e.g. after you add a field) without touching data. */
function upgradeColumns() {
  formatDealColumns_(ensureSheet_(getSpreadsheet_(), SHEETS.DEALS, dealHeaders_()));
}

/** Text columns stay text (so zip 07001 doesn't become 7001). */
function formatDealColumns_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var textCols = ['Deal ID', 'Agent Email'];
  FIELDS.forEach(function (f) { if (['text', 'tel', 'email', 'textarea', 'select'].indexOf(f.type) >= 0) textCols.push(f.col); });
  headers.forEach(function (h, i) {
    if (textCols.indexOf(h) >= 0) sheet.getRange(2, i + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  });
  var w = headers.indexOf('Milestone Summary');
  if (w >= 0) sheet.setColumnWidth(w + 1, 320);
}

/** Sends a sample payload to every configured webhook so you can map fields. */
function sendTestWebhook() {
  var sample = { deal_id: 'TEST-0001', side: 'Buyer', status: 'Under Contract', property_address: '123 Main St',
    city: 'Anytown', state: 'TX', zip: '75001', client_name: 'Test Client', agent_email: 'agent@example.com' };
  var results = pushToIntegrations_('deal.test', sample, { changed_fields: [], milestone_changes: [] });
  Logger.log(JSON.stringify(results, null, 2));
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

/**
 * If the agent is signed into a Google account the script can see (same
 * Workspace domain), log them straight in. Otherwise the UI asks for a PIN.
 */
function tryAutoLogin() {
  var email = '';
  try { email = (Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  if (!email) return null;
  var agent = findAgent_(email);
  if (!agent || !agent.active) return null;
  return startSession_(agent);
}

function login(email, pin) {
  email = String(email || '').trim().toLowerCase();
  pin = String(pin || '').trim();
  if (!email || !pin) throw new Error('Enter your email and PIN.');

  var cache = CacheService.getScriptCache();
  var failKey = 'fail_' + email;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw new Error('Too many attempts. Try again in 15 minutes or ask your broker to reset your PIN.');

  var agent = findAgent_(email);
  if (!agent || !agent.active || agent.pin !== pin) {
    cache.put(failKey, String(fails + 1), 15 * 60);
    throw new Error('Email or PIN not recognized.');
  }
  cache.remove(failKey);
  return startSession_(agent);
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return true;
}

function startSession_(agent) {
  var token = Utilities.getUuid();
  var session = { email: agent.email, name: agent.name, isAdmin: agent.isAdmin };
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(session), SESSION_HOURS * 3600);
  return { token: token, user: session };
}

function requireSession_(token) {
  var raw = token ? CacheService.getScriptCache().get('sess_' + token) : null;
  if (!raw) throw new Error('SESSION_EXPIRED');
  return JSON.parse(raw);
}

function findAgent_(email) {
  var sheet = getSpreadsheet_().getSheetByName(SHEETS.AGENTS);
  if (!sheet) throw new Error('Run setup() first.');
  var rows = sheet.getDataRange().getValues();
  var h = indexHeaders_(rows[0]);
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (String(r[h['Email']]).trim().toLowerCase() === email) {
      return {
        name: String(r[h['Name']] || '').trim(),
        email: email,
        pin: String(r[h['PIN']] || '').trim(),
        isAdmin: String(r[h['Role']] || '').trim().toLowerCase() === 'admin',
        active: String(r[h['Active']] || 'Yes').trim().toLowerCase() !== 'no',
        darwinId: h['Darwin Agent ID'] != null ? String(r[h['Darwin Agent ID']] || '') : '',
        skyslopeId: h['SkySlope Agent ID'] != null ? String(r[h['SkySlope Agent ID']] || '') : ''
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DEALS API (called from the web page)
// ---------------------------------------------------------------------------

function listDeals(token) {
  var user = requireSession_(token);
  var data = readDeals_();
  return data.deals
    .filter(function (d) { return user.isAdmin || d.agent_email === user.email; })
    .map(function (d) {
      return {
        deal_id: d.deal_id, side: d.side, status: d.status, agent_name: d.agent_name, agent_email: d.agent_email,
        property_address: d.property_address, unit: d.unit, city: d.city, client_name: d.client_name,
        current_milestone: d.current_milestone, current_milestone_date: d.current_milestone_date,
        next_milestone: d.next_milestone, milestones_done: d.milestones_done,
        milestones_total: (MILESTONES[d.side] || []).length,
        closing_date: d.closing_date || d.lease_start || '', updated_at: d.updated_at
      };
    })
    .sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
}

function getDeal(token, dealId) {
  var user = requireSession_(token);
  var found = findDealRow_(dealId);
  if (!found) throw new Error('Deal not found.');
  assertCanAccess_(user, found.deal);
  var deal = found.deal;
  deal.documents = listDocuments_(deal);
  return deal;
}

/**
 * Create (no deal_id) or update (with deal_id) a deal, including milestones.
 * `input` = { deal_id?, side, status, fields: {key: value}, milestones: {key: {done, date, note}} }
 */
function saveDeal(token, input) {
  var user = requireSession_(token);
  if (!input || SIDES.indexOf(input.side) < 0) throw new Error('Choose Seller, Buyer, Tenant or Landlord.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var result;
  try {
    var sheet = getSpreadsheet_().getSheetByName(SHEETS.DEALS);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var now = isoNow_();
    var existing = input.deal_id ? findDealRow_(input.deal_id) : null;
    if (input.deal_id && !existing) throw new Error('Deal not found.');
    if (existing) assertCanAccess_(user, existing.deal);

    var before = existing ? existing.deal : {};
    var deal = existing ? JSON.parse(JSON.stringify(before)) : {
      deal_id: newDealId_(), created_at: now, agent_name: user.name, agent_email: user.email, documents_folder: ''
    };
    deal.side = input.side;
    deal.updated_at = now;

    // Fields (only the ones that apply to this side)
    var errors = [];
    FIELDS.forEach(function (f) {
      if (f.sides.indexOf(deal.side) < 0) return;
      var v = input.fields && input.fields[f.key] != null ? String(input.fields[f.key]).trim() : '';
      if (f.type === 'money' || f.type === 'number') v = v.replace(/[$,\s]/g, '');
      if (f.required && !v) errors.push(labelFor_(f, deal.side));
      deal[f.key] = v;
    });
    if (errors.length) throw new Error('Required: ' + errors.join(', '));

    // Milestones
    var oldMs = before.milestones || {};
    var newMs = {};
    var msChanges = [];
    (MILESTONES[deal.side] || []).forEach(function (m) {
      var inMs = (input.milestones && input.milestones[m.key]) || {};
      var done = !!inMs.done;
      var date = done ? (inMs.date || todayStr_()) : (inMs.date || '');
      var note = String(inMs.note || '').trim();
      newMs[m.key] = { done: done, date: date, note: note };
      var o = oldMs[m.key] || {};
      if (!!o.done !== done || (done && o.date !== date) || (o.note || '') !== note) {
        msChanges.push({ key: m.key, label: m.label, change: done ? (o.done ? 'updated' : 'completed') : (o.done ? 'reopened' : 'noted'), date: date, note: note });
      }
    });
    deal.milestones = newMs;
    applyMilestoneSummary_(deal);

    // Status: manual choice, but milestones push it forward automatically
    var status = STATUSES.indexOf(input.status) >= 0 ? input.status : (before.status || 'Active');
    msChanges.forEach(function (c) {
      if (c.change === 'completed' && STATUS_TRIGGERS[c.key] && status !== 'Cancelled') {
        if (!(STATUS_TRIGGERS[c.key] === 'Under Contract' && status === 'Closed')) status = STATUS_TRIGGERS[c.key];
      }
    });
    deal.status = status;

    var changedFields = existing ? diffFields_(before, deal) : [];

    // Write row
    var row = headers.map(function (h) { return toCell_(h, deal); });
    if (existing) {
      sheet.getRange(existing.rowIndex, 1, 1, headers.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }

    // Milestone log
    if (msChanges.length) {
      var log = getSpreadsheet_().getSheetByName(SHEETS.MILESTONE_LOG);
      msChanges.forEach(function (c) {
        log.appendRow([now, deal.deal_id, deal.side, deal.property_address, user.email, c.label, c.change, c.date, c.note]);
      });
    }
    SpreadsheetApp.flush();

    result = { deal: deal, isNew: !existing, changedFields: changedFields, msChanges: msChanges };
  } finally {
    lock.releaseLock();
  }

  // Push to integrations outside the lock
  var event = result.isNew ? 'deal.created' : (result.msChanges.length ? 'milestone.updated' : 'deal.updated');
  if (result.isNew || result.changedFields.length || result.msChanges.length) {
    var syncResults = pushToIntegrations_(event, flattenDeal_(result.deal), {
      changed_fields: result.changedFields,
      milestone_changes: result.msChanges
    });
    writeSyncSummary_(result.deal.deal_id, syncResults);
    result.sync = syncResults;
  } else {
    result.sync = [];
  }

  return { deal_id: result.deal.deal_id, isNew: result.isNew, status: result.deal.status, sync: result.sync };
}

// ---------------------------------------------------------------------------
// DOCUMENTS (saved in Google Drive, one folder per deal)
// ---------------------------------------------------------------------------

function uploadDocument(token, dealId, file) {
  var user = requireSession_(token);
  var found = findDealRow_(dealId);
  if (!found) throw new Error('Save the deal before uploading documents.');
  assertCanAccess_(user, found.deal);
  if (!file || !file.data) throw new Error('No file received.');

  var bytes = Utilities.base64Decode(file.data);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('File is larger than 20 MB.');

  var folder = getDealFolder_(found);
  var blob = Utilities.newBlob(bytes, file.mimeType || 'application/octet-stream', file.name || 'document');
  var saved = folder.createFile(blob);
  if (file.category) saved.setDescription(file.category);

  var flat = flattenDeal_(found.deal);
  var syncResults = pushToIntegrations_('document.uploaded', flat, {
    document: { name: saved.getName(), url: saved.getUrl(), id: saved.getId(), category: file.category || '', mime_type: saved.getMimeType() }
  });
  writeSyncSummary_(dealId, syncResults);
  return listDocuments_(found.deal);
}

function getDealFolder_(found) {
  var deal = found.deal;
  if (deal.documents_folder) {
    var id = extractDriveId_(deal.documents_folder);
    if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  }
  var props = PropertiesService.getScriptProperties();
  var rootId = props.getProperty('DOCS_FOLDER_ID');
  var root;
  try { root = rootId ? DriveApp.getFolderById(rootId) : null; } catch (e) { root = null; }
  if (!root) {
    root = DriveApp.createFolder(APP_NAME + ' Documents');
    props.setProperty('DOCS_FOLDER_ID', root.getId());
  }
  var folder = root.createFolder(deal.deal_id + ' - ' + (deal.property_address || 'Deal') + ' (' + deal.side + ')');
  try { folder.addEditor(deal.agent_email); } catch (e) { /* non-Google email: links still work for admins */ }

  var sheet = getSpreadsheet_().getSheetByName(SHEETS.DEALS);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col = headers.indexOf('Documents Folder');
  if (col >= 0) sheet.getRange(found.rowIndex, col + 1).setValue(folder.getUrl());
  deal.documents_folder = folder.getUrl();
  return folder;
}

function listDocuments_(deal) {
  var id = extractDriveId_(deal.documents_folder);
  if (!id) return [];
  try {
    var it = DriveApp.getFolderById(id).getFiles();
    var out = [];
    while (it.hasNext()) {
      var f = it.next();
      out.push({ name: f.getName(), url: f.getUrl(), category: f.getDescription() || '', uploaded: f.getDateCreated().toISOString() });
    }
    return out.sort(function (a, b) { return b.uploaded.localeCompare(a.uploaded); });
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// INTEGRATIONS: SkySlope, Darwin, anything else (via webhooks)
// ---------------------------------------------------------------------------

/**
 * Sends one JSON payload to each configured webhook URL. Point these at the
 * Zapier / Make / n8n "catch hook" that already drives your SkySlope and
 * Darwin automations (or directly at an endpoint that accepts JSON).
 */
function pushToIntegrations_(event, flatDeal, extra) {
  var props = PropertiesService.getScriptProperties();
  var targets = [];
  var sky = (props.getProperty('SKYSLOPE_WEBHOOK_URL') || '').trim();
  var darwin = (props.getProperty('DARWIN_WEBHOOK_URL') || '').trim();
  if (sky) targets.push({ name: 'SkySlope', url: sky });
  if (darwin) targets.push({ name: 'Darwin', url: darwin });
  String(props.getProperty('EXTRA_WEBHOOK_URLS') || '').split(/[\s,]+/).filter(String).forEach(function (u, i) {
    targets.push({ name: 'Webhook ' + (i + 1), url: u });
  });
  if (!targets.length) return [];

  var agent = flatDeal.agent_email ? findAgent_(flatDeal.agent_email) : null;
  var payload = {
    event: event,
    sent_at: isoNow_(),
    source: APP_NAME,
    deal: flatDeal,
    agent: {
      name: flatDeal.agent_name, email: flatDeal.agent_email,
      darwin_agent_id: agent ? agent.darwinId : '', skyslope_agent_id: agent ? agent.skyslopeId : ''
    },
    changed_fields: (extra && extra.changed_fields) || [],
    milestone_changes: (extra && extra.milestone_changes) || [],
    document: (extra && extra.document) || null,
    sheet_url: getSpreadsheet_().getUrl()
  };
  var secret = (props.getProperty('WEBHOOK_SECRET') || '').trim();
  var body = JSON.stringify(payload);
  var headers = {};
  if (secret) {
    headers['X-Deal-Tracker-Signature'] = Utilities.base64Encode(
      Utilities.computeHmacSha256Signature(body, secret));
  }

  var requests = targets.map(function (t) {
    return { url: t.url, method: 'post', contentType: 'application/json', payload: body, headers: headers, muteHttpExceptions: true, followRedirects: true };
  });

  var results = [];
  var responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    responses = null;
    targets.forEach(function (t) { results.push({ target: t.name, ok: false, status: 0, response: String(e) }); });
  }
  if (responses) {
    responses.forEach(function (r, i) {
      var code = r.getResponseCode();
      results.push({ target: targets[i].name, ok: code >= 200 && code < 300, status: code, response: r.getContentText().slice(0, 500) });
    });
  }

  var log = getSpreadsheet_().getSheetByName(SHEETS.SYNC_LOG);
  if (log) {
    results.forEach(function (r) {
      log.appendRow([isoNow_(), flatDeal.deal_id, event, r.target, r.status, r.response]);
    });
  }
  return results.map(function (r) { return { target: r.target, ok: r.ok, status: r.status }; });
}

function writeSyncSummary_(dealId, results) {
  if (!results || !results.length) return;
  var found = findDealRow_(dealId);
  if (!found) return;
  var sheet = getSpreadsheet_().getSheetByName(SHEETS.DEALS);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col = headers.indexOf('Last Sync Result');
  if (col < 0) return;
  var text = isoNow_() + ' ' + results.map(function (r) { return r.target + ':' + (r.ok ? 'OK' : 'FAILED ' + r.status); }).join(' | ');
  sheet.getRange(found.rowIndex, col + 1).setValue(text);
}

/** Flat object: every field + every milestone as milestone_<key>_done/date. */
function flattenDeal_(deal) {
  var out = {
    deal_id: deal.deal_id, created_at: deal.created_at, updated_at: deal.updated_at,
    agent_name: deal.agent_name, agent_email: deal.agent_email, side: deal.side, status: deal.status,
    current_milestone: deal.current_milestone, current_milestone_date: deal.current_milestone_date,
    next_milestone: deal.next_milestone, milestones_done: deal.milestones_done,
    milestones_total: (MILESTONES[deal.side] || []).length, documents_folder: deal.documents_folder || ''
  };
  FIELDS.forEach(function (f) { out[f.key] = deal[f.key] || ''; });
  out.full_address = [deal.property_address, deal.unit, deal.city, deal.state, deal.zip].filter(String).join(', ');
  (MILESTONES[deal.side] || []).forEach(function (m) {
    var s = (deal.milestones || {})[m.key] || {};
    out['milestone_' + m.key + '_done'] = !!s.done;
    out['milestone_' + m.key + '_date'] = s.date || '';
  });
  return out;
}

// ---------------------------------------------------------------------------
// SHEET HELPERS
// ---------------------------------------------------------------------------

function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function dealHeaders_() {
  var cols = SYSTEM_COLUMNS_START.slice();
  FIELDS.forEach(function (f) { if (cols.indexOf(f.col) < 0) cols.push(f.col); });
  return cols.concat(SYSTEM_COLUMNS_END);
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var lastCol = sheet.getLastColumn();
  var existing = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  var missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
  if (!existing.filter(String).length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (missing.length) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  }
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  return sheet;
}

/** Map of system column header -> deal property. Field columns map via FIELDS. */
var SYSTEM_KEYS = {
  'Deal ID': 'deal_id', 'Created At': 'created_at', 'Updated At': 'updated_at', 'Agent Name': 'agent_name',
  'Agent Email': 'agent_email', 'Side': 'side', 'Status': 'status', 'Current Milestone': 'current_milestone',
  'Current Milestone Date': 'current_milestone_date', 'Next Milestone': 'next_milestone',
  'Milestones Done': 'milestones_done', 'Milestone Summary': 'milestone_summary',
  'Documents Folder': 'documents_folder', 'Last Sync Result': 'last_sync'
};

function colToKey_() {
  var map = {};
  Object.keys(SYSTEM_KEYS).forEach(function (h) { map[h] = SYSTEM_KEYS[h]; });
  FIELDS.forEach(function (f) { map[f.col] = f.key; });
  return map;
}

function toCell_(header, deal) {
  if (header === 'Milestones JSON') return JSON.stringify(deal.milestones || {});
  var key = colToKey_()[header];
  if (!key) return (deal._extra && deal._extra[header] != null) ? deal._extra[header] : ''; // keep columns other automations added
  var v = deal[key];
  return v == null ? '' : v;
}

function readDeals_() {
  var sheet = getSpreadsheet_().getSheetByName(SHEETS.DEALS);
  if (!sheet) throw new Error('Run setup() first.');
  var values = sheet.getDataRange().getValues();
  var display = sheet.getDataRange().getDisplayValues();
  var headers = values[0].map(String);
  var map = colToKey_();
  var deals = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    var d = { _row: i + 1, _extra: {} };
    headers.forEach(function (h, c) {
      if (h === 'Milestones JSON') {
        try { d.milestones = JSON.parse(values[i][c] || '{}'); } catch (e) { d.milestones = {}; }
        return;
      }
      var key = map[h];
      var v = values[i][c];
      var out = v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(display[i][c] === '' ? '' : (typeof v === 'number' ? v : display[i][c]));
      if (key) d[key] = out; else if (h) d._extra[h] = v;
    });
    if (d.agent_email) d.agent_email = d.agent_email.toLowerCase();
    deals.push(d);
  }
  return { sheet: sheet, headers: headers, deals: deals };
}

function findDealRow_(dealId) {
  var data = readDeals_();
  for (var i = 0; i < data.deals.length; i++) {
    if (data.deals[i].deal_id === dealId) {
      var deal = data.deals[i];
      var rowIndex = deal._row;
      return { rowIndex: rowIndex, deal: deal };
    }
  }
  return null;
}

function assertCanAccess_(user, deal) {
  if (!user.isAdmin && deal.agent_email !== user.email) throw new Error('You can only open your own deals.');
}

function applyMilestoneSummary_(deal) {
  var list = MILESTONES[deal.side] || [];
  var ms = deal.milestones || {};
  var lastDone = null, next = null, count = 0;
  list.forEach(function (m) {
    var s = ms[m.key] || {};
    if (s.done) { count++; lastDone = { label: m.label, date: s.date }; }
  });
  for (var i = 0; i < list.length; i++) {
    if (!(ms[list[i].key] || {}).done) { next = list[i]; break; }
  }
  deal.current_milestone = lastDone ? lastDone.label : 'Not started';
  deal.current_milestone_date = lastDone ? lastDone.date : '';
  deal.next_milestone = next ? next.label : 'All milestones complete';
  deal.milestones_done = count + ' / ' + list.length;
  deal.milestone_summary = list.map(function (m) {
    var s = ms[m.key] || {};
    return (s.done ? '✔ ' : '○ ') + m.label + (s.date ? ' (' + s.date + ')' : '');
  }).join('\n');
}

function diffFields_(before, after) {
  var changed = [];
  ['side', 'status'].concat(FIELDS.map(function (f) { return f.key; })).forEach(function (k) {
    if (String(before[k] || '') !== String(after[k] || '')) changed.push(k);
  });
  return changed;
}

// ---------------------------------------------------------------------------
// SMALL UTILITIES
// ---------------------------------------------------------------------------

function labelFor_(f, side) { return (f.labels && f.labels[side]) || f.label; }

function newDealId_() {
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyMMdd');
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < 4; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return 'D' + stamp + '-' + s;
}

function randomPin_() { return Math.floor(100000 + Math.random() * 900000); }

function isoNow_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"); }

function todayStr_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

function indexHeaders_(row) {
  var h = {};
  row.forEach(function (name, i) { h[String(name).trim()] = i; });
  return h;
}

function extractDriveId_(urlOrId) {
  if (!urlOrId) return '';
  var m = String(urlOrId).match(/[-\w]{25,}/);
  return m ? m[0] : '';
}
