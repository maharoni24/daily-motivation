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
    .addItem('Set up Deal Tracker (run once)', 'setup')
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


// ---------------------------------------------------------------------------
// THE PAGE AGENTS SEE (kept in this file so the whole app is one paste)
// ---------------------------------------------------------------------------
var INDEX_HTML = "<!DOCTYPE html>\n<html>\n<head>\n<base target=\"_top\">\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Agent Deal Tracker</title>\n<style>\n  :root {\n    --bg: #f4f5f7; --card: #ffffff; --ink: #111827; --muted: #6b7280; --line: #e5e7eb;\n    --brand: #1f2937; --accent: #2563eb; --accent-ink: #ffffff; --ok: #059669; --warn: #d97706; --bad: #dc2626;\n    --seller: #7c3aed; --buyer: #2563eb; --tenant: #0d9488; --landlord: #c2410c;\n    --radius: 12px;\n  }\n  * { box-sizing: border-box; }\n  body { margin: 0; font: 15px/1.45 -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--ink); }\n  header.top { background: var(--brand); color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }\n  header.top h1 { font-size: 17px; margin: 0; flex: 1; letter-spacing: .2px; }\n  header.top .who { font-size: 13px; opacity: .85; }\n  main { max-width: 980px; margin: 0 auto; padding: 16px; }\n  .hidden { display: none !important; }\n  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; }\n  .btn { appearance: none; border: 1px solid var(--line); background: #fff; color: var(--ink); padding: 9px 14px; border-radius: 9px; font: inherit; font-weight: 600; cursor: pointer; }\n  .btn:hover { background: #f9fafb; }\n  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }\n  .btn.primary:hover { filter: brightness(1.07); }\n  .btn.ghost { background: transparent; border-color: rgba(255,255,255,.35); color: #fff; }\n  .btn:disabled { opacity: .55; cursor: default; }\n  label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px; }\n  input, select, textarea { width: 100%; font: inherit; padding: 9px 10px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: var(--ink); }\n  input:focus, select:focus, textarea:focus { outline: 2px solid #bfdbfe; border-color: var(--accent); }\n  textarea { min-height: 90px; resize: vertical; }\n  .req::after { content: \" *\"; color: var(--bad); }\n  .muted { color: var(--muted); }\n  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }\n\n  /* Login */\n  #login { max-width: 380px; margin: 8vh auto 0; }\n  #login h2 { margin: 0 0 4px; }\n  #login .field { margin-top: 12px; }\n\n  /* Toolbar & list */\n  .toolbar { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin-bottom: 12px; }\n  .filters { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 8px; margin-bottom: 14px; }\n  .filters.admin { grid-template-columns: 2fr 1fr 1fr 1.3fr; }\n  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }\n  .stat { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }\n  .stat b { display: block; font-size: 20px; }\n  .stat span { font-size: 12px; color: var(--muted); }\n  .deal { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; padding: 14px 16px; margin-bottom: 10px; cursor: pointer; transition: border-color .15s; }\n  .deal:hover { border-color: #93c5fd; }\n  .deal .addr { font-weight: 700; }\n  .deal .meta { font-size: 13px; color: var(--muted); }\n  .badge { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; color: #fff; }\n  .b-Seller { background: var(--seller); } .b-Buyer { background: var(--buyer); } .b-Tenant { background: var(--tenant); } .b-Landlord { background: var(--landlord); }\n  .status { font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; white-space: nowrap; }\n  .s-Sold { background: #d1fae5; color: #065f46; } .s-Cancelled { background: #fee2e2; color: #991b1b; } .s-TOM { background: #fef3c7; color: #92400e; }\n  .s-Under, .s-Closing { background: #dbeafe; color: #1e40af; } .s-Accepted { background: #ede9fe; color: #5b21b6; } .s-Coming { background: #f3f4f6; color: #374151; }\n  .help { display: block; font-size: 12px; color: var(--muted); margin-top: 3px; }\n  .sky { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: #f3f4f6; color: #374151; white-space: nowrap; }\n  .sky.ok { background: #d1fae5; color: #065f46; } .sky.wait { background: #fef3c7; color: #92400e; } .sky.err { background: #fee2e2; color: #991b1b; }\n  .bar { height: 6px; background: #e5e7eb; border-radius: 99px; overflow: hidden; grid-column: 1 / -1; }\n  .bar > i { display: block; height: 100%; background: var(--ok); }\n  .empty { text-align: center; padding: 40px 16px; color: var(--muted); }\n\n  /* Side picker */\n  .sides { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 12px; }\n  .side-tile { border: 2px solid var(--line); border-radius: var(--radius); padding: 18px; background: #fff; cursor: pointer; text-align: left; font: inherit; }\n  .side-tile:hover { border-color: var(--accent); }\n  .side-tile b { display: block; font-size: 18px; margin-bottom: 4px; }\n  .side-tile span { font-size: 13px; color: var(--muted); }\n\n  /* Editor */\n  .ed-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }\n  .ed-head h2 { margin: 0; font-size: 20px; flex: 1; min-width: 200px; }\n  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 14px; overflow-x: auto; }\n  .tab { padding: 10px 14px; border: 0; background: none; font: inherit; font-weight: 600; color: var(--muted); border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; }\n  .tab.on { color: var(--accent); border-color: var(--accent); }\n  fieldset { border: 0; padding: 0; margin: 0 0 18px; }\n  legend { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin-bottom: 10px; }\n  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px 14px; }\n  .grid .wide { grid-column: 1 / -1; }\n  .ms { display: grid; grid-template-columns: 28px 1fr 150px; gap: 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); }\n  .ms:last-child { border-bottom: 0; }\n  .ms input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--ok); }\n  .ms .ml { font-weight: 600; }\n  .ms.done .ml { color: var(--ok); }\n  .ms .note { grid-column: 2 / -1; font-size: 13px; padding: 6px 8px; }\n  .savebar { position: sticky; bottom: 0; background: rgba(244,245,247,.95); backdrop-filter: blur(4px); padding: 12px 0; display: flex; gap: 10px; justify-content: flex-end; border-top: 1px solid var(--line); margin-top: 10px; }\n  .docs-upload { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: end; margin-bottom: 14px; }\n  .doc { display: flex; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 14px; }\n  .doc a { color: var(--accent); font-weight: 600; text-decoration: none; word-break: break-word; }\n\n  /* Toast */\n  #toast { position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); background: #111827; color: #fff; padding: 11px 16px; border-radius: 10px; font-size: 14px; max-width: calc(100% - 32px); z-index: 50; box-shadow: 0 8px 24px rgba(0,0,0,.2); }\n  #toast.err { background: var(--bad); }\n  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -2px; margin-right: 6px; }\n  @keyframes spin { to { transform: rotate(360deg); } }\n\n  @media (max-width: 640px) {\n    .grid, .filters, .filters.admin, .sides, .docs-upload { grid-template-columns: 1fr; }\n    .stats { grid-template-columns: repeat(2, 1fr); }\n    .ms { grid-template-columns: 28px 1fr; }\n    .ms input[type=date] { grid-column: 2; }\n    header.top .who { display: none; }\n  }\n</style>\n</head>\n<body>\n\n<header class=\"top\">\n  <h1 id=\"appTitle\">Agent Deal Tracker</h1>\n  <span class=\"who\" id=\"who\"></span>\n  <button class=\"btn ghost hidden\" id=\"logoutBtn\">Sign out</button>\n</header>\n\n<main>\n  <!-- LOGIN -->\n  <section id=\"login\" class=\"card hidden\">\n    <h2>Agent sign-in</h2>\n    <p class=\"muted\" style=\"margin:0\">Your email, and your MLS ID as your PIN.</p>\n    <form id=\"loginForm\">\n      <div class=\"field\"><label for=\"loginEmail\">Email</label><input id=\"loginEmail\" type=\"email\" autocomplete=\"email\" required></div>\n      <div class=\"field\"><label for=\"loginPin\">PIN (your MLS ID)</label><input id=\"loginPin\" type=\"password\" autocomplete=\"current-password\" required></div>\n      <div class=\"field\"><button class=\"btn primary\" style=\"width:100%\" type=\"submit\" id=\"loginBtn\">Sign in</button></div>\n    </form>\n  </section>\n\n  <!-- LIST -->\n  <section id=\"list\" class=\"hidden\">\n    <div class=\"toolbar\">\n      <h2 style=\"margin:0;align-self:center\" id=\"listTitle\">My deals</h2>\n      <button class=\"btn primary\" id=\"newDealBtn\">+ New deal</button>\n    </div>\n    <div class=\"stats\" id=\"stats\"></div>\n    <div class=\"filters\" id=\"filters\">\n      <input id=\"fSearch\" placeholder=\"Search address, client, deal ID\u2026\">\n      <select id=\"fSide\"><option value=\"\">All sides</option></select>\n      <select id=\"fStatus\"><option value=\"\">All statuses</option></select>\n      <select id=\"fAgent\" class=\"hidden\"><option value=\"\">All agents</option></select>\n    </div>\n    <div id=\"deals\"></div>\n  </section>\n\n  <!-- SIDE PICKER -->\n  <section id=\"picker\" class=\"hidden\">\n    <button class=\"btn\" data-go=\"list\">\u2190 Back</button>\n    <h2 style=\"margin:16px 0 0\">Who are you representing?</h2>\n    <div class=\"sides\">\n      <button class=\"side-tile\" data-side=\"Seller\"><b>Seller</b><span>Listing side of a sale</span></button>\n      <button class=\"side-tile\" data-side=\"Buyer\"><b>Buyer</b><span>Purchase side of a sale</span></button>\n      <button class=\"side-tile\" data-side=\"Tenant\"><b>Tenant</b><span>Helping someone lease a property</span></button>\n      <button class=\"side-tile\" data-side=\"Landlord\"><b>Landlord</b><span>Leasing out an owner's property</span></button>\n    </div>\n  </section>\n\n  <!-- EDITOR -->\n  <section id=\"editor\" class=\"hidden\">\n    <button class=\"btn\" data-go=\"list\">\u2190 All deals</button>\n    <div class=\"ed-head\" style=\"margin-top:14px\">\n      <span class=\"badge\" id=\"edSide\"></span>\n      <h2 id=\"edTitle\">New deal</h2>\n      <div style=\"min-width:170px\"><select id=\"edStatus\" aria-label=\"Deal status\"></select></div>\n    </div>\n    <p class=\"muted\" id=\"edMeta\" style=\"margin:-4px 0 10px;font-size:13px\"></p>\n    <div class=\"tabs\">\n      <button class=\"tab on\" data-tab=\"details\">Deal details</button>\n      <button class=\"tab\" data-tab=\"milestones\">Milestones <span id=\"msCount\"></span></button>\n      <button class=\"tab\" data-tab=\"docs\">Documents</button>\n    </div>\n\n    <form id=\"dealForm\" novalidate>\n      <div data-pane=\"details\" class=\"card\" id=\"detailsPane\"></div>\n      <div data-pane=\"milestones\" class=\"card hidden\">\n        <p class=\"muted\" style=\"margin-top:0\">Check each milestone as it happens. Dates default to today; change them if needed. Saving sends the update to the office.</p>\n        <div class=\"bar\" style=\"margin-bottom:8px\"><i id=\"msBar\" style=\"width:0\"></i></div>\n        <div id=\"msList\"></div>\n      </div>\n      <div data-pane=\"docs\" class=\"card hidden\">\n        <div id=\"docsLocked\" class=\"muted\">Save the deal first, then upload documents here.</div>\n        <div id=\"docsArea\" class=\"hidden\">\n          <div class=\"docs-upload\">\n            <div><label for=\"docCat\">Document type</label>\n              <select id=\"docCat\">\n                <option>Contract / Purchase Agreement</option><option>Listing Agreement</option><option>Buyer Agreement</option>\n                <option>Lease</option><option>Rental Application</option><option>Addendum / Amendment</option>\n                <option>Disclosure</option><option>Inspection Report</option><option>Earnest Money Receipt</option>\n                <option>Closing Disclosure / Settlement</option><option>Commission Disbursement</option><option>Other</option>\n              </select></div>\n            <div><label for=\"docFile\">File (max 20 MB)</label><input id=\"docFile\" type=\"file\" multiple></div>\n            <button class=\"btn primary\" type=\"button\" id=\"uploadBtn\">Upload</button>\n          </div>\n          <div id=\"docList\"></div>\n        </div>\n      </div>\n\n      <div class=\"savebar\">\n        <button class=\"btn\" type=\"button\" data-go=\"list\">Cancel</button>\n        <button class=\"btn primary\" type=\"submit\" id=\"saveBtn\">Save deal</button>\n      </div>\n    </form>\n  </section>\n</main>\n\n<div id=\"toast\" class=\"hidden\"></div>\n\n<script>\n(function () {\n  'use strict';\n\n  // ---------- server bridge ----------\n  function call(fn) {\n    var args = Array.prototype.slice.call(arguments, 1);\n    return new Promise(function (resolve, reject) {\n      google.script.run\n        .withSuccessHandler(resolve)\n        .withFailureHandler(function (err) {\n          var msg = (err && err.message) || String(err);\n          if (msg.indexOf('SESSION_EXPIRED') >= 0) { clearToken(); show('login'); msg = 'Your session expired. Please sign in again.'; }\n          reject(new Error(msg));\n        })[fn].apply(null, args);\n    });\n  }\n\n  // ---------- state ----------\n  var CFG = null, TOKEN = null, USER = null, DEALS = [], CURRENT = null;\n  var $ = function (id) { return document.getElementById(id); };\n  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }\n  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }\n  function clearToken() { TOKEN = null; store('dt_token', null); store('dt_user', null); }\n  function esc(s) { return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]; }); }\n\n  function toast(msg, isErr) {\n    var t = $('toast'); t.textContent = msg; t.className = isErr ? 'err' : '';\n    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = 'hidden'; }, isErr ? 6000 : 3500);\n  }\n  function busy(btn, on, text) {\n    if (on) { btn._txt = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class=\"spinner\"></span>' + (text || 'Working\u2026'); }\n    else { btn.disabled = false; if (btn._txt) btn.innerHTML = btn._txt; }\n  }\n  function show(view) {\n    ['login', 'list', 'picker', 'editor'].forEach(function (v) { $(v).classList.toggle('hidden', v !== view); });\n    $('logoutBtn').classList.toggle('hidden', view === 'login' || !TOKEN);\n    window.scrollTo(0, 0);\n  }\n\n  // ---------- boot ----------\n  call('getAppConfig').then(function (cfg) {\n    CFG = cfg;\n    $('appTitle').textContent = cfg.appName;\n    cfg.sides.forEach(function (s) { $('fSide').insertAdjacentHTML('beforeend', '<option>' + s + '</option>'); });\n    cfg.statuses.forEach(function (s) {\n      $('fStatus').insertAdjacentHTML('beforeend', '<option>' + s + '</option>');\n      $('edStatus').insertAdjacentHTML('beforeend', '<option>' + s + '</option>');\n    });\n    document.body.insertAdjacentHTML('beforeend', '<datalist id=\"rosterList\">' + (cfg.roster || []).map(function (n) { return '<option value=\"' + esc(n) + '\">'; }).join('') + '</datalist>');\n    TOKEN = load('dt_token');\n    try { USER = JSON.parse(load('dt_user') || 'null'); } catch (e) { USER = null; }\n    if (TOKEN && USER) return enterApp();\n    return call('tryAutoLogin').then(function (s) { if (s) { setSession(s); enterApp(); } else show('login'); });\n  }).catch(function (e) { show('login'); toast(e.message, true); });\n\n  function setSession(s) { TOKEN = s.token; USER = s.user; store('dt_token', TOKEN); store('dt_user', JSON.stringify(USER)); }\n\n  $('loginForm').addEventListener('submit', function (ev) {\n    ev.preventDefault();\n    var btn = $('loginBtn'); busy(btn, true, 'Signing in\u2026');\n    call('login', $('loginEmail').value, $('loginPin').value)\n      .then(function (s) { setSession(s); $('loginPin').value = ''; enterApp(); })\n      .catch(function (e) { toast(e.message, true); })\n      .then(function () { busy(btn, false); });\n  });\n\n  $('logoutBtn').addEventListener('click', function () { call('logout', TOKEN).catch(function () {}); clearToken(); USER = null; $('who').textContent = ''; show('login'); });\n\n  function enterApp() {\n    $('who').textContent = USER.name ? USER.name + (USER.isAdmin ? ' \u00b7 Admin' : '') : USER.email;\n    $('listTitle').textContent = USER.isAdmin ? 'All deals' : 'My deals';\n    $('fAgent').classList.toggle('hidden', !USER.isAdmin);\n    $('filters').classList.toggle('admin', !!USER.isAdmin);\n    show('list');\n    return refreshList();\n  }\n\n  // ---------- list ----------\n  function refreshList() {\n    $('deals').innerHTML = '<div class=\"empty\"><span class=\"spinner\"></span>Loading deals\u2026</div>';\n    return call('listDeals', TOKEN).then(function (deals) {\n      DEALS = deals || [];\n      if (USER.isAdmin) {\n        var agents = {}; DEALS.forEach(function (d) { agents[d.agent_email] = d.agent_name || d.agent_email; });\n        var cur = $('fAgent').value;\n        $('fAgent').innerHTML = '<option value=\"\">All agents</option>' + Object.keys(agents).sort().map(function (e) { return '<option value=\"' + esc(e) + '\">' + esc(agents[e]) + '</option>'; }).join('');\n        $('fAgent').value = cur;\n      }\n      renderList();\n    }).catch(function (e) { $('deals').innerHTML = '<div class=\"empty\">' + esc(e.message) + '</div>'; });\n  }\n\n  ['fSearch', 'fSide', 'fStatus', 'fAgent'].forEach(function (id) { $(id).addEventListener('input', renderList); });\n\n  function renderList() {\n    var q = $('fSearch').value.trim().toLowerCase(), side = $('fSide').value, st = $('fStatus').value, ag = $('fAgent').value;\n    var rows = DEALS.filter(function (d) {\n      if (side && d.side !== side) return false;\n      if (st && d.status !== st) return false;\n      if (ag && d.agent_email !== ag) return false;\n      if (q && [d.address, d.city, d.client_name, d.deal_id, d.agent_name].join(' ').toLowerCase().indexOf(q) < 0) return false;\n      return true;\n    });\n    var c = { active: 0, pending: 0, sold: 0 };\n    DEALS.forEach(function (d) {\n      if (d.status === 'Active' || d.status === 'Coming Soon') c.active++;\n      else if (['Accepted Offer', 'Under Contract', 'Closing Set'].indexOf(d.status) >= 0) c.pending++;\n      else if (d.status === 'Sold') c.sold++;\n    });\n    $('stats').innerHTML = [['Total', DEALS.length], ['Active / coming soon', c.active], ['Accepted / in contract', c.pending], ['Sold / leased', c.sold]]\n      .map(function (s) { return '<div class=\"stat\"><b>' + s[1] + '</b><span>' + s[0] + '</span></div>'; }).join('');\n\n    if (!rows.length) {\n      $('deals').innerHTML = '<div class=\"empty card\">' + (DEALS.length ? 'No deals match those filters.' : 'No deals yet. Tap <b>+ New deal</b> to add your first one.') + '</div>';\n      return;\n    }\n    $('deals').innerHTML = rows.map(function (d) {\n      var done = parseInt(String(d.milestones_done || '0'), 10) || 0, total = d.milestones_total || 1;\n      return '<div class=\"card deal\" data-id=\"' + esc(d.deal_id) + '\" tabindex=\"0\">' +\n        '<div><span class=\"badge b-' + esc(d.side) + '\">' + esc(d.side) + '</span> <span class=\"addr\">' + esc(d.address) + '</span>' +\n        '<div class=\"meta\">' + esc(d.client_name) + (d.city ? ' \u00b7 ' + esc(d.city) : '') + (USER.isAdmin ? ' \u00b7 ' + esc(d.agent_name || d.agent_email) : '') + ' \u00b7 ' + esc(d.deal_id) + '</div></div>' +\n        '<div style=\"text-align:right\"><span class=\"status s-' + esc(String(d.status).split(' ')[0]) + '\">' + esc(d.status) + '</span><div style=\"margin-top:6px\">' + skyChip(d.skyslope_status) + '</div></div>' +\n        '<div class=\"meta\" style=\"grid-column:1/-1\">Next: <b style=\"color:#374151\">' + esc(d.next_milestone || '') + '</b>' +\n        (d.current_milestone_date ? ' \u00b7 Last update ' + esc(d.current_milestone_date) : '') + (d.closing_date ? ' \u00b7 Closing ' + esc(d.closing_date) : '') + '</div>' +\n        '<div class=\"bar\"><i style=\"width:' + Math.round(done / total * 100) + '%\"></i></div></div>';\n    }).join('');\n  }\n\n  $('deals').addEventListener('click', function (ev) { var el = ev.target.closest('.deal'); if (el) openDeal(el.getAttribute('data-id')); });\n  $('deals').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { var el = ev.target.closest('.deal'); if (el) openDeal(el.getAttribute('data-id')); } });\n\n  document.addEventListener('click', function (ev) {\n    var go = ev.target.closest('[data-go]');\n    if (go) { ev.preventDefault(); show(go.getAttribute('data-go')); if (go.getAttribute('data-go') === 'list') renderList(); }\n  });\n  $('newDealBtn').addEventListener('click', function () { show('picker'); });\n  Array.prototype.forEach.call(document.querySelectorAll('.side-tile'), function (b) {\n    b.addEventListener('click', function () { openEditor({ side: b.getAttribute('data-side'), status: 'Active', milestones: {}, office: USER.office }); });\n  });\n\n  // ---------- editor ----------\n  function openDeal(id) {\n    toast('Opening deal\u2026');\n    call('getDeal', TOKEN, id).then(openEditor).catch(function (e) { toast(e.message, true); });\n  }\n\n  function labelFor(f, side) { return (f.labels && f.labels[side]) || f.label; }\n  function optionsFor(f, side) { return f.optionsBySide ? (f.optionsBySide[side] || []) : (f.options || []); }\n  function isReq(f, side) { return f.req === true || (Array.isArray(f.req) && f.req.indexOf(side) >= 0); }\n  function skyChip(st) {\n    if (!st) return '';\n    var cls = /created|complete/i.test(st) ? 'ok' : /error|review/i.test(st) ? 'err' : 'wait';\n    return '<span class=\"sky ' + cls + '\">SkySlope: ' + esc(st) + '</span>';\n  }\n  function addrOf(d) { return [d.street_number, d.direction, d.street_name].filter(Boolean).join(' ') + (d.unit ? ' #' + d.unit : ''); }\n\n  function openEditor(deal) {\n    CURRENT = deal;\n    var side = deal.side;\n    $('edSide').textContent = side; $('edSide').className = 'badge b-' + side;\n    $('edTitle').textContent = deal.deal_id ? (addrOf(deal) || 'Deal') : 'New ' + side.toLowerCase() + ' deal';\n    $('edStatus').value = deal.status || 'Active';\n    $('edMeta').innerHTML = deal.deal_id\n      ? esc(deal.deal_id + ' \u00b7 ' + (deal.agent_name || deal.agent_email) + ' \u00b7 last updated ' + (deal.updated_at || '').replace('T', ' ')) + ' &nbsp;' + skyChip(deal.skyslope_status) +\n        (deal.skyslope_file ? ' <a href=\"' + esc(deal.skyslope_file) + '\" target=\"_blank\" rel=\"noopener\">Open in SkySlope</a>' : '')\n      : 'Only the address and office are required. Fill in whatever you have now and add the rest as the deal moves along.';\n    $('saveBtn').textContent = deal.deal_id ? 'Save changes' : 'Submit deal';\n\n    // Details\n    var sections = [];\n    CFG.fields.forEach(function (f) {\n      if (f.sides.indexOf(side) < 0) return;\n      var sec = sections.filter(function (s) { return s.name === f.section; })[0];\n      if (!sec) { sec = { name: f.section, fields: [] }; sections.push(sec); }\n      sec.fields.push(f);\n    });\n    $('detailsPane').innerHTML = sections.map(function (s) {\n      return '<fieldset><legend>' + esc(s.name) + '</legend><div class=\"grid\">' + s.fields.map(function (f) { return fieldHtml(f, side, deal[f.key], !deal.deal_id); }).join('') + '</div></fieldset>';\n    }).join('');\n\n    // Milestones\n    var list = CFG.milestones[side] || [];\n    var ms = deal.milestones || {};\n    $('msList').innerHTML = list.map(function (m) {\n      var s = ms[m.key] || {};\n      return '<div class=\"ms' + (s.done ? ' done' : '') + '\" data-ms=\"' + m.key + '\">' +\n        '<input type=\"checkbox\" id=\"ms_' + m.key + '\"' + (s.done ? ' checked' : '') + '>' +\n        '<label for=\"ms_' + m.key + '\" class=\"ml\" style=\"margin:0\">' + esc(m.label) + '</label>' +\n        '<input type=\"date\" aria-label=\"' + esc(m.label) + ' date\" value=\"' + esc(s.date || '') + '\">' +\n        '<input class=\"note\" placeholder=\"Note (optional)\" value=\"' + esc(s.note || '') + '\"></div>';\n    }).join('');\n    updateMsProgress();\n\n    // Docs\n    $('docsLocked').classList.toggle('hidden', !!deal.deal_id);\n    $('docsArea').classList.toggle('hidden', !deal.deal_id);\n    renderDocs(deal.documents || []);\n\n    setTab('details');\n    show('editor');\n  }\n\n  function fieldHtml(f, side, val, isNew) {\n    var id = 'f_' + f.key, v = val == null ? '' : val, required = isReq(f, side), req = required ? ' required' : '';\n    if (isNew && v === '') v = f.default || (f.optionsBySide ? '' : '');\n    var wide = f.type === 'textarea' || f.key === 'checklist_type' || f.key === 'represent_both' ? ' wide' : '';\n    var lab = '<label for=\"' + id + '\" class=\"' + (required ? 'req' : '') + '\">' + esc(labelFor(f, side)) + '</label>';\n    var help = f.help ? '<span class=\"help\">' + esc(f.help) + '</span>' : '';\n    var input;\n    if (f.type === 'select') {\n      var opts = optionsFor(f, side);\n      input = '<select id=\"' + id + '\" name=\"' + f.key + '\"' + req + '><option value=\"\">\u2014</option>' +\n        opts.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';\n    } else if (f.type === 'roster') {\n      input = '<input id=\"' + id + '\" name=\"' + f.key + '\" list=\"rosterList\" autocomplete=\"off\" placeholder=\"Start typing a name\" value=\"' + esc(v) + '\">';\n    } else if (f.type === 'textarea') {\n      input = '<textarea id=\"' + id + '\" name=\"' + f.key + '\"' + req + '>' + esc(v) + '</textarea>';\n    } else {\n      var type = { money: 'text', number: 'text', date: 'date', email: 'email', tel: 'tel' }[f.type] || 'text';\n      var mode = f.type === 'money' || f.type === 'number' ? ' inputmode=\"decimal\"' : '';\n      var ph = f.type === 'money' ? ' placeholder=\"$\"' : '';\n      input = '<input id=\"' + id + '\" name=\"' + f.key + '\" type=\"' + type + '\"' + mode + ph + req + ' value=\"' + esc(v) + '\">';\n    }\n    return '<div class=\"' + wide.trim() + '\">' + lab + input + help + '</div>';\n  }\n\n  $('msList').addEventListener('change', function (ev) {\n    var row = ev.target.closest('.ms'); if (!row) return;\n    var cb = row.querySelector('input[type=checkbox]'), date = row.querySelector('input[type=date]');\n    if (ev.target === cb && cb.checked && !date.value) date.value = todayStr();\n    if (ev.target === date && date.value && !cb.checked) cb.checked = true;\n    row.classList.toggle('done', cb.checked);\n    updateMsProgress();\n  });\n\n  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }\n\n  function updateMsProgress() {\n    var rows = document.querySelectorAll('#msList .ms'), done = document.querySelectorAll('#msList .ms.done').length;\n    $('msBar').style.width = rows.length ? Math.round(done / rows.length * 100) + '%' : '0';\n    $('msCount').textContent = '(' + done + '/' + rows.length + ')';\n  }\n\n  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {\n    t.addEventListener('click', function () { setTab(t.getAttribute('data-tab')); });\n  });\n  function setTab(name) {\n    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.classList.toggle('on', t.getAttribute('data-tab') === name); });\n    Array.prototype.forEach.call(document.querySelectorAll('[data-pane]'), function (p) { p.classList.toggle('hidden', p.getAttribute('data-pane') !== name); });\n  }\n\n  $('dealForm').addEventListener('submit', function (ev) {\n    ev.preventDefault();\n    var side = CURRENT.side, fields = {}, missing = [];\n    CFG.fields.forEach(function (f) {\n      if (f.sides.indexOf(side) < 0) return;\n      var el = $('f_' + f.key); var v = el ? el.value.trim() : '';\n      fields[f.key] = v;\n      if (el) el.style.borderColor = '';\n      if (isReq(f, side) && !v) { missing.push(labelFor(f, side)); if (el) el.style.borderColor = 'var(--bad)'; }\n    });\n    if (missing.length) { setTab('details'); toast('Please fill in: ' + missing.join(', '), true); return; }\n\n    var milestones = {};\n    Array.prototype.forEach.call(document.querySelectorAll('#msList .ms'), function (row) {\n      milestones[row.getAttribute('data-ms')] = {\n        done: row.querySelector('input[type=checkbox]').checked,\n        date: row.querySelector('input[type=date]').value,\n        note: row.querySelector('.note').value\n      };\n    });\n\n    var btn = $('saveBtn'); busy(btn, true, 'Saving\u2026');\n    call('saveDeal', TOKEN, { deal_id: CURRENT.deal_id || '', side: side, status: $('edStatus').value, fields: fields, milestones: milestones })\n      .then(function (res) {\n        var msg = res.isNew ? 'Deal submitted (' + res.deal_id + '). Queued for SkySlope.' : 'Changes saved.';\n        if (res.status && res.status !== $('edStatus').value) msg += ' Status moved to ' + res.status + '.';\n        if (res.inventory && !res.inventory.ok) toast(msg + ' Office inventory note: ' + res.inventory.message, true); else toast(msg);\n        return call('getDeal', TOKEN, res.deal_id).then(function (d) {\n          var tab = document.querySelector('.tab.on').getAttribute('data-tab');\n          openEditor(d); setTab(tab); refreshListQuiet();\n        });\n      })\n      .catch(function (e) { toast(e.message, true); })\n      .then(function () { busy(btn, false); });\n  });\n\n  function refreshListQuiet() { call('listDeals', TOKEN).then(function (d) { DEALS = d || []; }).catch(function () {}); }\n\n  // ---------- documents ----------\n  function renderDocs(docs) {\n    $('docList').innerHTML = docs.length ? docs.map(function (d) {\n      return '<div class=\"doc\"><div><a href=\"' + esc(d.url) + '\" target=\"_blank\" rel=\"noopener\">' + esc(d.name) + '</a><div class=\"muted\" style=\"font-size:12px\">' + esc(d.category) + '</div></div>' +\n        '<div class=\"muted\" style=\"font-size:12px;white-space:nowrap\">' + esc((d.uploaded || '').slice(0, 10)) + '</div></div>';\n    }).join('') : '<p class=\"muted\">No documents uploaded yet.</p>';\n  }\n\n  $('uploadBtn').addEventListener('click', function () {\n    var files = Array.prototype.slice.call($('docFile').files || []);\n    if (!files.length) { toast('Choose a file first.', true); return; }\n    var big = files.filter(function (f) { return f.size > CFG.maxUploadBytes; });\n    if (big.length) { toast(big[0].name + ' is over 20 MB.', true); return; }\n    var btn = $('uploadBtn'); busy(btn, true, 'Uploading\u2026');\n    var cat = $('docCat').value;\n    files.reduce(function (p, file) {\n      return p.then(function () {\n        return readB64(file).then(function (data) {\n          return call('uploadDocument', TOKEN, CURRENT.deal_id, { name: file.name, mimeType: file.type, data: data, category: cat });\n        }).then(renderDocs);\n      });\n    }, Promise.resolve())\n      .then(function () { $('docFile').value = ''; toast(files.length + ' file' + (files.length > 1 ? 's' : '') + ' uploaded.'); })\n      .catch(function (e) { toast(e.message, true); })\n      .then(function () { busy(btn, false); });\n  });\n\n  function readB64(file) {\n    return new Promise(function (resolve, reject) {\n      var r = new FileReader();\n      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };\n      r.onerror = function () { reject(new Error('Could not read ' + file.name)); };\n      r.readAsDataURL(file);\n    });\n  }\n})();\n</script>\n</body>\n</html>\n";
