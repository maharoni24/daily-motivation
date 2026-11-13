/**
 * AGENT DEAL TRACKER (Coldwell Banker American Homes: Dix Hills + Farmingdale)
 *
 * Agents submit Seller / Buyer / Tenant / Landlord deals, edit them, and check
 * off milestones. On every save:
 *   1. The deal is stored in the "Deals" tab of this spreadsheet. Field names
 *      match SkySlope's new-file screens (captured 2026-11-13).
 *   2. The deal is added to (or advanced on) the right office tab of the
 *      "Office Sheets" inventory, with the same columns and rules as the daily
 *      inventory sync.
 *   3. The deal is queued for SkySlope: a ready-to-type "SkySlope Payload JSON"
 *      is written, and the SkySlope scheduled task (see SKYSLOPE_TASK.md) opens
 *      the file in SkySlope Forms + Transaction Management through Chrome.
 *      Darwin then picks the file up from SkySlope.
 *
 * Setup: README.md. Run `setup()` once from the Apps Script editor.
 */

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

var APP_NAME = 'Agent Deal Tracker';

/** Mac's "Office Sheets" spreadsheet (inventory tabs). Override with Script Property INVENTORY_SPREADSHEET_ID. */
var DEFAULT_INVENTORY_ID = '1-Bob1r8pXD3AkgtDJXs9-IiSWHWIwTGgS5zULBgQmXI';

var SHEETS = { DEALS: 'Deals', AGENTS: 'Agents', MILESTONE_LOG: 'Milestone Log', SYNC_LOG: 'Sync Log' };

var SIDES = ['Seller', 'Buyer', 'Tenant', 'Landlord'];
var OFFICES = ['Dix Hills', 'Farmingdale'];

/** Same status words as the Office Sheets inventory tabs. */
var STATUSES = ['Coming Soon', 'Active', 'Accepted Offer', 'Under Contract', 'Closing Set', 'Sold', 'TOM', 'Cancelled'];
var STATUS_RANK = { 'Coming Soon': 1, 'Active': 2, 'Accepted Offer': 3, 'Under Contract': 4, 'Closing Set': 5, 'Sold': 6 };

var ALL = SIDES;
var SALE = ['Seller', 'Buyer'];
var LEASE = ['Tenant', 'Landlord'];
var LISTING_SIDES = ['Seller', 'Landlord'];
var CLIENT_BUYING = ['Buyer', 'Tenant'];

// ---- SkySlope dropdown values, exactly as SkySlope shows them --------------

var SKY_CHECKLISTS = {
  Seller: ['Residential Co-op/Condo Closing For Listing Side Only', 'Res/Co-op/Condo Double Sided Dual Agent',
    'Res/Co-op/Condo Double Sided Unrepresented Buyer', 'CB American Homes Commercial Sale',
    'CB American homes Commercial Sale Both Sides Unrepresented Buyer'],
  Buyer: ['Buyer Client', 'Res/Co-op/Condo Double Sided Dual Agent', 'CB American Homes Commercial Sale'],
  Tenant: ['Tenant Client', 'Tenant Customer', 'Rental Closing Checklist', 'CB American Homes Commercial Lease'],
  Landlord: ['Rental Closing Checklist For Listing', 'Rental Closing Checklist', 'CB American Homes Commercial Lease',
    'CB American Homes Commercial Lease Both Sides Unrepresented Tenant']
};

/** SkySlope Forms BROKERAGE templates only (no personal templates such as "Yearly Forms"). */
var SKY_TEMPLATES = {
  Seller: ['Residential Listing', 'Co-op Condo Listing', 'Land Listing'],
  Buyer: ['Buyer Broker Template', 'Unrepresented Buyer'],
  Tenant: ['Tenant Representation', 'Unrepresented Tenant'],
  Landlord: ['Rental Listing', 'Rental Listing - NYC']
};

var SKY_SOURCES = ['SOI', 'Personal Referral', 'Previous Customer', 'Corporate Referral', 'Office Lead', 'Sign',
  'Open House', 'Advertisement', 'Prospecting', 'Farming', 'Floor Time', 'Duty Desk', 'MLS', 'Website', 'Zillow',
  'Social Marketing', 'Direct Mail', 'Door Knocking', 'Call Capture', 'Drip Marketing', 'Expired/Withdrawn',
  'Relocation Department', 'REO Account', 'New Home Account', 'Home Partners of America', 'Other'];

var SKY_DIRECTIONS = ['N', 'E', 'S', 'W', 'NW', 'NE', 'SE', 'SW'];
var SKY_LOAN_TYPES = ['Conventional', 'FHA', 'VA', 'Home Loan', 'Personal Loan', 'Other'];
var US_STATES = ['New York', 'New Jersey', 'Connecticut', 'Pennsylvania', 'Florida', 'Massachusetts', 'Other'];

/**
 * Every deal field. `col` = Deals sheet header. `req` = true or list of sides.
 * `sky` = where it goes in SkySlope (documentation for the SkySlope task).
 */
