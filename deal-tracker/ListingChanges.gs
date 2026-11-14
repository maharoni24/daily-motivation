/**
 * LISTING CHANGES — price change, temporarily off market, back on market, withdraw, cancel, extend.
 *
 * On a Seller or Landlord deal that is on the MLS, the agent (or Mac) requests a change from the
 * "Listing changes" tab. Each request moves through:
 *
 *   Requested ──SkySlope task fills + sends──▶ Out for Signature ──everyone signs──▶ Signed
 *      └─▶ Matrix Status = Queued ──Matrix task──▶ Updated in Matrix ──this script──▶ deal updated (Applied)
 *
 *   - The SkySlope task (SKYSLOPE_TASK.md, part D) adds the right OneKey form to the deal's SkySlope
 *     file, fills it from "Change Payload JSON", and sends it for signature automatically.
 *   - Once SkySlope shows the form fully signed, it sets SkySlope Status = Signed and Matrix Status = Queued.
 *   - The Matrix task (MATRIX_TASK.md, part C) makes the change on the live listing in Matrix.
 *   - processListingChanges_ (runs with the 5-minute document trigger) then updates the deal itself:
 *     list price, expiration date, or status.
 * Nothing changes in Matrix or on the deal before the seller has signed.
 */

var CHANGES_SHEET = 'Listing Changes';
var CHANGE_HEADERS = ['Change ID', 'Deal ID', 'Requested At', 'Requested By', 'Change Type', 'Summary',
  'SkySlope Status', 'Signature Link', 'Matrix Status', 'Notes', 'Applied At', 'Details JSON', 'Change Payload JSON'];

/** Brokerage details printed on every OneKey form. Fill in the MLS office codes once. */
var LISTING_OFFICE_NAME = 'Coldwell Banker American Homes';
var OFFICE_MLS_CODES = { 'Dix Hills': 'BRMN17', 'Farmingdale': 'BRMN13' };

var CHANGE_TYPES = [
  { id: 'price', name: 'Price change', form: 'Status Change Form', box: 'Price Change', matrix: 'Change the list price', ownerSigns: true,
    help: 'New list price. The seller signs the Status Change Form; then the price is changed in Matrix.' },
  { id: 'tom', name: 'Temporarily off market', form: 'Status Change Form', box: 'Temporarily Off Market (TOM)', matrix: 'Change status to Temporarily Off Market', ownerSigns: true,
    help: 'Off the market for a short period. Use Withdraw if the seller is taking it off for good before the listing expires.' },
  { id: 'back', name: 'Back on market', form: 'Status Change Form', box: 'Back on Market', matrix: 'Change status back to Active', ownerSigns: true,
    help: 'Returns a Temporarily Off Market or Withdrawn listing to Active.' },
  { id: 'withdraw', name: 'Withdraw listing', form: 'Listing Withdrawal Form', matrix: 'Change status to Withdrawn', ownerSigns: true, firmSigns: true,
    help: 'Off the MLS and off the market. The seller still owes the commission if it sells by the protection date, and agrees to relist with us if offered again by the relist date.' },
  { id: 'cancel', name: 'Cancel listing', form: 'Listing Cancellation Form', matrix: 'Change status to Cancelled', ownerSigns: true, firmSigns: true,
    help: 'Ends the listing agreement. Only when no negotiations are pending with anyone.' },
  { id: 'extend', name: 'Extend listing', form: 'Extension Agreement', matrix: 'Change the expiration date and upload the signed Extension Agreement', ownerSigns: true,
    help: 'A listing can be extended up to 30 days after it expires. After that it must be entered as a new listing with a new listing agreement.' },
  { id: 'other', name: 'Other change', form: 'Status Change Form', box: 'All Other Changes', matrix: 'Make the change described', ownerSigns: false,
    help: 'Anything else on the listing (for example showing instructions or a remarks correction). Describe exactly what to change in Matrix.' }
];
var CHANGE_OPEN = ['Requested', 'Form Ready', 'Out for Signature', 'Signed', 'Needs Info', 'Needs Review'];

function changesConfig_() {
  return { types: CHANGE_TYPES, officeName: LISTING_OFFICE_NAME };
}

// ---------------------------------------------------------------------------
// AGENT ACTIONS
// ---------------------------------------------------------------------------

function listListingChanges(token, dealId) {
  var ctx = changeDeal_(token, dealId);
  return readChanges_().filter(function (c) { return c.deal_id === ctx.deal.deal_id; }).map(publicChange_)
    .sort(function (a, b) { return String(b.requested_at).localeCompare(String(a.requested_at)); });
}

