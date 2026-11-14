/**
 * MLS LISTING (OneKey MLS Matrix) — part of the Agent Deal Tracker.
 *
 * On a Seller or Landlord deal, the agent fills in an "MLS listing" tab that mirrors
 * the OneKey Matrix input sheet for the property type, and adds photos and documents.
 *   - Field values are stored in the "MLS Listings" tab (one row per deal).
 *   - Photos and documents go to a Drive folder per deal, inside "Deal Tracker MLS Media".
 *   - "Download PDF" returns a Matrix entry sheet (and keeps a copy in the deal's folder).
 *   - "Send to Matrix" checks every required field, numbers the photos in order, writes a
 *     ready-to-type "Matrix Payload JSON" and sets Matrix Status = "Queued". The Matrix task
 *     (MATRIX_TASK.md) then enters it in Matrix in Mac's Chrome and saves it as Incomplete
 *     for review. Nothing is ever submitted to the MLS automatically.
 *
 * Field definitions live in MatrixSchemas.gs (generated from matrix/*.js by build.py).
 */

var MATRIX_SHEET = 'MLS Listings';
var MATRIX_HEADERS = ['Deal ID', 'Property Type', 'Updated At', 'Updated By', 'Matrix Status', 'Matrix Notes',
  'Matrix Listing #', 'Drive Folder', 'PDF', 'Data JSON', 'Media JSON', 'Matrix Payload JSON'];
var MATRIX_ROOT_FOLDER = 'Deal Tracker MLS Media';
var MATRIX_CELL_LIMIT = 49000;

/** Property types in the Matrix "+" menu, in Matrix's order. schema null = input sheet not transcribed yet. */
var MATRIX_TYPES = [
  { id: 'residential', name: 'Residential', side: 'Seller', schema: 'residential' },
  { id: 'coop', name: 'Residential - Coop', side: 'Seller', schema: 'coop' },
  { id: 'condo', name: 'Residential - Condo', side: 'Seller', schema: 'condo' },
  { id: 'rental', name: 'Rental', side: 'Landlord', schema: 'rental' },
  { id: 'land', name: 'Land', side: 'Seller', schema: 'land' },
  { id: 'multi24', name: 'Res Income - Multi 2-4', side: 'Seller', schema: 'multi24' },
  { id: 'commercial-multi-5', name: 'Commercial - Multi 5+', side: 'Seller', schema: null },
  { id: 'commercial-sale', name: 'Commercial Sale', side: 'Seller', schema: null },
  { id: 'commercial-lease', name: 'Commercial Lease', side: 'Landlord', schema: null },
  { id: 'business-opportunity', name: 'Business Opportunity', side: 'Seller', schema: null }
];
var MATRIX_DOC_TYPES = ['Seller Property Disclosure', 'Floor Plan', 'Survey', 'Lead Paint Disclosure', 'HOA/Condo Docs',
  'Tax Bill', 'Listing Agreement', 'Other'];
var MATRIX_STATUS = { DRAFT: 'Draft', QUEUED: 'Queued', UPDATE: 'Update Queued' };

/** Sent to the page once at start-up (added to getAppConfig). */
function matrixConfig_() {
  return { types: MATRIX_TYPES, schemas: MATRIX_SCHEMAS_(), docTypes: MATRIX_DOC_TYPES, listingSides: ['Seller', 'Landlord'] };
}

// ---------------------------------------------------------------------------
// READ / SAVE
// ---------------------------------------------------------------------------

function getMatrixListing(token, dealId) {
  var ctx = matrixDeal_(token, dealId);
  var rec = matrixRecord_(dealId);
  var out = rec ? publicRecord_(rec) : { type: '', data: {}, media: [], matrix_status: '', matrix_notes: '', matrix_listing: '' };
  // The deal's own agent gets their MLS ID (their sign-in PIN) as List Agent ID.
  if (ctx.user.email === ctx.deal.agent_email) {
    var me = findAgent_(ctx.user.email);
    if (me && /^\d{3,}$/.test(me.pin)) out.my_mls_id = me.pin;
  }
  return out;
}