var FIELDS = [
  // ---- SkySlope setup
  { key: 'office', col: 'Office', label: 'Office', type: 'select', options: OFFICES, sides: ALL, section: 'SkySlope setup', req: true, sky: 'OFFICE' },
  { key: 'represent_both', col: 'Dual Agency', label: 'Do you (or another CBAH agent) represent BOTH sides?', type: 'select', options: ['No', 'Yes'], default: 'No', sides: ALL, section: 'SkySlope setup', sky: 'TYPE (REPRESENTATION) = Both …' },
  { key: 'checklist_type', col: 'SkySlope Checklist Type', label: 'SkySlope checklist type', type: 'select', optionsBySide: SKY_CHECKLISTS, sides: ALL, section: 'SkySlope setup', sky: 'CHECKLIST TYPE',
    help: 'Pick "Double Sided" if you represent both sides; "Commercial" for commercial deals.' },
  { key: 'forms_template', col: 'SkySlope Forms Template', label: 'SkySlope brokerage template (forms package)', type: 'select', optionsBySide: SKY_TEMPLATES, sides: ALL, section: 'SkySlope setup', sky: 'Forms: template',
    help: 'Brokerage templates only. This loads the forms that get filled and sent to your client for signature.' },
  { key: 'seller_net_sheet', col: 'Seller Net Sheet', label: 'Create a seller net sheet?', type: 'select', options: ['Yes', 'No'], default: 'Yes', sides: ['Seller'], section: 'SkySlope setup', sky: 'Forms: Create a Seller Net Sheet' },
  { key: 'co_agent', col: 'Co-Agent', label: 'Co-agent (CBAH agent on the deal with you)', type: 'roster', sides: ALL, section: 'SkySlope setup', sky: 'CO-BUYER AGENT' },
  { key: 'co_agent_split', col: 'Co-Agent Split %', label: 'Your co-agent\'s share of the commission %', type: 'number', sides: ALL, section: 'SkySlope setup', sky: 'Commission Split %' },
  { key: 'source', col: 'Source', label: 'Lead source', type: 'select', options: SKY_SOURCES, sides: ALL, section: 'SkySlope setup', sky: 'SOURCE' },
  { key: 'office_lead', col: 'Office Lead', label: 'Office lead?', type: 'select', options: ['No', 'Yes'], default: 'No', sides: ALL, section: 'SkySlope setup', sky: 'OFFICE LEAD' },

  // ---- Property
  { key: 'mls_number', col: 'MLS #', label: 'MLS #', type: 'text', sides: ALL, section: 'Property', sky: 'MLS#' },
  { key: 'street_number', col: 'Street No.', label: 'Street number', type: 'text', sides: ALL, section: 'Property', req: true, sky: 'STREET NO.' },
  { key: 'direction', col: 'Direction', label: 'Direction', type: 'select', options: SKY_DIRECTIONS, sides: ALL, section: 'Property', sky: 'DIRECTION' },
  { key: 'street_name', col: 'Street Name', label: 'Street name (e.g. Oak Lane)', type: 'text', sides: ALL, section: 'Property', req: true, sky: 'STREET NAME' },
  { key: 'unit', col: 'Unit', label: 'Unit #', type: 'text', sides: ALL, section: 'Property', sky: 'UNIT #' },
  { key: 'city', col: 'City / Town', label: 'City / town', type: 'text', sides: ALL, section: 'Property', sky: 'CITY' },
  { key: 'state', col: 'State', label: 'State', type: 'select', options: US_STATES, default: 'New York', sides: ALL, section: 'Property', sky: 'STATE' },
  { key: 'zip', col: 'Zip', label: 'Zip code', type: 'text', sides: ALL, section: 'Property', sky: 'ZIP CODE' },
  { key: 'county', col: 'County', label: 'County', type: 'text', sides: ALL, section: 'Property', sky: 'COUNTY' },
  { key: 'year_built', col: 'Year Built', label: 'Year built', type: 'number', sides: ALL, section: 'Property', sky: 'YEAR BUILT' },

  // ---- Our client
  { key: 'client_is_entity', col: 'Client Is Entity', label: 'Client is a company, trust or estate?', type: 'select', options: ['No', 'Yes'], default: 'No', sides: ALL, section: 'Your client', sky: 'Trust/company/entity checkbox' },
  { key: 'client_company', col: 'Client Company / Trust', label: 'Company / trust / estate name', type: 'text', sides: ALL, section: 'Your client', sky: 'COMPANY NAME' },
  { key: 'client_first', col: 'Client First Name', label: 'Client first name', type: 'text', sides: ALL, section: 'Your client', sky: 'FIRST NAME',
    labels: { Seller: 'Seller first name', Buyer: 'Buyer first name', Tenant: 'Tenant first name', Landlord: 'Landlord first name' } },
  { key: 'client_last', col: 'Client Last Name', label: 'Client last name', type: 'text', sides: ALL, section: 'Your client', sky: 'LAST NAME',
    labels: { Seller: 'Seller last name', Buyer: 'Buyer last name', Tenant: 'Tenant last name', Landlord: 'Landlord last name' } },
  { key: 'client_email', col: 'Client Email', label: 'Client email (forms are sent here to sign)', type: 'email', sides: ALL, section: 'Your client', sky: 'E-MAIL' },
  { key: 'client_phone', col: 'Client Phone', label: 'Client phone', type: 'tel', sides: ALL, section: 'Your client', sky: 'PHONE' },
  { key: 'client2_first', col: 'Client 2 First Name', label: 'Second client first name', type: 'text', sides: ALL, section: 'Your client', sky: 'Additional contact' },
  { key: 'client2_last', col: 'Client 2 Last Name', label: 'Second client last name', type: 'text', sides: ALL, section: 'Your client', sky: 'Additional contact' },
  { key: 'client2_email', col: 'Client 2 Email', label: 'Second client email', type: 'email', sides: ALL, section: 'Your client', sky: 'Additional contact' },
  { key: 'client2_phone', col: 'Client 2 Phone', label: 'Second client phone', type: 'tel', sides: ALL, section: 'Your client', sky: 'Additional contact' },

  // ---- Listing / terms
  { key: 'list_price', col: 'List Price', label: 'List price', type: 'money', sides: ALL, section: 'Price & dates', sky: 'LIST PRICE',
    labels: { Landlord: 'Listed monthly rent', Tenant: 'Advertised monthly rent', Buyer: 'List price (from MLS)' } },
  { key: 'listing_date', col: 'Listing Date', label: 'Listing agreement date', type: 'date', sides: LISTING_SIDES, section: 'Price & dates' },
  { key: 'listing_expiration', col: 'Listing Expiration', label: 'Listing expiration date', type: 'date', sides: LISTING_SIDES, section: 'Price & dates', sky: 'LISTING EXPIRE DATE' },
  { key: 'price', col: 'Sale Price / Rent', label: 'Accepted price', type: 'money', sides: ALL, section: 'Price & dates', sky: 'SALE PRICE',
    labels: { Seller: 'Accepted sale price (once you have an offer)', Buyer: 'Accepted purchase price', Tenant: 'Monthly rent (agreed)', Landlord: 'Monthly rent (agreed with tenant)' } },
  { key: 'acceptance_date', col: 'Acceptance Date', label: 'Offer accepted date', type: 'date', sides: ALL, section: 'Price & dates', sky: 'ACCEPTANCE DATE',
    labels: { Tenant: 'Application approved date', Landlord: 'Application approved date' } },
  { key: 'contract_date', col: 'Contract Signed Date', label: 'Contract fully signed date', type: 'date', sides: SALE, section: 'Price & dates', sky: 'Inventory "UC Date"' },
  { key: 'closing_date', col: 'Closing Date', label: 'Closing date (projected until scheduled)', type: 'date', sides: ALL, section: 'Price & dates', sky: 'CLOSING DATE',
    labels: { Tenant: 'Lease start / move-in date', Landlord: 'Lease start / move-in date' } },
  { key: 'closing_time', col: 'Closing Time', label: 'Closing time (once scheduled, e.g. 11:30am)', type: 'text', sides: SALE, section: 'Price & dates' },
  { key: 'lease_end', col: 'Lease End', label: 'Lease end date', type: 'date', sides: LEASE, section: 'Price & dates' },
  { key: 'security_deposit', col: 'Security Deposit', label: 'Security deposit', type: 'money', sides: LEASE, section: 'Price & dates' },
  { key: 'renewal_option', col: 'Renewal Option', label: 'Renewal option in lease?', type: 'select', options: ['No', 'Yes'], sides: LEASE, section: 'Price & dates', sky: 'Renewal Option' },
  { key: 'purchase_option', col: 'Purchase Option', label: 'Purchase option in lease?', type: 'select', options: ['No', 'Yes'], sides: LEASE, section: 'Price & dates', sky: 'Purchase Option' },
  { key: 'deposit_amount', col: 'Down Payment / Deposit', label: 'Contract deposit (down payment held in escrow)', type: 'money', sides: SALE, section: 'Price & dates', sky: 'DEPOSIT AMOUNT' },
  { key: 'brokerage_holds_deposit', col: 'Brokerage Holds Deposit', label: 'Is our brokerage holding the deposit?', type: 'select', options: ['No', 'Yes'], default: 'No', sides: ALL, section: 'Price & dates', sky: 'Will Brokerage Hold Earnest Money?' },

  // ---- Commission
  { key: 'listing_comm_pct', col: 'Listing Commission %', label: 'Listing-side commission %', type: 'number', sides: ALL, section: 'Commission', sky: 'LISTING COMMISSION (%)' },
  { key: 'listing_comm_amt', col: 'Listing Commission $', label: 'Listing-side commission $ (if flat)', type: 'money', sides: ALL, section: 'Commission', sky: 'LISTING COMMISSION ($)' },
  { key: 'sale_comm_pct', col: 'Buyer-Side Commission %', label: 'Buyer/tenant-side commission %', type: 'number', sides: ALL, section: 'Commission', sky: 'SALE COMMISSION (%)' },
  { key: 'sale_comm_amt', col: 'Buyer-Side Commission $', label: 'Buyer/tenant-side commission $ (if flat)', type: 'money', sides: ALL, section: 'Commission', sky: 'SALE COMMISSION ($)' },
  { key: 'personal_deal', col: 'Personal Deal', label: 'Personal deal (you or family are the client)?', type: 'select', options: ['No', 'Yes'], default: 'No', sides: ALL, section: 'Commission', sky: 'PERSONAL DEAL' },
  { key: 'referral_type', col: 'Referral Type', label: 'Referral fee owed?', type: 'select', options: ['No Referral', 'External', 'Internal'], default: 'No Referral', sides: ALL, section: 'Commission', sky: 'REFERRAL TYPE' },
  { key: 'referral_agent', col: 'Referral Agent', label: 'Referral agent', type: 'text', sides: ALL, section: 'Commission', sky: 'REFERRAL AGENT' },
  { key: 'referral_brokerage', col: 'Referral Brokerage', label: 'Referral brokerage', type: 'text', sides: ALL, section: 'Commission', sky: 'REFERRAL BROKERAGE NAME' },
  { key: 'referral_pct', col: 'Referral %', label: 'Referral %', type: 'number', sides: ALL, section: 'Commission', sky: 'REFERRAL AMOUNT (%)' },
  { key: 'referral_amt', col: 'Referral $', label: 'Referral $ (if flat)', type: 'money', sides: ALL, section: 'Commission', sky: 'REFERRAL AMOUNT ($)' },
  { key: 'commission_notes', col: 'Commission Notes', label: 'Anything else about the commission', type: 'textarea', sides: ALL, section: 'Commission', sky: 'ADDITIONAL COMMISSION BREAKDOWN INFO' },

  // ---- Other side
  { key: 'other_first', col: 'Other Party First Name', label: 'Other party first name', type: 'text', sides: ALL, section: 'Other side', sky: 'Seller/Purchaser tab',
    labels: { Seller: 'Buyer first name', Buyer: 'Seller first name', Tenant: 'Landlord first name', Landlord: 'Tenant first name' } },
  { key: 'other_last', col: 'Other Party Last Name', label: 'Other party last name', type: 'text', sides: ALL, section: 'Other side', sky: 'Seller/Purchaser tab',
    labels: { Seller: 'Buyer last name', Buyer: 'Seller last name (or company)', Tenant: 'Landlord last name (or company)', Landlord: 'Tenant last name' } },
  { key: 'other_email', col: 'Other Party Email', label: 'Other party email', type: 'email', sides: ALL, section: 'Other side' },
  { key: 'other_phone', col: 'Other Party Phone', label: 'Other party phone', type: 'tel', sides: ALL, section: 'Other side' },
  { key: 'other_agent_first', col: 'Other Agent First Name', label: 'Other side\'s agent first name', type: 'text', sides: ALL, section: 'Other side', sky: 'AGENT REPRESENTING OTHER SIDE (required on that tab)' },
  { key: 'other_agent_last', col: 'Other Agent Last Name', label: 'Other side\'s agent last name', type: 'text', sides: ALL, section: 'Other side', sky: 'AGENT REPRESENTING OTHER SIDE (required on that tab)' },
  { key: 'other_brokerage', col: 'Other Brokerage', label: 'Other side\'s brokerage', type: 'text', sides: ALL, section: 'Other side', sky: 'Company' },
  { key: 'other_agent_email', col: 'Other Agent Email', label: 'Other agent email', type: 'email', sides: ALL, section: 'Other side' },
  { key: 'other_agent_phone', col: 'Other Agent Phone', label: 'Other agent phone', type: 'tel', sides: ALL, section: 'Other side' },

  // ---- Attorneys, lender, title
  { key: 'client_attorney_name', col: 'Client Attorney', label: 'Your client\'s attorney (first & last)', type: 'text', sides: ALL, section: 'Attorneys, lender & title', sky: 'Attorney (required on that tab)' },
  { key: 'client_attorney_firm', col: 'Client Attorney Firm', label: 'Attorney\'s firm', type: 'text', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'client_attorney_phone', col: 'Client Attorney Phone', label: 'Attorney phone', type: 'tel', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'client_attorney_email', col: 'Client Attorney Email', label: 'Attorney email', type: 'email', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'other_attorney_name', col: 'Other Attorney', label: 'Other side\'s attorney (first & last)', type: 'text', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'other_attorney_firm', col: 'Other Attorney Firm', label: 'Their firm', type: 'text', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'other_attorney_phone', col: 'Other Attorney Phone', label: 'Their phone', type: 'tel', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'other_attorney_email', col: 'Other Attorney Email', label: 'Their email', type: 'email', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'cash_deal', col: 'Cash Deal', label: 'Cash deal (no lender)?', type: 'select', options: ['No', 'Yes'], sides: SALE, section: 'Attorneys, lender & title', sky: 'N/A Cash Deal' },
  { key: 'loan_type', col: 'Loan Type', label: 'Type of loan', type: 'select', options: SKY_LOAN_TYPES, sides: SALE, section: 'Attorneys, lender & title', sky: 'Type of Loan' },
  { key: 'loan_amount', col: 'Loan Amount', label: 'Loan amount', type: 'money', sides: SALE, section: 'Attorneys, lender & title', sky: 'Loan Amount' },
  { key: 'lender_company', col: 'Lender', label: 'Lender company', type: 'text', sides: SALE, section: 'Attorneys, lender & title', sky: 'Lender Company' },
  { key: 'loan_officer', col: 'Loan Officer', label: 'Loan officer (first & last)', type: 'text', sides: SALE, section: 'Attorneys, lender & title' },
  { key: 'loan_officer_phone', col: 'Loan Officer Phone', label: 'Loan officer phone', type: 'tel', sides: SALE, section: 'Attorneys, lender & title' },
  { key: 'loan_officer_email', col: 'Loan Officer Email', label: 'Loan officer email', type: 'email', sides: SALE, section: 'Attorneys, lender & title' },
  { key: 'title_company', col: 'Title Company', label: 'Title company', type: 'text', sides: SALE, section: 'Attorneys, lender & title', sky: 'Title tab' },
  { key: 'title_contact', col: 'Title Contact', label: 'Title contact (name, phone, email)', type: 'text', sides: SALE, section: 'Attorneys, lender & title' },

  // ---- Notes
  { key: 'notes', col: 'Notes', label: 'Notes for the office', type: 'textarea', sides: ALL, section: 'Notes' }
];