/** input = { type, details: {...} } */
function requestListingChange(token, dealId, input) {
  var ctx = changeDeal_(token, dealId);
  var deal = ctx.deal;
  var type = CHANGE_TYPES.filter(function (t) { return t.id === (input && input.type); })[0];
  if (!type) throw new Error('Choose the kind of change.');
  if (!deal.mls_number) throw new Error('Add the MLS # on Deal details first (this listing has to be on the MLS to change it).');
  var open = readChanges_().filter(function (c) { return c.deal_id === deal.deal_id && isOpenChange_(c); });
  if (open.length) throw new Error('This listing already has an open change (' + open[0].type_name + ', ' + open[0].skyslope_status + '). Finish or withdraw that request first.');

  if (type.ownerSigns) {
    var owners = owners_(deal);
    if (!owners.length) throw new Error('Add the seller\'s name and email on Deal details first (the form is sent to them to sign).');
    var noEmail = owners.filter(function (o) { return !o.email; });
    if (noEmail.length) throw new Error('Add an email for ' + noEmail.map(function (o) { return o.name; }).join(' and ') + ' on Deal details first (the form is sent to them to sign).');
  }
  var d = validateChange_(type, deal, input.details || {});
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var change = {
      change_id: 'C' + deal.deal_id.replace(/^D/, '') + '-' + Utilities.getUuid().slice(0, 4).toUpperCase(),
      deal_id: deal.deal_id, requested_at: isoNow_(), requested_by: ctx.user.email,
      type: type.id, type_name: type.name, summary: changeSummary_(type, d, deal),
      skyslope_status: 'Requested', signature_link: '', matrix_status: '', notes: '', applied_at: '', details: d
    };
    change.payload = JSON.stringify(changePayload_(type, d, deal));
    changesSheet_().appendRow(changeRow_(change));
    logSync_(deal.deal_id, 'Listing change', 'Requested', change.summary);
    return publicChange_(change);
  } finally {
    lock.releaseLock();
  }
}

/** The agent can pull back a request until the seller has signed. */
function withdrawListingChange(token, dealId, changeId) {
  var ctx = changeDeal_(token, dealId);
  var c = readChanges_().filter(function (x) { return x.change_id === changeId && x.deal_id === ctx.deal.deal_id; })[0];
  if (!c) throw new Error('Request not found.');
  if (['Signed'].indexOf(c.skyslope_status) >= 0 || c.matrix_status) throw new Error('The seller already signed this one. Ask Mac to stop it.');
  if (!isOpenChange_(c)) throw new Error('This request is already closed.');
  // If the form already went out, the SkySlope task voids that unsigned envelope on its next run.
  setChangeCells_(changeId, { 'SkySlope Status': c.signature_link ? 'Withdrawn - void envelope' : 'Withdrawn by agent',
    'Notes': (c.notes ? c.notes + ' | ' : '') + 'Withdrawn ' + isoNow_().slice(0, 10) + ' by ' + ctx.user.email });
  return listListingChanges(token, dealId);
}

// ---------------------------------------------------------------------------
// VALIDATION + PAYLOAD
// ---------------------------------------------------------------------------