/** input = { type, data } — saves field values. Media order/captions come in input.media. */
function saveMatrixListing(token, dealId, input) {
  var ctx = matrixDeal_(token, dealId);
  var type = matrixType_(input && input.type);
  var schema = MATRIX_SCHEMAS_()[type.schema];
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rec = matrixRecord_(dealId) || { deal_id: dealId, media: [], matrix_status: MATRIX_STATUS.DRAFT };
    var before = JSON.stringify(rec.data || {});
    rec.type = type.id;
    rec.data = cleanMatrixData_(schema, input.data || {});
    if (Array.isArray(input.media)) rec.media = reorderMedia_(rec.media || [], input.media);
    rec.updated_at = isoNow_();
    rec.updated_by = ctx.user.email;
    var queued = rec.matrix_status === MATRIX_STATUS.QUEUED || rec.matrix_status === MATRIX_STATUS.UPDATE;
    var entered = rec.matrix_status && !queued && rec.matrix_status !== MATRIX_STATUS.DRAFT;
    if (entered && before !== JSON.stringify(rec.data)) {
      rec.matrix_status = 'Changed since sent';
      rec.matrix_notes = 'Edited after it was entered in Matrix. Press "Send to Matrix" again to queue the update.';
    }
    writeMatrixRecord_(rec);
    return publicRecord_(rec);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// PHOTOS + DOCUMENTS (Drive)
// ---------------------------------------------------------------------------

/** file = { name, mimeType, data (base64), kind: 'photo'|'doc', category } */
function uploadMatrixFile(token, dealId, file) {
  var ctx = matrixDeal_(token, dealId);
  if (!file || !file.data) throw new Error('No file received.');
  var bytes = Utilities.base64Decode(file.data);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('File is larger than 20 MB.');
  var kind = file.kind === 'photo' ? 'photo' : 'doc';
  var mime = file.mimeType || 'application/octet-stream';
  if (kind === 'photo' && !/^image\//.test(mime)) throw new Error(file.name + ' is not a photo.');
  var name = String(file.name || (kind === 'photo' ? 'photo.jpg' : 'document')).replace(/[\r\n\/\\]/g, ' ');
  var folder = matrixFolder_(ctx.deal, kind === 'photo' ? 'Photos' : 'Documents');
  var saved = folder.createFile(Utilities.newBlob(bytes, mime, name));

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rec = matrixRecord_(dealId) || { deal_id: dealId, type: '', data: {}, media: [], matrix_status: MATRIX_STATUS.DRAFT };
    rec.media = rec.media || [];
    rec.media.push({
      id: saved.getId(), kind: kind, name: name, original: name, size_kb: Math.round(bytes.length / 1024),
      caption: '', category: kind === 'doc' ? (MATRIX_DOC_TYPES.indexOf(file.category) >= 0 ? file.category : 'Other') : '',
      added: isoNow_(), by: ctx.user.email
    });
    rec.updated_at = isoNow_();
    rec.updated_by = ctx.user.email;
    writeMatrixRecord_(rec);
    return publicRecord_(rec).media;
  } finally {
    lock.releaseLock();
  }
}

function deleteMatrixFile(token, dealId, fileId) {
  matrixDeal_(token, dealId);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rec = matrixRecord_(dealId);
    if (!rec) throw new Error('Nothing to remove.');
    var keep = (rec.media || []).filter(function (m) { return m.id !== fileId; });
    if (keep.length === (rec.media || []).length) throw new Error('That file is not on this listing.');
    try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* already gone */ }
    rec.media = keep;
    rec.updated_at = isoNow_();
    writeMatrixRecord_(rec);
    return publicRecord_(rec).media;
  } finally {
    lock.releaseLock();
  }
}