/** Milestones follow how a Long Island deal actually runs (attorney state). */
var MILESTONES = {
  Seller: [
    { key: 'listing_signed', label: 'Listing agreement signed' },
    { key: 'coming_soon', label: 'Coming Soon on MLS', status: 'Coming Soon' },
    { key: 'listed_live', label: 'Active on MLS', status: 'Active' },
    { key: 'accepted_offer', label: 'Accepted offer', status: 'Accepted Offer' },
    { key: 'inspection', label: 'Buyer\'s inspection done' },
    { key: 'contract_signed', label: 'Contract fully signed', status: 'Under Contract' },
    { key: 'appraisal', label: 'Appraisal done' },
    { key: 'commitment', label: 'Buyer\'s mortgage commitment' },
    { key: 'clear_to_close', label: 'Clear to close' },
    { key: 'closing_scheduled', label: 'Closing scheduled', status: 'Closing Set' },
    { key: 'closed', label: 'Closed', status: 'Sold' }
  ],
  Buyer: [
    { key: 'buyer_agreement', label: 'Buyer agreement / agency disclosure signed' },
    { key: 'preapproval', label: 'Pre-approval / proof of funds received' },
    { key: 'offer_submitted', label: 'Offer submitted' },
    { key: 'accepted_offer', label: 'Accepted offer', status: 'Accepted Offer' },
    { key: 'inspection', label: 'Inspection done' },
    { key: 'contract_signed', label: 'Contract fully signed', status: 'Under Contract' },
    { key: 'deposit_delivered', label: 'Down payment delivered to seller\'s attorney' },
    { key: 'appraisal', label: 'Appraisal done' },
    { key: 'commitment', label: 'Mortgage commitment' },
    { key: 'clear_to_close', label: 'Clear to close' },
    { key: 'closing_scheduled', label: 'Closing scheduled', status: 'Closing Set' },
    { key: 'final_walkthrough', label: 'Final walk-through' },
    { key: 'closed', label: 'Closed', status: 'Sold' }
  ],
  Tenant: [
    { key: 'rep_agreement', label: 'Tenant agreement / agency disclosure signed' },
    { key: 'showings', label: 'Showings started' },
    { key: 'application', label: 'Application submitted' },
    { key: 'approved', label: 'Application approved', status: 'Accepted Offer' },
    { key: 'lease_signed', label: 'Lease signed', status: 'Under Contract' },
    { key: 'deposit_paid', label: 'Deposit & first month paid' },
    { key: 'move_in', label: 'Move-in / keys delivered', status: 'Sold' }
  ],
  Landlord: [
    { key: 'listing_signed', label: 'Rental listing agreement signed' },
    { key: 'coming_soon', label: 'Coming Soon on MLS', status: 'Coming Soon' },
    { key: 'listed_live', label: 'Active on MLS', status: 'Active' },
    { key: 'application', label: 'Application received' },
    { key: 'screening', label: 'Tenant approved', status: 'Accepted Offer' },
    { key: 'lease_signed', label: 'Lease signed', status: 'Under Contract' },
    { key: 'deposit_collected', label: 'Deposit & first month collected' },
    { key: 'move_in', label: 'Move-in / keys delivered', status: 'Sold' }
  ]
};