function validateChange_(type, deal, input) {
  var s = function (k) { return String(input[k] == null ? '' : input[k]).trim(); };
  var isDate = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(v); };
  var today = todayStr_();
  var out = { effective_date: s('effective_date') || today, note: s('note').slice(0, 1000) };
  if (!isDate(out.effective_date)) throw new Error('Choose the date of the change.');
  var listed = ['Coming Soon', 'Active'].indexOf(deal.status) >= 0;
  var off = ['TOM', 'Withdrawn'].indexOf(deal.status) >= 0;
  switch (type.id) {
    case 'price':
      out.new_price = s('new_price').replace(/[$,\s]/g, '');
      if (!(Number(out.new_price) > 0)) throw new Error('Enter the new price.');
      if (deal.list_price && Number(out.new_price) === Number(deal.list_price)) throw new Error('The new price is the same as the current list price.');
      out.old_price = deal.list_price || '';
      break;
    case 'tom':
      if (!listed) throw new Error('Only an Active or Coming Soon listing can go Temporarily Off Market (this deal is ' + deal.status + ').');
      break;
    case 'back':
      if (!off) throw new Error('Only a Temporarily Off Market or Withdrawn listing can come back on the market (this deal is ' + deal.status + ').');
      out.back_from = deal.status === 'Withdrawn' ? 'Withdrawn' : 'TOM';
      out.original_off_date = s('original_off_date');
      if (!isDate(out.original_off_date)) throw new Error('Enter the date it originally went off the market.');
      break;
    case 'withdraw':
      if (!listed && deal.status !== 'TOM') throw new Error('Only a listing that is on the market can be withdrawn (this deal is ' + deal.status + ').');
      out.protection_date = s('protection_date');
      out.relist_date = s('relist_date');
      if (!isDate(out.protection_date)) throw new Error('Enter the date through which the seller still owes the commission if it sells.');
      if (!isDate(out.relist_date)) throw new Error('Enter the date through which the seller agrees to relist with us.');
      if (input.no_negotiations !== true) throw new Error('Confirm that no negotiations are pending with anyone.');
      out.no_negotiations = true;
      break;
    case 'cancel':
      if (input.no_negotiations !== true) throw new Error('Confirm that no negotiations are pending with anyone.');
      out.no_negotiations = true;
      break;
    case 'extend':
      out.new_expiration = s('new_expiration');
      out.original_expiration = deal.listing_expiration || s('original_expiration');
      out.agreement = s('agreement');
      out.exceptions = s('exceptions') || 'None';
      if (!isDate(out.original_expiration)) throw new Error('Add the listing expiration date on Deal details first.');
      if (!isDate(out.new_expiration) || out.new_expiration <= out.original_expiration) throw new Error('The new expiration date must be after ' + out.original_expiration + '.');
      if (['Exclusive Right to Sell / Rent', 'Exclusive Agency'].indexOf(out.agreement) < 0) throw new Error('Choose the type of the original listing agreement.');
      var limit = new Date(out.original_expiration + 'T00:00:00'); limit.setDate(limit.getDate() + 30);
      if (new Date(today + 'T00:00:00') > limit) {
        throw new Error('This listing expired more than 30 days ago, so OneKey won\'t accept an extension. It has to be entered as a new listing with a new listing agreement.');
      }
      break;
    case 'other':
      if (!out.note) throw new Error('Describe exactly what should change.');
      break;
  }
  return out;
}

function changeSummary_(type, d, deal) {
  var money = function (v) { return v ? '$' + Number(v).toLocaleString('en-US') : ''; };
  switch (type.id) {
    case 'price': return 'Price ' + (money(d.old_price) || '?') + ' → ' + money(d.new_price);
    case 'tom': return 'Temporarily off market from ' + slash_(d.effective_date);
    case 'back': return 'Back on market from ' + d.back_from;
    case 'withdraw': return 'Withdraw from ' + slash_(d.effective_date) + ' (protection to ' + slash_(d.protection_date) + ')';
    case 'cancel': return 'Cancel listing from ' + slash_(d.effective_date);
    case 'extend': return 'Extend to ' + slash_(d.new_expiration) + ' (was ' + slash_(d.original_expiration) + ')';
    default: return 'Other: ' + d.note.slice(0, 80);
  }
}

function owners_(deal) {
  var list = [];
  if (deal.client_company) list.push({ name: deal.client_company, email: deal.client_email || '' });
  else if (deal.client_first || deal.client_last) list.push({ name: [deal.client_first, deal.client_last].filter(String).join(' '), email: deal.client_email || '' });
  if (deal.client2_first || deal.client2_last) list.push({ name: [deal.client2_first, deal.client2_last].filter(String).join(' '), email: deal.client2_email || '' });
  return list;
}