/** Small previews for the photo list: { fileId: dataUrl }. */
function matrixThumbs(token, dealId) {
  matrixDeal_(token, dealId);
  var rec = matrixRecord_(dealId);
  var out = {};
  ((rec && rec.media) || []).filter(function (m) { return m.kind === 'photo'; }).slice(0, 60).forEach(function (m) {
    try {
      var t = DriveApp.getFileById(m.id).getThumbnail();
      if (t) out[m.id] = 'data:' + (t.getContentType() || 'image/png') + ';base64,' + Utilities.base64Encode(t.getBytes());
    } catch (e) { /* thumbnail not ready yet */ }
  });
  return out;
}

// ---------------------------------------------------------------------------
// PDF + SEND TO MATRIX
// ---------------------------------------------------------------------------

/** Returns { name, data (base64 PDF) } for the agent to download; keeps a copy in the deal's folder. */
function matrixPdf(token, dealId) {
  var ctx = matrixDeal_(token, dealId);
  var rec = matrixRecord_(dealId);
  if (!rec || !rec.type) throw new Error('Choose the property type and save first.');
  var type = matrixType_(rec.type);
  var schema = MATRIX_SCHEMAS_()[type.schema];
  var check = checkMatrix_(schema, rec.data || {});
  var html = matrixSheetHtml_(ctx.deal, type, schema, rec, check);
  var name = (shortAddress_(ctx.deal) || ctx.deal.deal_id) + ' - Matrix entry sheet.pdf';
  var pdf = HtmlService.createHtmlOutput(html).getBlob().getAs('application/pdf').setName(name);
  var folder = matrixFolder_(ctx.deal);
  trashByName_(folder, name);
  var copy = folder.createFile(pdf);
  setMatrixCells_(dealId, { 'PDF': copy.getUrl() });
  return { name: name, data: Utilities.base64Encode(pdf.getBytes()), missing: check.missing.length };
}

function sendToMatrix(token, dealId) {
  var ctx = matrixDeal_(token, dealId);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rec = matrixRecord_(dealId);
    if (!rec || !rec.type) throw new Error('Choose the property type and save first.');
    var type = matrixType_(rec.type);
    var schema = MATRIX_SCHEMAS_()[type.schema];
    var check = checkMatrix_(schema, rec.data || {});
    if (check.missing.length) {
      throw new Error('Before this can go to Matrix, please fill in: ' + check.missing.slice(0, 12).join(', ') +
        (check.missing.length > 12 ? ' and ' + (check.missing.length - 12) + ' more' : ''));
    }
    var photos = (rec.media || []).filter(function (m) { return m.kind === 'photo'; });
    if (!photos.length) throw new Error('Add at least one photo before sending to Matrix.');
    numberPhotos_(rec);
    var wasEntered = rec.matrix_listing || (rec.matrix_status && [MATRIX_STATUS.DRAFT, MATRIX_STATUS.QUEUED].indexOf(rec.matrix_status) < 0);
    rec.matrix_status = wasEntered ? MATRIX_STATUS.UPDATE : MATRIX_STATUS.QUEUED;
    rec.matrix_notes = '';
    rec.payload = JSON.stringify(matrixPayload_(ctx.deal, type, schema, rec));
    rec.updated_at = isoNow_();
    rec.updated_by = ctx.user.email;
    writeMatrixRecord_(rec);
    logSync_(dealId, 'Matrix', rec.matrix_status, type.name + ', ' + photos.length + ' photos');
    return publicRecord_(rec);
  } finally {
    lock.releaseLock();
  }
}