var SYSTEM_COLUMNS_START = ['Deal ID', 'Created At', 'Updated At', 'Agent Name', 'Agent Email', 'SkySlope File Owner',
  'Side', 'Represents', 'SkySlope Type', 'Status', 'Current Milestone', 'Current Milestone Date', 'Next Milestone', 'Milestones Done',
  'SkySlope Status', 'SkySlope File', 'SkySlope Notes'];
var SYSTEM_COLUMNS_END = ['Milestone Summary', 'Inventory Tab', 'Inventory Result', 'Documents Folder', 'Milestones JSON', 'SkySlope Payload JSON'];

var MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
var SESSION_HOURS = 6;
var NEW_ROW_COLOR = '#fff8bf';

// ---------------------------------------------------------------------------
// WEB APP ENTRY
// ---------------------------------------------------------------------------

function doGet() {
  var html = typeof INDEX_HTML !== 'undefined' ? INDEX_HTML : HtmlService.createHtmlOutputFromFile('Index').getContent();
  return HtmlService.createHtmlOutput(html)
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getAppConfig() {
  return {
    appName: APP_NAME, sides: SIDES, statuses: STATUSES, offices: OFFICES,
    fields: FIELDS, milestones: MILESTONES, roster: readSkySlopeRoster_(), maxUploadBytes: MAX_UPLOAD_BYTES
  };
}

// ---------------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------------

function setup() {
  var ss = getSpreadsheet_();
  formatDealColumns_(ensureSheet_(ss, SHEETS.DEALS, dealHeaders_()));
  var agents = ensureSheet_(ss, SHEETS.AGENTS, ['Name', 'Email', 'PIN', 'Role', 'Active', 'Office', 'SkySlope Name']);
  ensureSheet_(ss, SHEETS.MILESTONE_LOG, ['Timestamp', 'Deal ID', 'Side', 'Property', 'Agent Email', 'Milestone', 'Change', 'Milestone Date', 'Note']);
  ensureSheet_(ss, SHEETS.SYNC_LOG, ['Timestamp', 'Deal ID', 'Target', 'Result', 'Details']);
  agents.getRange('B:C').setNumberFormat('@');
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('INVENTORY_SPREADSHEET_ID') === null) props.setProperty('INVENTORY_SPREADSHEET_ID', DEFAULT_INVENTORY_ID);
  if (props.getProperty('DOCS_FOLDER_ID') === null) props.setProperty('DOCS_FOLDER_ID', '');
  var hasAdmin = agents.getDataRange().getValues().some(function (r) { return String(r[3]).toLowerCase() === 'admin'; });
  if (!hasAdmin) {
    agents.appendRow(['Michael Aharoni', Session.getEffectiveUser().getEmail(), String(randomPin_()), 'Admin', 'Yes', 'Dix Hills', 'Michael Aharoni']);
  }
  var res = syncAgentsFromRoster();
  Logger.log('Setup complete. ' + res);
}

/** Adds a "Deal Tracker" menu to the spreadsheet. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Deal Tracker')
    .addItem('Sync agents from Office Sheets roster', 'syncAgentsFromRoster')
    .addToUi();
}

/**
 * Builds the Agents tab from the Office Sheets "Roster" tab: Office, Name,
 * PIN = the agent's MLS ID, Email (if the roster has an email column), and the
 * matching SkySlope File Owner name. Reads ONLY those columns, found by their
 * header text; no other roster column (e.g. passwords) is ever read.
 * Safe to run again: it updates existing agents, adds new ones, and marks
 * agents who left the roster Active = No. Rows with Role = Admin are left alone.
 */