/** Everything the SkySlope and Matrix tasks need, keyed by the labels printed on the OneKey form. */
function changePayload_(type, d, deal) {
  var owners = owners_(deal);
  var mx = matrixRecord_(deal.deal_id);
  var address = [shortAddress_(deal), deal.city, deal.zip].filter(String).join(', ');
  var header = {
    'Office Name': LISTING_OFFICE_NAME, 'Office City': deal.office || '', 'Agent Name': deal.agent_name || '',
    'MLS Office Code': OFFICE_MLS_CODES[deal.office] || '', 'Co List Office Code': '', 'MLS #': deal.mls_number,
    "Owner's Name": owners.map(function (o) { return o.name; }).join(' & ')
  };
  var form = {};
  switch (type.id) {
    case 'price': case 'tom': case 'back': case 'other':
      form = Object.assign(header, {
        'Date': slash_(d.effective_date), 'Price': deal.list_price ? '$' + Number(deal.list_price).toLocaleString('en-US') : '',
        'Property Type': mx && mx.type ? matrixTypeName_(mx.type) : (deal.side === 'Landlord' ? 'Rental' : 'Residential'),
        'Address': address, 'Mark this box': type.box
      });
      if (type.id === 'price') form['New Price'] = '$' + Number(d.new_price).toLocaleString('en-US');
      if (type.id === 'back') { form['Back on Market From'] = d.back_from; form['Original Off Market Date'] = slash_(d.original_off_date); }
      if (type.id === 'other') form['All Other Changes'] = d.note;
      form['Broker/Agent Name'] = deal.agent_name || '';
      break;
    case 'withdraw':
      form = Object.assign(header, {
        'DATE OF WITHDRAWAL': slash_(d.effective_date), 'Date': slash_(todayStr_()),
        'Original Listing Agreement dated': slash_(deal.listing_date), 'due to expire on': slash_(deal.listing_expiration),
        'Property located at': address,
        'Owner pays commission if sold, leased or exchanged on or before': slash_(d.protection_date),
        'Owner agrees to relist with the Listing Office if offered again on or before': slash_(d.relist_date)
      });
      break;
    case 'cancel':
      form = Object.assign(header, {
        'DATE OF CANCELLATION': slash_(d.effective_date),
        'Original Listing Agreement dated': slash_(deal.listing_date), 'due to expire on': slash_(deal.listing_expiration)
      });
      break;
    case 'extend':
      form = Object.assign(header, {
        'Date': slash_(todayStr_()), "Owner(s) Name": header["Owner's Name"], 'Listing Office Name': LISTING_OFFICE_NAME,
        'Check one': d.agreement === 'Exclusive Agency' ? 'Exclusive Agency Listing Agreement' : 'Exclusive Right to Sell / Rent',
        'New Expiration Date': slash_(d.new_expiration), 'Original Listing Expiration Date': slash_(d.original_expiration),
        'Address': address, 'Exception(s)': d.exceptions, 'Broker/Agent Name': deal.agent_name || ''
      });
      delete form["Owner's Name"];
      break;
  }
  var signers = [];
  if (type.ownerSigns) owners.forEach(function (o) { signers.push({ role: 'Owner', name: o.name, email: o.email }); });
  if (type.firmSigns) signers.push({ role: 'Authorized Firm Representative', name: firmRep_().name, email: firmRep_().email });
  else signers.push({ role: 'Broker/Agent', name: deal.agent_name || '', email: deal.agent_email || '' });
  return {
    change_type: type.name, onekey_form: type.form, skyslope_file: deal.skyslope_file || '', deal_id: deal.deal_id,
    form_fields: form, signers: signers,
    matrix: { mls_number: deal.mls_number, action: type.matrix, effective_date: d.effective_date,
      new_price: d.new_price || '', new_expiration: d.new_expiration || '', note: d.note || '',
      upload_signed_form: type.id === 'extend' }
  };
}

function matrixTypeName_(id) { var t = MATRIX_TYPES.filter(function (x) { return x.id === id; })[0]; return t ? t.name : ''; }
function firmRep_() {
  var props = PropertiesService.getScriptProperties();
  return { name: props.getProperty('FIRM_REP_NAME') || 'Michael Aharoni', email: props.getProperty('FIRM_REP_EMAIL') || Session.getEffectiveUser().getEmail() };
}

// ---------------------------------------------------------------------------
// APPLY TO THE DEAL (runs every 5 minutes with processDocumentQueue)
// ---------------------------------------------------------------------------