/** What the Matrix task types, section by section in Matrix's order. */
function matrixPayload_(deal, type, schema, rec) {
  var d = rec.data || {};
  var sections = schema.sections.filter(function (s) { return mxVisible_(s, d, s); }).map(function (s) {
    return {
      section: s.title,
      fields: s.fields.filter(function (f) { return mxVisible_(f, d, s) && !mxEmpty_(d[f.id]); }).map(function (f) {
        var v = d[f.id];
        if (f.type === 'repeat') {
          v = v.filter(function (r) { return !mxRowEmpty_(r); }).map(function (r) {
            var o = {}; f.item.forEach(function (sub) { if (!mxEmpty_(r[sub.id])) o[sub.label] = r[sub.id]; }); return o;
          });
        }
        return { label: f.label, kind: f.type === 'checks' ? 'check all' : f.type === 'radio' || f.type === 'yesno' ? 'pick one' : f.type, value: v };
      })
    };
  }).filter(function (s) { return s.fields.length; });
  var media = rec.media || [];
  return {
    deal_id: deal.deal_id, property_type: type.name, address: shortAddress_(deal), agent: deal.agent_name,
    drive_folder: matrixFolder_(deal).getUrl(),
    sections: sections,
    photos: media.filter(function (m) { return m.kind === 'photo'; }).map(function (m, i) { return { order: i + 1, file: m.name, drive_id: m.id, caption: m.caption || '' }; }),
    documents: media.filter(function (m) { return m.kind === 'doc'; }).map(function (m) { return { type: m.category, file: m.name, drive_id: m.id }; })
  };
}