function syncAgentsFromRoster() {
  var id = PropertiesService.getScriptProperties().getProperty('INVENTORY_SPREADSHEET_ID') || DEFAULT_INVENTORY_ID;
  var roster = SpreadsheetApp.openById(id).getSheetByName('Roster');
  if (!roster) throw new Error('No "Roster" tab in Office Sheets.');
  var header = roster.getRange(1, 1, 1, roster.getLastColumn()).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
  var find = function (re, label) {
    var hits = [];
    header.forEach(function (h, i) { if (re.test(h)) hits.push(i); });
    if (hits.length > 1) throw new Error('More than one ' + label + ' column on the Roster: ' + hits.map(function (i) { return header[i]; }).join(', '));
    return hits.length ? hits[0] : -1;
  };
  var cOffice = find(/^office$/i, 'Office'), cName = find(/^(agent\s*)?name$/i, 'Name');
  // MLS ID column: has "MLS" in the header but is not a password/login column
  var pick = function (test, prefer) {
    var hits = [];
    header.forEach(function (h, i) { if (test(h)) hits.push(i); });
    if (hits.length > 1) {
      var preferred = hits.filter(function (i) { return prefer.test(header[i]); });
      if (preferred.length) hits = preferred;
    }
    return hits;
  };
  var secret = /pass|pw|pwd|login|user|pin\b/i;
  var mlsHits = pick(function (h) { return /mls/i.test(h) && !secret.test(h); }, /id|#|number|no\.?$/i);
  if (mlsHits.length > 1) throw new Error('More than one MLS column on the Roster: ' + mlsHits.map(function (i) { return header[i]; }).join(', ') + '. Rename the one with the agent MLS ID to "MLS ID".');
  var cMls = mlsHits.length ? mlsHits[0] : -1;
  var emailHits = pick(function (h) { return /e-?mail/i.test(h) && !secret.test(h); }, /^e-?mail$/i);
  var cEmail = emailHits.length === 1 ? emailHits[0] : -1;
  if (cOffice < 0 || cName < 0) throw new Error('Roster needs "Office" and "Name" columns.');
  if (cMls < 0) throw new Error('No column with "MLS" in its header on the Roster. Headers found: ' + header.join(', '));
  var n = roster.getLastRow() - 1;
  if (n < 1) return 'Roster is empty.';
  var col = function (c) { return c < 0 ? null : roster.getRange(2, c + 1, n, 1).getDisplayValues().map(function (r) { return String(r[0]).trim(); }); };
  var offices = col(cOffice), names = col(cName), mls = col(cMls), emails = col(cEmail);

  var sheet = getSpreadsheet_().getSheetByName(SHEETS.AGENTS);
  var data = sheet.getDataRange().getValues();
  var h = indexHeaders_(data[0]);
  var byName = {};
  for (var i = 1; i < data.length; i++) byName[normName_(data[i][h['Name']])] = i + 1;

  var seen = {}, added = 0, updated = 0, noMls = [], noSky = [];
  for (var r = 0; r < n; r++) {
    var name = names[r];
    if (!name || OFFICES.indexOf(offices[r]) < 0) continue;
    var key = normName_(name);
    seen[key] = true;
    var pin = mls[r];
    if (!pin) noMls.push(name);
    var sky = matchSkySlopeName_(name);
    if (!sky) noSky.push(name);
    var rowNum = byName[key];
    if (rowNum) {
      var cur = data[rowNum - 1];
      if (String(cur[h['Role']]).toLowerCase() === 'admin') continue;
      sheet.getRange(rowNum, h['Office'] + 1).setValue(offices[r]);
      if (pin) sheet.getRange(rowNum, h['PIN'] + 1).setValue(pin);
      if (emails && emails[r] && !String(cur[h['Email']]).trim()) sheet.getRange(rowNum, h['Email'] + 1).setValue(emails[r]);
      if (sky && !String(cur[h['SkySlope Name']]).trim()) sheet.getRange(rowNum, h['SkySlope Name'] + 1).setValue(sky);
      sheet.getRange(rowNum, h['Active'] + 1).setValue('Yes');
      updated++;
    } else {
      sheet.appendRow([name, emails ? emails[r] : '', pin, 'Agent', 'Yes', offices[r], sky]);
      added++;
    }
  }
  var deactivated = 0;
  for (var j = 1; j < data.length; j++) {
    var nm = normName_(data[j][h['Name']]);
    if (nm && !seen[nm] && String(data[j][h['Role']]).toLowerCase() !== 'admin' && String(data[j][h['Active']]) !== 'No') {
      sheet.getRange(j + 1, h['Active'] + 1).setValue('No');
      deactivated++;
    }
  }
  var msg = 'Agents: ' + added + ' added, ' + updated + ' updated, ' + deactivated + ' marked inactive.' +
    (emails ? '' : ' The roster has no email column: add each agent\'s email in the Agents tab.') +
    (noMls.length ? ' No MLS ID on the roster for: ' + noMls.join(', ') + '.' : '') +
    (noSky.length ? ' Not found in SkySlope\'s File Owner list (fill SkySlope Name by hand): ' + noSky.join(', ') + '.' : '');
  Logger.log(msg);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Deal Tracker', 15); } catch (e) {}
  return msg;
}

/** SkySlope "File Owner" names, as SkySlope lists them (captured 2026-11-13). */
var SKYSLOPE_OWNERS = ['Debra J Asher', 'Carmel Romano', 'Chris Manteria', 'David Innocenzi', 'Lori Arav', 'Lyndsey Gallagher', 'Michael Aharoni', 'Rose Sidoti', 'Addy Sandler', 'Joshua Manda', 'Ely Chen', 'Clovia Leslie', 'Gabriele Guerra', 'Kevin A. Key', 'Gwendolyn Belton', 'Sara Wartski', 'Luis Gonzalez', 'Nina Trainor', 'Michael Dohne', 'Felix Jackson', 'John Esturo', 'Vivian Rosenthal', 'Deanna ten Hoopen', 'Neal Fontana', 'Stuart Anderson', 'Izzy Franco', 'Jacqueline Pollack', 'Ronald Starrantino', 'Patricia Frankel', 'Aruna Sood', 'Anne McCarthy', 'Vanneth Joseph-Gonzalez', 'Phil Sinagra', 'Carolann Lopes', 'Larry J Theodore', 'Robert Kane', 'Kelly A. A. Hicks', 'Igor Kuzmykha', 'Lina Pinzon', 'Latoya Saylor', 'George Martinez', 'Kathryn A Pullen', 'Evan Marrow', 'Rajesh Ramjeawan', 'Victoria Woodland', 'Richard Stanford', 'Gautam Arora', 'Orlando Laguna', 'Isabel Clostre', 'John Rojecki', 'Michael McCarthy', 'Khrystyna Luchka', 'John Geldert', 'Jesse Saperstein', 'Laura Keenan', 'Lance Woodland', 'Maria M Cudabac', 'Jenifer Stryska', 'Parag Pandya', 'Thomas Dibiasi', 'Mona Mills-Johnson', 'James Iadevaio', 'Mireya Mead', 'Rachel Geraghty', 'Conte Cuttino', 'Eugenia Adams', 'Carolina Siegler', 'Robert Matozzo', 'Marie Certa', 'Ivette Echeverria', 'Rosaura Marmol', 'Richard Varon', 'Phyllis LiBrandi', 'Joseph LiBrandi', 'Gary Fernandez', 'Diane Douglas', 'Marc Zarou', 'Lisamarie Kayola', 'Milagros Cabrera', 'Nicole Absalom', 'Michael Cowan', 'Shoushan Saraydarian', 'Lavern Sterling-Felix', 'Christina Cardona', 'Jonathan Bedoya', 'Monica R Montenegro', 'Anthony Lomangino', 'Mohamed Badsha', 'Angel Vega', 'Diane Levy', 'Morena Morales', 'Ryan Hodulick', 'Denielle Passaretti', 'Kellyann Imeidopf', 'Tyler June', 'Donavan Rowe', 'Ceciabel Benavides', 'Ryan Sturm', 'Abderrahmane "Joe" Messaoud', 'Milly (Iankel) Baez', 'Christina Vernot', 'Zhaotong Tian', 'Jhaneal Smith', 'Jennifer Chan', 'Saima Joel', 'Maribel Torres', 'Nissar Ahmed Khpalwak', 'Paul Salemi', 'Paulina Obolewicz', 'Jonida Sevo'];

function normName_(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }

/** Roster name -> SkySlope File Owner name ('' if no confident match). */
function matchSkySlopeName_(name) {
  var words = function (s) { return String(s).toLowerCase().replace(/[\(\"][^\)\"]*[\)\"]/g, ' ').replace(/[^a-z\s-]/g, '').split(/\s+/).filter(String); };
  var nicks = function (s) { return (String(s).match(/[\(\"]([^\)\"]+)[\)\"]/g) || []).map(function (x) { return x.replace(/[\(\)\"]/g, '').toLowerCase().trim(); }); };
  var fl = function (s) { var w = words(s); return w.length ? w[0] + '|' + w[w.length - 1] : ''; };
  var last = function (s) { var w = words(s); return w[w.length - 1] || ''; };
  var first = function (s) { return words(s)[0] || ''; };
  var i, s;
  for (i = 0; i < SKYSLOPE_OWNERS.length; i++) {
    s = SKYSLOPE_OWNERS[i];
    if (normName_(s) === normName_(name) || fl(s) === fl(name)) return s;
    if (nicks(s).some(function (k) { return k + '|' + last(s) === fl(name); })) return s;
    if (nicks(name).some(function (k) { return k + '|' + last(name) === fl(s); })) return s;
  }
  var c = SKYSLOPE_OWNERS.filter(function (o) { return last(o) === last(name) && first(o).charAt(0) === first(name).charAt(0); });
  return c.length === 1 ? c[0] : '';
}

function upgradeColumns() {
  formatDealColumns_(ensureSheet_(getSpreadsheet_(), SHEETS.DEALS, dealHeaders_()));
}

function formatDealColumns_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var textCols = ['Deal ID', 'Agent Email'];
  FIELDS.forEach(function (f) { if (['money', 'number', 'date'].indexOf(f.type) < 0) textCols.push(f.col); });
  headers.forEach(function (h, i) {
    if (textCols.indexOf(h) >= 0) sheet.getRange(2, i + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  });
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

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
  if (fails >= 5) throw new Error('Too many attempts. Try again in 15 minutes or ask Mac to reset your PIN.');
  var agent = findAgent_(email);
  if (!agent || !agent.active || !agent.pin || agent.pin.replace(/\s/g, '').toLowerCase() !== pin.replace(/\s/g, '').toLowerCase()) {
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
  var session = { email: agent.email, name: agent.name, isAdmin: agent.isAdmin, office: agent.office, skyslopeName: agent.skyslopeName };
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
  var cell = function (r, name) { return h[name] != null ? String(r[h[name]] || '').trim() : ''; };
  for (var i = 1; i < rows.length; i++) {
    if (cell(rows[i], 'Email').toLowerCase() === email) {
      var r = rows[i];
      return {
        name: cell(r, 'Name'), email: email, pin: cell(r, 'PIN'),
        isAdmin: cell(r, 'Role').toLowerCase() === 'admin',
        active: cell(r, 'Active').toLowerCase() !== 'no',
        office: cell(r, 'Office'), skyslopeName: cell(r, 'SkySlope Name') || cell(r, 'Name')
      };
    }
  }
  return null;
}

/** Agent names for the co-agent picker (from the Agents tab). */
function readSkySlopeRoster_() {
  var sheet = getSpreadsheet_().getSheetByName(SHEETS.AGENTS);
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues();
  var h = indexHeaders_(rows[0]);
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var n = String(rows[i][h['SkySlope Name']] || rows[i][h['Name']] || '').trim();
    if (n && String(rows[i][h['Active']] || '').toLowerCase() !== 'no') out.push(n);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// DEALS API
// ---------------------------------------------------------------------------

function listDeals(token) {
  var user = requireSession_(token);
  return readDeals_().deals
    .filter(function (d) { return user.isAdmin || d.agent_email === user.email; })
    .map(function (d) {
      return {
        deal_id: d.deal_id, side: d.side, represents: d.represents, status: d.status,
        agent_name: d.agent_name, agent_email: d.agent_email, office: d.office,
        address: shortAddress_(d), client_name: [d.client_first, d.client_last].filter(String).join(' ') || d.client_company,
        current_milestone_date: d.current_milestone_date, next_milestone: d.next_milestone,
        milestones_done: d.milestones_done, milestones_total: (MILESTONES[d.side] || []).length,
        closing_date: d.closing_date || '', updated_at: d.updated_at,
        skyslope_status: d.skyslope_status, skyslope_file: d.skyslope_file
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
  delete deal.skyslope_payload;
  return deal;
}

/**
 * input = { deal_id?, side, status, fields: {key: value}, milestones: {key: {done, date, note}} }
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
      deal_id: newDealId_(), created_at: now, agent_name: user.name, agent_email: user.email,
      skyslope_owner: user.skyslopeName || user.name, skyslope_status: 'Queued', documents_folder: ''
    };
    if (existing && before.side !== input.side && before.skyslope_status && before.skyslope_status !== 'Queued') {
      throw new Error('This deal is already in SkySlope as a ' + before.side + ' file. Ask Mac to change the side.');
    }
    deal.side = input.side;
    deal.updated_at = now;

    var errors = [];
    FIELDS.forEach(function (f) {
      if (f.sides.indexOf(deal.side) < 0) { deal[f.key] = ''; return; }
      var v = input.fields && input.fields[f.key] != null ? String(input.fields[f.key]).trim() : '';
      if (f.type === 'money' || f.type === 'number') v = v.replace(/[$,%\s]/g, '');
      var opts = optionsFor_(f, deal.side);
      if (v && opts && opts.indexOf(v) < 0) errors.push(labelFor_(f, deal.side) + ' (not a valid choice)');
      if (isRequired_(f, deal.side) && !v) errors.push(labelFor_(f, deal.side));
      deal[f.key] = v;
    });
    if (errors.length) throw new Error('Please check: ' + errors.join(', '));

    deal.represents = deal.represent_both === 'Yes' ? 'Dual' : deal.side;
    deal.skyslope_type = skySlopeType_(deal);

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
        msChanges.push({ key: m.key, label: m.label, status: m.status, change: done ? (o.done ? 'updated' : 'completed') : (o.done ? 'reopened' : 'noted'), date: date, note: note });
      }
    });
    deal.milestones = newMs;
    applyMilestoneSummary_(deal);

    // Status: agent's choice, but a completed milestone moves it forward (never back)
    var status = STATUSES.indexOf(input.status) >= 0 ? input.status : (before.status || defaultStatus_(deal.side));
    msChanges.forEach(function (c) {
      if (c.change === 'completed' && c.status && status !== 'Cancelled' && status !== 'TOM' &&
          (STATUS_RANK[c.status] || 0) > (STATUS_RANK[status] || 0)) status = c.status;
    });
    deal.status = status;
    // Fill the contract date from the milestone if the agent didn't type it
    if (newMs.contract_signed && newMs.contract_signed.done && !deal.contract_date && deal.side !== 'Tenant' && deal.side !== 'Landlord') {
      deal.contract_date = newMs.contract_signed.date;
    }

    var changedFields = existing ? diffFields_(before, deal) : [];
    if (existing && changedFields.length && deal.skyslope_status && deal.skyslope_status !== 'Queued') {
      deal.skyslope_status = 'Update Queued';
      deal.skyslope_notes = 'Changed: ' + changedFields.join(', ');
    }
    deal.skyslope_payload = JSON.stringify(buildSkySlopePayload_(deal));

    var row = headers.map(function (h) { return toCell_(h, deal); });
    if (existing) sheet.getRange(existing.rowIndex, 1, 1, headers.length).setValues([row]);
    else sheet.appendRow(row);

    if (msChanges.length) {
      var log = getSpreadsheet_().getSheetByName(SHEETS.MILESTONE_LOG);
      msChanges.forEach(function (c) {
        log.appendRow([now, deal.deal_id, deal.side, shortAddress_(deal), user.email, c.label, c.change, c.date, c.note]);
      });
    }
    SpreadsheetApp.flush();
    result = { deal: deal, isNew: !existing, changedFields: changedFields, msChanges: msChanges };
  } finally {
    lock.releaseLock();
  }

  var inv;
  try {
    inv = syncInventory_(result.deal);
  } catch (e) {
    inv = { ok: false, message: 'Inventory update failed: ' + e.message };
  }
  logSync_(result.deal.deal_id, 'Office Sheets', inv.ok ? 'OK' : 'FAILED', inv.message);
  setDealCells_(result.deal.deal_id, { 'Inventory Tab': inv.tab || '', 'Inventory Result': isoNow_() + ' ' + inv.message });

  return {
    deal_id: result.deal.deal_id, isNew: result.isNew, status: result.deal.status,
    skyslope_status: result.deal.skyslope_status, inventory: inv
  };
}

// ---------------------------------------------------------------------------
// OFFICE SHEETS INVENTORY
// Columns: A Address | B MLS # | C Listing Date | D Expired Date | E Listing Price | F Status |
//          G Represents | H Skyslope | I UC Date | J UC Price | K Commission |
//          L Closing Date & Time | M Agent(s)
// Rules match the daily inventory sync: never duplicate, never overwrite what
// Mac typed, never move a status backwards.
// ---------------------------------------------------------------------------

function syncInventory_(deal) {
  if (deal.status === 'Cancelled') return { ok: true, message: 'Cancelled: inventory left as is for Mac to review.' };
  if (OFFICES.indexOf(deal.office) < 0) return { ok: false, message: 'No office chosen.' };
  var id = PropertiesService.getScriptProperties().getProperty('INVENTORY_SPREADSHEET_ID') || DEFAULT_INVENTORY_ID;
  var ss = SpreadsheetApp.openById(id);
  var tabs = OFFICES.map(function (o) { return ss.getSheetByName(o + ' Inventory'); });
  if (tabs.some(function (t) { return !t; })) return { ok: false, message: 'Inventory tabs not found.' };

  var want = inventoryValues_(deal);

  // 1. Already on either tab? (MLS # or street number + street name)
  for (var t = 0; t < tabs.length; t++) {
    var data = tabs[t].getRange(1, 1, Math.max(tabs[t].getLastRow(), 1), 13).getDisplayValues();
    for (var r = 1; r < data.length; r++) {
      if (rowMatches_(data[r], deal)) return updateInventoryRow_(tabs[t], r + 1, data[r], want, deal);
    }
  }

  // 2. Add a new row inside the data block of the agent's office tab
  var sheet = ss.getSheetByName(deal.office + ' Inventory');
  var vals = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 13).getDisplayValues();
  var lastData = 1, lastSameStatus = 0;
  for (var i = 1; i < vals.length; i++) {
    var a = String(vals[i][0]).trim();
    if (a.toUpperCase() === 'TOTAL') break;
    if (a) {
      lastData = i + 1;
      if (String(vals[i][5]).trim() === want[5]) lastSameStatus = i + 1;
    }
  }
  var after = lastSameStatus || lastData;
  sheet.insertRowAfter(after);
  var newRow = after + 1;
  var range = sheet.getRange(newRow, 1, 1, 13);
  range.setValues([want]);
  range.setBackground(NEW_ROW_COLOR);
  sheet.getRange(newRow, 5).setNumberFormat('$#,##0');
  sheet.getRange(newRow, 10, 1, 2).setNumberFormat('$#,##0');
  return { ok: true, tab: sheet.getName(), message: 'Added to ' + sheet.getName() + ' (row ' + newRow + ', yellow).' };
}

function updateInventoryRow_(sheet, rowNum, current, want, deal) {
  var changes = [];
  // Fill only blank cells: C, D, E, I, J, K, L (indexes 2,3,4,8,9,10,11)
  [2, 3, 4, 8, 9, 10, 11].forEach(function (c) {
    if (!String(current[c]).trim() && want[c] !== '') {
      sheet.getRange(rowNum, c + 1).setValue(want[c]);
      if (c === 4 || c === 9 || c === 10) sheet.getRange(rowNum, c + 1).setNumberFormat('$#,##0');
      changes.push(['', 'MLS #', 'Listing Date', 'Expired Date', 'Listing Price', '', '', '', 'UC Date', 'UC Price', 'Commission', 'Closing Date & Time'][c]);
    }
  });
  // Status: forward only; TOM/Sold rows are left for Mac
  var cur = String(current[5]).trim();
  var next = want[5];
  if (cur !== 'TOM' && cur !== 'Sold' && next !== cur) {
    if (next === 'TOM' || (STATUS_RANK[next] || 0) > (STATUS_RANK[cur] || 0)) {
      sheet.getRange(rowNum, 6).setValue(next);
      changes.push('Status ' + (cur || '(blank)') + ' → ' + next);
    }
  }
  return {
    ok: true, tab: sheet.getName(),
    message: changes.length ? 'Updated ' + sheet.getName() + ' row ' + rowNum + ': ' + changes.join(', ') + '.' : 'Already on ' + sheet.getName() + ' (row ' + rowNum + '); nothing new to fill.'
  };
}

function inventoryValues_(deal) {
  var isListing = deal.side === 'Seller' || deal.side === 'Landlord';
  var ucStatuses = ['Under Contract', 'Closing Set', 'Sold'];
  var underContract = ucStatuses.indexOf(deal.status) >= 0;
  var commission = commissionDollars_(deal);
  var closing = '';
  if ((deal.status === 'Closing Set' || deal.status === 'Sold') && deal.closing_date) {
    closing = mmdd_(deal.closing_date) + (deal.closing_time ? ' at ' + deal.closing_time : ' time unknown');
  }
  var agents = [deal.agent_name, deal.co_agent].filter(String).join(' / ');
  return [
    shortAddress_(deal) + (deal.city ? ', ' + deal.city : ''),
    deal.mls_number || '',
    isListing ? mmddyy_(deal.listing_date) : '',
    isListing ? mmddyy_(deal.listing_expiration) : '',
    deal.list_price ? Number(deal.list_price) : '',
    deal.status,
    deal.represents,
    'Needs To Be Added',
    underContract ? mmddyy_(deal.contract_date || deal.acceptance_date) : '',
    underContract && deal.price ? Number(deal.price) : '',
    underContract && commission ? commission : '',
    closing,
    agents
  ];
}

/** Our side's commission in dollars (both sides when dual). */
function commissionDollars_(deal) {
  var price = Number(deal.price || 0);
  var total = 0;
  var isListing = deal.side === 'Seller' || deal.side === 'Landlord';
  var dual = deal.represent_both === 'Yes';
  if (isListing || dual) total += deal.listing_comm_amt ? Number(deal.listing_comm_amt) : price * Number(deal.listing_comm_pct || 0) / 100;
  if (!isListing || dual) total += deal.sale_comm_amt ? Number(deal.sale_comm_amt) : price * Number(deal.sale_comm_pct || 0) / 100;
  return Math.round(total * 100) / 100;
}

function rowMatches_(row, deal) {
  var mls = String(deal.mls_number || '').replace(/\D/g, '');
  if (mls && String(row[1]).replace(/\D/g, '') === mls) return true;
  var addr = String(row[0]).toLowerCase();
  var num = String(deal.street_number || '').toLowerCase().trim();
  var firstWord = String(deal.street_name || '').toLowerCase().trim().split(/\s+/)[0] || '';
  return !!(num && firstWord && addr.indexOf(num + ' ') === 0 && addr.indexOf(firstWord) > 0);
}

// ---------------------------------------------------------------------------
// SKYSLOPE PAYLOAD: what the SkySlope task types into each screen
// (element ids from the 2026-11-13 capture)
// ---------------------------------------------------------------------------

function skySlopeType_(deal) {
  var dual = deal.represent_both === 'Yes';
  if (deal.side === 'Seller') return dual ? 'Both Purchase + Listing' : 'Listing';
  if (deal.side === 'Buyer') return dual ? 'Both Purchase + Listing' : 'Purchase';
  if (deal.side === 'Tenant') return dual ? 'Both Lease Tenant + Landlord' : 'Lease Tenant';
  return dual ? 'Both Lease Tenant + Landlord' : 'Lease Landlord';
}

function buildSkySlopePayload_(d) {
  var clientIsSellerSide = d.side === 'Seller' || d.side === 'Landlord';
  var client = [{ entity: d.client_is_entity === 'Yes', company: d.client_company, first: d.client_first, last: d.client_last, email: d.client_email, phone: d.client_phone }];
  if (d.client2_first || d.client2_last) client.push({ entity: false, company: '', first: d.client2_first, last: d.client2_last, email: d.client2_email, phone: d.client2_phone });
  var other = (d.other_first || d.other_last) ? [{ entity: false, company: '', first: d.other_first, last: d.other_last, email: d.other_email, phone: d.other_phone }] : [];
  var splitName = function (s) { var p = String(s || '').trim().split(/\s+/); return { first: p.slice(0, -1).join(' ') || p[0] || '', last: p.length > 1 ? p[p.length - 1] : '' }; };
  var attorneys = [];
  if (d.client_attorney_name) attorneys.push(Object.assign(splitName(d.client_attorney_name), { company: d.client_attorney_firm, phone: d.client_attorney_phone, email: d.client_attorney_email, represents: 'our client' }));
  if (d.other_attorney_name) attorneys.push(Object.assign(splitName(d.other_attorney_name), { company: d.other_attorney_firm, phone: d.other_attorney_phone, email: d.other_attorney_email, represents: 'other side' }));
  var lo = splitName(d.loan_officer);

  return {
    deal_id: d.deal_id,
    side: d.side,
    file_owner: d.skyslope_owner,
    forms_create: {
      url: 'https://forms.skyslope.com/create?representationType=' + ({ Seller: 'Seller', Buyer: 'Buyer', Tenant: 'tenant', Landlord: 'landlord' })[d.side],
      onBehalfOfAutoComplete: d.skyslope_owner,
      representationType: d.side,
      createSellerNetSheet: d.side === 'Seller' ? (d.seller_net_sheet || 'Yes') : null,
      contacts: client.map(function (c) { return { entity: c.entity, company: c.company, firstName: c.first, lastName: c.last, email: c.email }; }),
      streetAddress: [d.street_number, d.direction, d.street_name].filter(String).join(' '),
      unitNumber: d.unit, city: d.city, state: d.state, postalCode: d.zip, county: d.county,
      nameType: 'Address',
      template: d.forms_template
    },
    transaction: {
      ddlCheckListOffice: d.office, ddlProperty: d.checklist_type, txtMLS: d.mls_number,
      txtStreet: d.street_number, ddlDirection: d.direction, txtStreetName: d.street_name, txtUnitNum: d.unit,
      txtZip: d.zip, ddlStateSelect: d.state, txtCity: d.city, txtCounty: d.county,
      coAgent: d.co_agent,
      ddlType: d.skyslope_type,
      txtSalePrice: d.price || d.list_price, txtYearBuilt: d.year_built,
      ddlSource: d.source, ddlWillOwnerOccupy: d.office_lead,
      txtContractDate: slash_(d.acceptance_date), txtClosingDate: slash_(d.closing_date),
      txtListPrice: d.list_price, txtListingExpiryDate: slash_(d.listing_expiration),
      ddlRenewalOpt: d.renewal_option, ddlPurchaseOpt: d.purchase_option
    },
    contacts: {
      seller_landlord: clientIsSellerSide ? client : other,
      purchaser_tenant: clientIsSellerSide ? other : client,
      attorneys: attorneys,
      agent_other_side: (d.other_agent_first || d.other_agent_last) ? { first: d.other_agent_first, last: d.other_agent_last, company: d.other_brokerage, email: d.other_agent_email, phone: d.other_agent_phone } : null,
      lender: (d.side === 'Seller' || d.side === 'Buyer') ? {
        cashDeal: d.cash_deal === 'Yes', loanType: d.loan_type, loanAmount: d.loan_amount, company: d.lender_company,
        first: lo.first, last: lo.last, phone: d.loan_officer_phone, email: d.loan_officer_email
      } : null,
      title: d.title_company ? { company: d.title_company, contact: d.title_contact } : null
    },
    commission: {
      txtSalePrice: d.price || d.list_price,
      personalDeal: d.personal_deal || 'No',
      txtListingCommisionPercentage: d.listing_comm_pct, txtlistingamt: d.listing_comm_amt,
      txtSaleCommisionPercentage: d.sale_comm_pct, txtsalescommissionamt: d.sale_comm_amt,
      brokerageWillHoldEarnestMoney: d.brokerage_holds_deposit || 'No', DepositAmountTextBox: d.deposit_amount,
      ddlReferralType: d.referral_type || 'No Referral', txtReferringAgent: d.referral_agent, txtCompany: d.referral_brokerage,
      txtReferralAmount: d.referral_amt, txtReferralAmountPercentage: d.referral_pct,
      txtCommisionBreakdownDescription: d.commission_notes,
      split: d.co_agent ? { txtSharedAgentName1: d.co_agent, txtSharedAgentperr1: d.co_agent_split } : null
    },
    signature: {
      signers: client.filter(function (c) { return c.email; }).map(function (c) { return { name: (c.first + ' ' + c.last).trim(), email: c.email }; })
    }
  };
}

// ---------------------------------------------------------------------------
// DOCUMENTS (Drive folder per deal)
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
  var saved = folder.createFile(Utilities.newBlob(bytes, file.mimeType || 'application/octet-stream', file.name || 'document'));
  if (file.category) saved.setDescription(file.category);
  return listDocuments_(found.deal);
}

function getDealFolder_(found) {
  var deal = found.deal;
  var id = extractDriveId_(deal.documents_folder);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var props = PropertiesService.getScriptProperties();
  var root;
  try { root = props.getProperty('DOCS_FOLDER_ID') ? DriveApp.getFolderById(props.getProperty('DOCS_FOLDER_ID')) : null; } catch (e) { root = null; }
  if (!root) { root = DriveApp.createFolder(APP_NAME + ' Documents'); props.setProperty('DOCS_FOLDER_ID', root.getId()); }
  var folder = root.createFolder(deal.deal_id + ' - ' + shortAddress_(deal) + ' (' + deal.side + ')');
  try { folder.addEditor(deal.agent_email); } catch (e) {}
  setDealCells_(deal.deal_id, { 'Documents Folder': folder.getUrl() });
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
  } catch (e) { return []; }
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
  if (!existing.filter(String).length) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  else if (missing.length) sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  return sheet;
}

var SYSTEM_KEYS = {
  'Deal ID': 'deal_id', 'Created At': 'created_at', 'Updated At': 'updated_at', 'Agent Name': 'agent_name',
  'Agent Email': 'agent_email', 'SkySlope File Owner': 'skyslope_owner', 'Side': 'side', 'Represents': 'represents',
  'SkySlope Type': 'skyslope_type', 'Status': 'status', 'Current Milestone': 'current_milestone',
  'Current Milestone Date': 'current_milestone_date', 'Next Milestone': 'next_milestone', 'Milestones Done': 'milestones_done',
  'SkySlope Status': 'skyslope_status', 'SkySlope File': 'skyslope_file', 'SkySlope Notes': 'skyslope_notes',
  'Milestone Summary': 'milestone_summary', 'Inventory Tab': 'inventory_tab', 'Inventory Result': 'inventory_result',
  'Documents Folder': 'documents_folder', 'SkySlope Payload JSON': 'skyslope_payload'
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
  if (!key) return (deal._extra && deal._extra[header] != null) ? deal._extra[header] : '';
  var v = deal[key];
  return v == null ? '' : v;
}

function readDeals_() {
  var sheet = getSpreadsheet_().getSheetByName(SHEETS.DEALS);
  if (!sheet) throw new Error('Run setup() first.');
  var range = sheet.getDataRange();
  var values = range.getValues();
  var display = range.getDisplayValues();
  var headers = values[0].map(String);
  var map = colToKey_();
  var deals = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    var d = { _row: i + 1, _extra: {} };
    headers.forEach(function (h, c) {
      var v = values[i][c];
      if (h === 'Milestones JSON') { try { d.milestones = JSON.parse(v || '{}'); } catch (e) { d.milestones = {}; } return; }
      var key = map[h];
      var out = v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : (typeof v === 'number' ? String(v) : String(display[i][c]));
      if (key) d[key] = out; else if (h) d._extra[h] = v;
    });
    d.agent_email = String(d.agent_email || '').toLowerCase();
    deals.push(d);
  }
  return { sheet: sheet, headers: headers, deals: deals };
}

function findDealRow_(dealId) {
  var deals = readDeals_().deals;
  for (var i = 0; i < deals.length; i++) if (deals[i].deal_id === dealId) return { rowIndex: deals[i]._row, deal: deals[i] };
  return null;
}

function setDealCells_(dealId, cells) {
  var found = findDealRow_(dealId);
  if (!found) return;
  var sheet = getSpreadsheet_().getSheetByName(SHEETS.DEALS);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  Object.keys(cells).forEach(function (h) {
    var c = headers.indexOf(h);
    if (c >= 0) sheet.getRange(found.rowIndex, c + 1).setValue(cells[h]);
  });
}

function logSync_(dealId, target, result, details) {
  var log = getSpreadsheet_().getSheetByName(SHEETS.SYNC_LOG);
  if (log) log.appendRow([isoNow_(), dealId, target, result, details]);
}

function assertCanAccess_(user, deal) {
  if (!user.isAdmin && deal.agent_email !== user.email) throw new Error('You can only open your own deals.');
}

function applyMilestoneSummary_(deal) {
  var list = MILESTONES[deal.side] || [];
  var ms = deal.milestones || {};
  var lastDone = null, next = null, count = 0;
  list.forEach(function (m) { var s = ms[m.key] || {}; if (s.done) { count++; lastDone = { label: m.label, date: s.date }; } });
  for (var i = 0; i < list.length; i++) if (!(ms[list[i].key] || {}).done) { next = list[i]; break; }
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

function optionsFor_(f, side) { return f.optionsBySide ? f.optionsBySide[side] : (f.options || null); }
function isRequired_(f, side) { return f.req === true || (Array.isArray(f.req) && f.req.indexOf(side) >= 0); }
function labelFor_(f, side) { return (f.labels && f.labels[side]) || f.label; }
function defaultStatus_(side) { return 'Active'; }

function shortAddress_(d) {
  return [d.street_number, d.direction, d.street_name].filter(String).join(' ') + (d.unit ? ' #' + d.unit : '');
}

function mmddyy_(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[2] + '/' + m[3] + '/' + m[1].slice(2) : '';
}
function mmdd_(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[2] + '/' + m[3] : '';
}
function slash_(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[2] + '/' + m[3] + '/' + m[1] : '';
}

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
function indexHeaders_(row) { var h = {}; row.forEach(function (n, i) { h[String(n).trim()] = i; }); return h; }
function extractDriveId_(s) { var m = String(s || '').match(/[-\w]{25,}/); return m ? m[0] : ''; }