/** For each change Matrix has made but the deal doesn't show yet: update the deal and the office inventory. */
function processListingChanges_() {
  var sheet = getSpreadsheet_().getSheetByName(CHANGES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var done = 0;
  readChanges_().forEach(function (c) {
    if (c.applied_at || !/^updated/i.test(c.matrix_status)) return;
    var found = findDealRow_(c.deal_id);
    if (!found) return;
    var deal = found.deal, d = c.details || {}, cells = {}, status = '';
    switch (c.type) {
      case 'price': cells['List Price'] = d.new_price; break;
      case 'extend': cells['Listing Expiration'] = d.new_expiration; break;
      case 'tom': status = 'TOM'; break;
      case 'back': status = 'Active'; break;
      case 'withdraw': status = 'Withdrawn'; break;
      case 'cancel': status = 'Cancelled'; break;
    }
    if (status) cells['Status'] = status;
    cells['Updated At'] = isoNow_();
    setDealCells_(c.deal_id, cells);
    var note = 'Applied to the deal: ' + c.summary + '.';
    // Office inventory: TOM is set there by the normal sync; price, expiration and other statuses are left for Mac.
    if (status === 'TOM') {
      try { var inv = syncInventory_(Object.assign(deal, { status: 'TOM' })); note += ' Inventory: ' + inv.message; } catch (e) { note += ' Inventory update failed: ' + e.message; }
    } else {
      note += ' Update the office inventory row by hand if needed.';
    }
    setChangeCells_(c.change_id, { 'Applied At': isoNow_(), 'Notes': (c.notes ? c.notes + ' | ' : '') + note });
    logSync_(c.deal_id, 'Listing change', 'Applied', c.summary);
    done++;
  });
  return done;
}

// ---------------------------------------------------------------------------
// STORAGE
// ---------------------------------------------------------------------------

function changeDeal_(token, dealId) {
  var user = requireSession_(token);
  var found = findDealRow_(dealId);
  if (!found) throw new Error('Save the deal first.');
  assertCanAccess_(user, found.deal);
  if (['Seller', 'Landlord'].indexOf(found.deal.side) < 0) throw new Error('Listing changes are only for Seller and Landlord deals.');
  return { user: user, deal: found.deal };
}

function changesSheet_() { return ensureSheet_(getSpreadsheet_(), CHANGES_SHEET, CHANGE_HEADERS); }

function readChanges_() {
  var sheet = changesSheet_();
  if (sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var h = indexHeaders_(data[0]);
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[h['Change ID']]) continue;
    var g = function (k) { return h[k] == null ? '' : String(r[h[k]] == null ? '' : r[h[k]]); };
    var type = CHANGE_TYPES.filter(function (t) { return t.id === g('Change Type'); })[0];
    var details = {}; try { details = JSON.parse(g('Details JSON') || '{}'); } catch (e) {}
    out.push({ _row: i + 1, change_id: g('Change ID'), deal_id: g('Deal ID'), requested_at: g('Requested At'), requested_by: g('Requested By'),
      type: g('Change Type'), type_name: type ? type.name : g('Change Type'), summary: g('Summary'), skyslope_status: g('SkySlope Status'),
      signature_link: g('Signature Link'), matrix_status: g('Matrix Status'), notes: g('Notes'), applied_at: g('Applied At'), details: details });
  }
  return out;
}

function changeRow_(c) {
  var sheet = changesSheet_();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var cells = { 'Change ID': c.change_id, 'Deal ID': c.deal_id, 'Requested At': c.requested_at, 'Requested By': c.requested_by,
    'Change Type': c.type, 'Summary': c.summary, 'SkySlope Status': c.skyslope_status, 'Signature Link': c.signature_link,
    'Matrix Status': c.matrix_status, 'Notes': c.notes, 'Applied At': c.applied_at, 'Details JSON': JSON.stringify(c.details || {}),
    'Change Payload JSON': c.payload || '' };
  return headers.map(function (hh) { return cells[hh] != null ? cells[hh] : ''; });
}

function setChangeCells_(changeId, cells) {
  var c = readChanges_().filter(function (x) { return x.change_id === changeId; })[0];
  if (!c) return;
  var sheet = changesSheet_();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  Object.keys(cells).forEach(function (k) { var i = headers.indexOf(k); if (i >= 0) sheet.getRange(c._row, i + 1).setValue(cells[k]); });
}

function isOpenChange_(c) { return CHANGE_OPEN.indexOf(c.skyslope_status) >= 0 && !c.applied_at; }

/** Where the request is, in plain words, for the page. */
function changeStage_(c) {
  if (c.applied_at) return { label: 'Done', tone: 'ok' };
  if (/withdrawn/i.test(c.skyslope_status)) return { label: 'Withdrawn', tone: '' };
  if (/needs/i.test(c.matrix_status)) return { label: 'Matrix: ' + c.matrix_status, tone: 'err' };
  if (/^updated/i.test(c.matrix_status)) return { label: 'Updated in Matrix', tone: 'ok' };
  if (c.matrix_status) return { label: 'Signed · Matrix ' + c.matrix_status.toLowerCase(), tone: 'wait' };
  if (/needs/i.test(c.skyslope_status)) return { label: c.skyslope_status, tone: 'err' };
  return { label: { 'Requested': 'Preparing form in SkySlope', 'Form Ready': 'Sending for signature',
    'Out for Signature': 'Out for signature', 'Signed': 'Signed' }[c.skyslope_status] || c.skyslope_status, tone: 'wait' };
}

function publicChange_(c) {
  return { change_id: c.change_id, type: c.type, type_name: c.type_name, summary: c.summary, requested_at: c.requested_at,
    requested_by: c.requested_by, skyslope_status: c.skyslope_status, signature_link: c.signature_link,
    matrix_status: c.matrix_status, notes: c.notes, applied_at: c.applied_at, stage: changeStage_(c), open: isOpenChange_(c) };
}

/** Open change per deal, for the deal list. */
function openChanges_() {
  var out = {};
  try { readChanges_().forEach(function (c) { if (isOpenChange_(c)) out[c.deal_id] = c.type_name + ': ' + changeStage_(c).label; }); } catch (e) {}
  return out;
}