/** Renames photos "01 - caption.jpg", "02 - ..." so they upload to Matrix in the agent's order. */
function numberPhotos_(rec) {
  var n = 0;
  (rec.media || []).forEach(function (m) {
    if (m.kind !== 'photo') return;
    n++;
    var ext = (String(m.original || m.name).match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0].toLowerCase();
    var base = m.caption ? String(m.caption).replace(/[^\w\s\-&,']/g, '').trim().slice(0, 60) : 'photo';
    var name = ('0' + n).slice(-2) + ' - ' + base + ext;
    if (m.name !== name) {
      try { DriveApp.getFileById(m.id).setName(name); m.name = name; } catch (e) { /* keep old name */ }
    }
  });
}

// ---------------------------------------------------------------------------
// VALIDATION (same rules as the page)
// ---------------------------------------------------------------------------

function mxEmpty_(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return !v.length || v.every(function (x) { return x && typeof x === 'object' ? mxRowEmpty_(x) : false; });
  return String(v).trim() === '';
}
function mxRowEmpty_(r) { return Object.keys(r || {}).every(function (k) { return mxEmpty_(r[k]); }); }
function mxTest_(c, d) {
  if (!c) return true;
  var v = d[c.field];
  if ('equals' in c) return v === c.equals;
  if ('in' in c) return c['in'].indexOf(v) >= 0;
  if ('includes' in c) return Array.isArray(v) && v.indexOf(c.includes) >= 0;
  return true;
}
function mxVisible_(f, d, sec) { return mxTest_(sec && sec.showIf, d) && (f === sec || mxTest_(f.showIf, d)); }

function checkMatrix_(schema, d) {
  var missing = [], errors = [];
  schema.sections.forEach(function (s) {
    if (!mxVisible_(s, d, s)) return;
    s.fields.forEach(function (f) {
      if (!mxVisible_(f, d, s)) return;
      if (f.req && mxEmpty_(d[f.id])) missing.push(f.label);
    });
  });
  return { missing: missing, errors: errors };
}

/** Keeps only known fields and known options, so the sheet never holds stray data. */
function cleanMatrixData_(schema, data) {
  var out = {};
  schema.sections.forEach(function (s) {
    s.fields.forEach(function (f) {
      var v = data[f.id];
      if (v == null || v === '') return;
      if (f.type === 'checks') {
        if (!Array.isArray(v)) return;
        v = v.filter(function (o) { return f.options.indexOf(o) >= 0; });
        if (v.length) out[f.id] = v;
      } else if (f.type === 'radio' || f.type === 'yesno') {
        if ((f.type === 'yesno' ? ['Yes', 'No'] : f.options).indexOf(v) >= 0) out[f.id] = v;
      } else if (f.type === 'repeat') {
        if (!Array.isArray(v)) return;
        var rows = v.slice(0, f.max || 40).map(function (r) {
          var o = {};
          f.item.forEach(function (sub) {
            var x = r && r[sub.id];
            if (x == null || x === '') return;
            if (sub.type === 'checks') { if (Array.isArray(x)) o[sub.id] = x.filter(function (y) { return sub.options.indexOf(y) >= 0; }); }
            else if (sub.type === 'select' || sub.type === 'yesno') { if ((sub.type === 'yesno' ? ['Yes', 'No'] : sub.options).indexOf(x) >= 0) o[sub.id] = x; }
            else o[sub.id] = String(x).slice(0, 2000);
          });
          return o;
        });
        if (rows.length) out[f.id] = rows;
      } else {
        out[f.id] = String(v).slice(0, f.type === 'textarea' ? 6000 : 500);
      }
    });
  });
  return out;
}

/** Applies the page's photo order and captions to the stored media list. */
function reorderMedia_(stored, incoming) {
  var byId = {};
  stored.forEach(function (m) { byId[m.id] = m; });
  var out = [];
  incoming.forEach(function (m) {
    var s = byId[m.id];
    if (!s) return;
    if (m.caption != null) s.caption = String(m.caption).slice(0, 120);
    if (m.category && MATRIX_DOC_TYPES.indexOf(m.category) >= 0) s.category = m.category;
    out.push(s);
    delete byId[m.id];
  });
  stored.forEach(function (m) { if (byId[m.id]) out.push(m); }); // anything the page didn't list stays, at the end
  return out;
}

// ---------------------------------------------------------------------------
// ENTRY SHEET (PDF)
// ---------------------------------------------------------------------------

function matrixSheetHtml_(deal, type, schema, rec, check) {
  var d = rec.data || {};
  var e = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmt = function (f, v) {
    if (Array.isArray(v)) return v.map(e).join('; ');
    if (f.type === 'money') { var n = Number(String(v).replace(/[$,\s]/g, '')); return isNaN(n) ? e(v) : '$' + n.toLocaleString('en-US'); }
    if (f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.slice(5, 7) + '/' + v.slice(8, 10) + '/' + v.slice(0, 4);
    return e(v).replace(/\n/g, '<br>');
  };
  var parts = ['<html><head><meta charset="utf-8"><style>',
    'body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#111}',
    'h1{font-size:15pt;margin:0 0 2px}h2{font-size:11pt;margin:14px 0 4px;padding-bottom:2px;border-bottom:2px solid #463a5c}',
    'table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:3px 6px;border-bottom:1px solid #ddd}',
    'th{width:36%;color:#444;font-weight:bold}.miss th,.miss td{color:#b3261e}.sub{color:#555;font-size:9pt}',
    '</style></head><body>',
    '<h1>' + e(type.name) + ' — Matrix entry sheet</h1>',
    '<div><b>' + e(shortAddress_(deal) || 'Address not entered') + (deal.city ? ', ' + e(deal.city) : '') + '</b></div>',
    '<div class="sub">Deal ' + e(deal.deal_id) + ' · ' + e(deal.agent_name) + ' · prepared ' + e(isoNow_().replace('T', ' ')) +
    ' · fields in the order of the OneKey ' + e(schema.sourceDoc.replace(/^OneKey MLS /, '')) + '</div>'];
  if (check.missing.length) parts.push('<p style="color:#b3261e"><b>' + check.missing.length + ' required field(s) still missing</b> — marked in red below.</p>');
  schema.sections.forEach(function (s) {
    if (!mxVisible_(s, d, s)) return;
    var rows = s.fields.filter(function (f) { return mxVisible_(f, d, s); }).map(function (f) {
      var v = d[f.id];
      if (f.type === 'repeat') {
        var rs = (v || []).filter(function (r) { return !mxRowEmpty_(r); });
        if (!rs.length) return '';
        return '<tr><th>' + e(f.label) + '</th><td>' + rs.map(function (r, i) {
          return '<div><b>' + e(f.itemLabel || 'Item') + ' ' + (i + 1) + ':</b> ' + f.item.filter(function (sub) { return !mxEmpty_(r[sub.id]); })
            .map(function (sub) { return e(sub.label) + ': ' + fmt(sub, r[sub.id]); }).join(' · ') + '</div>';
        }).join('') + '</td></tr>';
      }
      if (mxEmpty_(v)) return f.req ? '<tr class="miss"><th>' + e(f.label) + ' *</th><td>MISSING — required</td></tr>' : '';
      return '<tr><th>' + e(f.label) + (f.req ? ' *' : '') + '</th><td>' + fmt(f, v) + '</td></tr>';
    }).join('');
    if (rows) parts.push('<h2>' + e(s.title) + '</h2><table>' + rows + '</table>');
  });
  var media = rec.media || [];
  var photos = media.filter(function (m) { return m.kind === 'photo'; });
  var docs = media.filter(function (m) { return m.kind === 'doc'; });
  parts.push('<h2>Photos (' + photos.length + ') — upload in this order</h2><table>' + (photos.length ? photos.map(function (m, i) {
    return '<tr><th>' + (i + 1) + (i === 0 ? ' (primary)' : '') + '</th><td>' + e(m.name) + (m.caption ? ' · ' + e(m.caption) : '') + '</td></tr>';
  }).join('') : '<tr><td>None yet</td></tr>') + '</table>');
  parts.push('<h2>Documents (' + docs.length + ')</h2><table>' + (docs.length ? docs.map(function (m) {
    return '<tr><th>' + e(m.category) + '</th><td>' + e(m.name) + '</td></tr>';
  }).join('') : '<tr><td>None yet</td></tr>') + '</table></body></html>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// STORAGE HELPERS
// ---------------------------------------------------------------------------

function matrixDeal_(token, dealId) {
  var user = requireSession_(token);
  var found = findDealRow_(dealId);
  if (!found) throw new Error('Save the deal first.');
  assertCanAccess_(user, found.deal);
  if (['Seller', 'Landlord'].indexOf(found.deal.side) < 0) throw new Error('MLS listings are only for Seller and Landlord deals.');
  return { user: user, deal: found.deal };
}

function matrixType_(id) {
  var t = MATRIX_TYPES.filter(function (x) { return x.id === id; })[0];
  if (!t) throw new Error('Choose the property type.');
  if (!t.schema || !MATRIX_SCHEMAS_()[t.schema]) throw new Error(t.name + ' is not set up yet (its OneKey input sheet is still needed).');
  return t;
}

function matrixSheet_() {
  return ensureSheet_(getSpreadsheet_(), MATRIX_SHEET, MATRIX_HEADERS);
}

function matrixRecord_(dealId) {
  var sheet = matrixSheet_();
  if (sheet.getLastRow() < 2) return null;
  var data = sheet.getDataRange().getValues();
  var h = indexHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][h['Deal ID']]) !== dealId) continue;
    var r = data[i];
    var parse = function (k, dflt) { try { return JSON.parse(r[h[k]] || dflt); } catch (e) { return JSON.parse(dflt); } };
    return {
      _row: i + 1, deal_id: dealId, type: String(r[h['Property Type']] || ''), updated_at: String(r[h['Updated At']] || ''),
      updated_by: String(r[h['Updated By']] || ''), matrix_status: String(r[h['Matrix Status']] || ''),
      matrix_notes: String(r[h['Matrix Notes']] || ''), matrix_listing: String(r[h['Matrix Listing #']] || ''),
      folder: String(r[h['Drive Folder']] || ''), pdf: String(r[h['PDF']] || ''),
      data: parse('Data JSON', '{}'), media: parse('Media JSON', '[]'), payload: String(r[h['Matrix Payload JSON']] || '')
    };
  }
  return null;
}

function writeMatrixRecord_(rec) {
  var sheet = matrixSheet_();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var dataJson = JSON.stringify(rec.data || {}), mediaJson = JSON.stringify(rec.media || []);
  if (dataJson.length > MATRIX_CELL_LIMIT) throw new Error('This listing has too much text to store. Shorten the remarks or descriptions.');
  if (mediaJson.length > MATRIX_CELL_LIMIT) throw new Error('Too many photos and documents on one listing.');
  var existing = matrixRecord_(rec.deal_id);
  var cells = {
    'Deal ID': rec.deal_id, 'Property Type': rec.type || '', 'Updated At': rec.updated_at || isoNow_(), 'Updated By': rec.updated_by || '',
    'Matrix Status': rec.matrix_status || MATRIX_STATUS.DRAFT, 'Matrix Notes': rec.matrix_notes || '',
    'Matrix Listing #': rec.matrix_listing || '', 'Drive Folder': rec.folder || (existing && existing.folder) || '',
    'PDF': rec.pdf || (existing && existing.pdf) || '', 'Data JSON': dataJson, 'Media JSON': mediaJson,
    'Matrix Payload JSON': rec.payload || (existing && existing.payload) || ''
  };
  var row = headers.map(function (hh) { return cells[hh] != null ? cells[hh] : ''; });
  if (existing) sheet.getRange(existing._row, 1, 1, headers.length).setValues([row]);
  else sheet.appendRow(row);
}

function setMatrixCells_(dealId, cells) {
  var rec = matrixRecord_(dealId);
  if (!rec) return;
  var sheet = matrixSheet_();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  Object.keys(cells).forEach(function (k) {
    var c = headers.indexOf(k);
    if (c >= 0) sheet.getRange(rec._row, c + 1).setValue(cells[k]);
  });
}

function publicRecord_(rec) {
  return {
    type: rec.type || '', data: rec.data || {}, matrix_status: rec.matrix_status || '', matrix_notes: rec.matrix_notes || '',
    matrix_listing: rec.matrix_listing || '', updated_at: rec.updated_at || '',
    media: (rec.media || []).map(function (m) { return { id: m.id, kind: m.kind, name: m.name, caption: m.caption || '', category: m.category || '', size_kb: m.size_kb }; })
  };
}

/** Drive: <MATRIX_ROOT_FOLDER>/<deal id - address>/[Photos|Documents] */
function matrixFolder_(deal, sub) {
  var props = PropertiesService.getScriptProperties();
  var rootId = props.getProperty('MATRIX_FOLDER_ID'), root = null;
  if (rootId) { try { root = DriveApp.getFolderById(rootId); } catch (e) { root = null; } }
  if (!root) { root = DriveApp.createFolder(MATRIX_ROOT_FOLDER); props.setProperty('MATRIX_FOLDER_ID', root.getId()); }
  var rec = matrixRecord_(deal.deal_id), folder = null;
  if (rec && rec.folder) { try { folder = DriveApp.getFolderById(rec.folder); } catch (e) { folder = null; } }
  if (!folder) {
    var it = root.getFoldersByName(deal.deal_id);
    folder = it.hasNext() ? it.next() : root.createFolder(deal.deal_id);
    try { folder.setDescription(shortAddress_(deal) || ''); } catch (e) {}
    if (rec) setMatrixCells_(deal.deal_id, { 'Drive Folder': folder.getId() });
    else writeMatrixRecord_({ deal_id: deal.deal_id, type: '', data: {}, media: [], matrix_status: MATRIX_STATUS.DRAFT, folder: folder.getId(), updated_at: isoNow_() });
  }
  if (!sub) return folder;
  var s = folder.getFoldersByName(sub);
  return s.hasNext() ? s.next() : folder.createFolder(sub);
}

function trashByName_(folder, name) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) it.next().setTrashed(true);
}

/** Matrix status for each deal, for the deal list. */
function matrixStatuses_() {
  var out = {};
  var sheet = getSpreadsheet_().getSheetByName(MATRIX_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return out;
  var data = sheet.getRange(1, 1, sheet.getLastRow(), 5).getValues();
  var h = indexHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) out[String(data[i][h['Deal ID']])] = String(data[i][h['Matrix Status']] || '');
  return out;
}
