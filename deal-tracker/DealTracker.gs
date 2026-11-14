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
 *   4. Documents an agent uploads are emailed straight into the deal's SkySlope
 *      file (each SkySlope file has its own @skyslope.com upload address, which
 *      the SkySlope task writes to "SkySlope Upload Email"). Nothing is stored
 *      in Google Drive. Until the SkySlope file exists, an upload waits as a
 *      Gmail draft and is sent by processDocumentQueue (runs every 5 minutes).
 *
 * Setup: README.md. Run `setup()` once from the Apps Script editor.
 */

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

var APP_NAME = 'Agent Deal Tracker';

/** Mac's "Office Sheets" spreadsheet (inventory tabs). Override with Script Property INVENTORY_SPREADSHEET_ID. */
var DEFAULT_INVENTORY_ID = '1-Bob1r8pXD3AkgtDJXs9-IiSWHWIwTGgS5zULBgQmXI';

var SHEETS = { DEALS: 'Deals', AGENTS: 'Agents', MILESTONE_LOG: 'Milestone Log', SYNC_LOG: 'Sync Log', DOCS: 'Documents' };
var DOC_HEADERS = ['Timestamp', 'Deal ID', 'Agent Email', 'Document Type', 'File Name', 'Size KB', 'Status', 'Draft ID', 'Sent To', 'Sent At', 'Note'];
var DOC_WAITING = 'Waiting for SkySlope file', DOC_SENT = 'Sent to SkySlope';
var SKYSLOPE_EMAIL_RE = /^[A-Za-z0-9._%+\-]+@skyslope\.com$/i;

var SIDES = ['Seller', 'Buyer', 'Tenant', 'Landlord'];
var OFFICES = ['Dix Hills', 'Farmingdale'];

/** Same status words as the Office Sheets inventory tabs. */
var STATUSES = ['Coming Soon', 'Active', 'Accepted Offer', 'Under Contract', 'Closing Set', 'Sold', 'TOM', 'Withdrawn', 'Cancelled'];
/** Off the market: no stage requirements, and milestones don't move the status forward. */
var OFF_MARKET = ['TOM', 'Withdrawn', 'Cancelled'];
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
  { key: 'mls_number', col: 'MLS #', label: 'MLS #', type: 'text', sides: ALL, section: 'Property', sky: 'MLS#',
    helpBySide: { Buyer: 'No property yet? Leave this section blank and add it when you have an accepted offer.', Tenant: 'No property yet? Leave this section blank and add it once there\'s an approved application.' } },
  { key: 'street_number', col: 'Street No.', label: 'Street number', type: 'text', sides: ALL, section: 'Property', req: LISTING_SIDES, sky: 'STREET NO.' },
  { key: 'direction', col: 'Direction', label: 'Direction', type: 'select', options: SKY_DIRECTIONS, sides: ALL, section: 'Property', sky: 'DIRECTION' },
  { key: 'street_name', col: 'Street Name', label: 'Street name (e.g. Oak Lane)', type: 'text', sides: ALL, section: 'Property', req: LISTING_SIDES, sky: 'STREET NAME' },
  { key: 'unit', col: 'Unit', label: 'Unit #', type: 'text', sides: ALL, section: 'Property', sky: 'UNIT #' },
  { key: 'city', col: 'City / Town', label: 'City / town', type: 'text', sides: ALL, section: 'Property', sky: 'CITY' },
  { key: 'state', col: 'State', label: 'State', type: 'select', options: US_STATES, default: 'New York', sides: ALL, section: 'Property', sky: 'STATE' },
  { key: 'zip', col: 'Zip', label: 'Zip code', type: 'text', sides: ALL, section: 'Property', sky: 'ZIP CODE' },
  { key: 'county', col: 'County', label: 'County', type: 'text', sides: ALL, section: 'Property', sky: 'COUNTY' },
  { key: 'year_built', col: 'Year Built', label: 'Year built', type: 'number', sides: ALL, section: 'Property', sky: 'YEAR BUILT' },

  // ---- Our client
  { key: 'client_is_entity', col: 'Client Is Entity', label: 'Client is a company, trust or estate?', type: 'select', options: ['No', 'Yes'], default: 'No', sides: ALL, section: 'Your client', sky: 'Trust/company/entity checkbox' },
  { key: 'client_company', col: 'Client Company / Trust', label: 'Company / trust / estate name', type: 'text', sides: ALL, section: 'Your client', sky: 'COMPANY NAME' },
  { key: 'client_first', col: 'Client First Name', label: 'Client first name', type: 'text', sides: ALL, section: 'Your client', req: true, sky: 'FIRST NAME',
    labels: { Seller: 'Seller first name', Buyer: 'Buyer first name', Tenant: 'Tenant first name', Landlord: 'Landlord first name' } },
  { key: 'client_last', col: 'Client Last Name', label: 'Client last name', type: 'text', sides: ALL, section: 'Your client', req: true, sky: 'LAST NAME',
    labels: { Seller: 'Seller last name', Buyer: 'Buyer last name', Tenant: 'Tenant last name', Landlord: 'Landlord last name' } },
  { key: 'client_email', col: 'Client Email', label: 'Client email (forms are sent here to sign)', type: 'email', sides: ALL, section: 'Your client', req: true, sky: 'E-MAIL' },
  { key: 'client_phone', col: 'Client Phone', label: 'Client phone', type: 'tel', sides: ALL, section: 'Your client', req: true, sky: 'PHONE' },
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
  { key: 'contract_date', col: 'Contract Signed Date', label: 'Contract fully signed date', type: 'date', sides: ALL, section: 'Price & dates', sky: 'Inventory "UC Date"',
    labels: { Tenant: 'Lease fully signed date', Landlord: 'Lease fully signed date' } },
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
  { key: 'other_unrepresented', col: 'Other Side Unrepresented', label: 'Other side has no agent (unrepresented)?', type: 'select', options: ['No', 'Yes'], default: 'No', sides: ALL, section: 'Other side' },
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

/**
 * Fields that become mandatory once a deal reaches a stage (by status, or by
 * checking the milestone that moves it there). Each rule is met when ANY of its
 * `anyOf` groups has ALL of its fields filled. A field written "key=Value"
 * must equal that value. "commission" means the commission for our side
 * (listing side for Seller/Landlord, buyer side for Buyer/Tenant, both if dual).
 */
var STAGE_RULES = {
  'Accepted Offer': [
    { label: 'Accepted price', anyOf: [['price']] },
    { label: 'Commission', commission: true },
    { label: 'Property address (street number + street name) or MLS #', anyOf: [['street_number', 'street_name'], ['mls_number']] }
  ],
  'Under Contract': [
    { label: 'Contract fully signed date', anyOf: [['contract_date']] },
    { label: 'Closing date', anyOf: [['closing_date']] },
    { label: 'Other party name', anyOf: [['other_first'], ['other_last']] },
    { label: 'Other side\'s agent + brokerage (or mark the other side unrepresented)', anyOf: [['other_agent_last', 'other_brokerage'], ['other_unrepresented=Yes']] },
    { label: 'Commission', commission: true }
  ]
};

var SYSTEM_COLUMNS_START = ['Deal ID', 'Created At', 'Updated At', 'Agent Name', 'Agent Email', 'SkySlope File Owner',
  'Side', 'Represents', 'SkySlope Type', 'Status', 'Current Milestone', 'Current Milestone Date', 'Next Milestone', 'Milestones Done',
  'SkySlope Status', 'SkySlope File', 'SkySlope Upload Email', 'SkySlope Notes'];
var SYSTEM_COLUMNS_END = ['Milestone Summary', 'Inventory Tab', 'Inventory Result', 'Milestones JSON', 'SkySlope Payload JSON'];

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
    appName: APP_NAME, sides: SIDES, statuses: STATUSES, offices: OFFICES, statusRank: STATUS_RANK, stageRules: STAGE_RULES,
    fields: FIELDS, milestones: MILESTONES, roster: readSkySlopeRoster_(), maxUploadBytes: MAX_UPLOAD_BYTES,
    matrix: matrixConfig_(), changes: changesConfig_()
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
  ensureSheet_(ss, SHEETS.DOCS, DOC_HEADERS);
  ensureSheet_(ss, MATRIX_SHEET, MATRIX_HEADERS);
  ensureSheet_(ss, CHANGES_SHEET, CHANGE_HEADERS);
  installDocumentTrigger_();
  agents.getRange('B:C').setNumberFormat('@');
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('INVENTORY_SPREADSHEET_ID') === null) props.setProperty('INVENTORY_SPREADSHEET_ID', DEFAULT_INVENTORY_ID);
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
    .addItem('Send waiting documents to SkySlope now', 'processDocumentQueue')
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

/** Admin only: every active agent, for the "Agent on this deal" picker. */
function listAgentsForAdmin(token) {
  var user = requireSession_(token);
  if (!user.isAdmin) throw new Error('Admins only.');
  var rows = getSpreadsheet_().getSheetByName(SHEETS.AGENTS).getDataRange().getValues();
  var h = indexHeaders_(rows[0]);
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i], name = String(r[h['Name']] || '').trim();
    if (!name || String(r[h['Active']] || '').toLowerCase() === 'no') continue;
    out.push({ name: name, email: String(r[h['Email']] || '').trim().toLowerCase(), office: String(r[h['Office']] || '').trim(),
      isAdmin: String(r[h['Role']] || '').toLowerCase() === 'admin' });
  }
  return out.sort(function (a, b) { return a.isAdmin - b.isAdmin || a.name.localeCompare(b.name); });
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
  var mx = matrixStatuses_();
  var chg = openChanges_();
  return readDeals_().deals
    .filter(function (d) { return user.isAdmin || d.agent_email === user.email; })
    .map(function (d) {
      return {
        deal_id: d.deal_id, side: d.side, represents: d.represents, status: d.status,
        agent_name: d.agent_name, agent_email: d.agent_email, office: d.office,
        address: shortAddress_(d) || ('No property yet · ' + ([d.client_first, d.client_last].filter(String).join(' ') || 'client')), client_name: [d.client_first, d.client_last].filter(String).join(' ') || d.client_company,
        current_milestone_date: d.current_milestone_date, next_milestone: d.next_milestone,
        milestones_done: d.milestones_done, milestones_total: (MILESTONES[d.side] || []).length,
        closing_date: d.closing_date || '', updated_at: d.updated_at,
        skyslope_status: d.skyslope_status, skyslope_file: d.skyslope_file, matrix_status: mx[d.deal_id] || '', open_change: chg[d.deal_id] || ''
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
      skyslope_owner: user.skyslopeName || user.name, skyslope_status: 'Queued'
    };
    if (existing && before.side !== input.side && before.skyslope_status && before.skyslope_status !== 'Queued') {
      throw new Error('This deal is already in SkySlope as a ' + before.side + ' file. Ask Mac to change the side.');
    }
    deal.side = input.side;
    deal.updated_at = now;

    // Admins can enter or reassign a deal on behalf of an agent
    if (user.isAdmin && input.agent_email) {
      var owner = findAgent_(String(input.agent_email).trim().toLowerCase());
      if (!owner || !owner.active) throw new Error('That agent isn\'t active in the Agents tab.');
      if (owner.email !== deal.agent_email) {
        deal.agent_name = owner.name;
        deal.agent_email = owner.email;
        deal.skyslope_owner = owner.skyslopeName || owner.name;
      }
    } else if (user.isAdmin && !existing) {
      throw new Error('Choose the agent on this deal.');
    }

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
      if (c.change === 'completed' && c.status && OFF_MARKET.indexOf(status) < 0 &&
          (STATUS_RANK[c.status] || 0) > (STATUS_RANK[status] || 0)) status = c.status;
    });
    deal.status = status;
    // Fill dates from the milestones if the agent didn't type them
    (MILESTONES[deal.side] || []).forEach(function (m) {
      var st = newMs[m.key];
      if (!st || !st.done || !st.date) return;
      if (m.status === 'Accepted Offer' && !deal.acceptance_date) deal.acceptance_date = st.date;
      if (m.status === 'Under Contract' && !deal.contract_date) deal.contract_date = st.date;
    });
    // MLS # but no street address: take the address from the office inventory
    if (deal.mls_number && !(deal.street_number && deal.street_name)) {
      var found = findMlsOnInventory_(deal.mls_number);
      if (found) ['street_number', 'street_name', 'city'].forEach(function (k) { if (!deal[k] && found[k]) deal[k] = found[k]; });
    }
    var stageMissing = stageMissing_(deal);
    if (stageMissing.length) {
      throw new Error('This deal is at "' + stageMissing.stage + '". Please fill in: ' + stageMissing.join(', '));
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
// STAGE REQUIREMENTS + MLS LOOKUP
// ---------------------------------------------------------------------------

/** Highest stage the deal has reached: its status, or a checked milestone. */
function dealStage_(deal) {
  if (OFF_MARKET.indexOf(deal.status) >= 0) return '';
  var rank = STATUS_RANK[deal.status] || 0;
  (MILESTONES[deal.side] || []).forEach(function (m) {
    if (m.status && (deal.milestones || {})[m.key] && deal.milestones[m.key].done) rank = Math.max(rank, STATUS_RANK[m.status] || 0);
  });
  return rank;
}

/** Labels of the stage requirements this deal is missing (with .stage set). */
function stageMissing_(deal) {
  var rank = dealStage_(deal);
  var missing = [];
  var reached = '';
  Object.keys(STAGE_RULES).forEach(function (stage) {
    if (!rank || rank < STATUS_RANK[stage]) return;
    reached = stage;
    STAGE_RULES[stage].forEach(function (rule) {
      var groups = rule.commission ? commissionGroups_(deal) : rule.anyOf;
      var ok = rule.commission
        ? groups.every(function (alts) { return alts.some(function (k) { return filled_(deal, k); }); })
        : groups.some(function (g) { return g.every(function (k) { return filled_(deal, k); }); });
      if (!ok && missing.indexOf(rule.label) < 0) missing.push(rule.label);
    });
  });
  missing.stage = reached;
  return missing;
}

/** For each side we represent, the fields that count as "commission entered". */
function commissionGroups_(deal) {
  var listing = ['listing_comm_pct', 'listing_comm_amt'], buying = ['sale_comm_pct', 'sale_comm_amt'];
  if (deal.represent_both === 'Yes') return [listing, buying];
  return (deal.side === 'Seller' || deal.side === 'Landlord') ? [listing] : [buying];
}

function filled_(deal, key) {
  var p = key.split('=');
  var v = String(deal[p[0]] == null ? '' : deal[p[0]]).trim();
  return p.length > 1 ? v === p[1] : v !== '';
}

/** Called from the page: find an MLS # on the office inventory tabs. */
function lookupMls(token, mls) {
  requireSession_(token);
  var f = findMlsOnInventory_(mls);
  return f || null;
}

function findMlsOnInventory_(mls) {
  var digits = String(mls || '').replace(/\D/g, '');
  if (!digits) return null;
  var id = PropertiesService.getScriptProperties().getProperty('INVENTORY_SPREADSHEET_ID') || DEFAULT_INVENTORY_ID;
  var ss = SpreadsheetApp.openById(id);
  for (var t = 0; t < OFFICES.length; t++) {
    var sheet = ss.getSheetByName(OFFICES[t] + ' Inventory');
    if (!sheet || sheet.getLastRow() < 2) continue;
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getDisplayValues();
    for (var r = 0; r < rows.length; r++) {
      if (String(rows[r][1]).replace(/\D/g, '') !== digits) continue;
      var addr = String(rows[r][0]).replace(/\([^)]*\)/g, '').trim();
      var parts = addr.split(',');
      var street = parts[0].trim().split(/\s+/);
      return {
        street_number: street[0] || '', street_name: street.slice(1).join(' '),
        city: (parts[1] || '').trim(), list_price: String(rows[r][4]).replace(/[$,\s]/g, ''),
        source: sheet.getName()
      };
    }
  }
  return null;
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
  if (deal.status === 'Cancelled' || deal.status === 'Withdrawn') return { ok: true, message: deal.status + ': inventory left as is for Mac to review.' };
  if (OFFICES.indexOf(deal.office) < 0) return { ok: false, message: 'No office chosen.' };
  if (!deal.mls_number && !(deal.street_number && deal.street_name)) {
    return { ok: true, message: 'No property yet: not on the inventory tabs. It is added once an address or MLS # is entered.' };
  }
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
// DOCUMENTS: straight into the deal's SkySlope file by email. No Google Drive.
// SkySlope gives every listing/transaction file its own @skyslope.com address;
// attachments emailed there land on that file's Documents tab.
// ---------------------------------------------------------------------------

function uploadDocument(token, dealId, file) {
  var user = requireSession_(token);
  var found = findDealRow_(dealId);
  if (!found) throw new Error('Save the deal before uploading documents.');
  var deal = found.deal;
  assertCanAccess_(user, deal);
  if (!file || !file.data) throw new Error('No file received.');
  var bytes = Utilities.base64Decode(file.data);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('File is larger than 20 MB.');
  var name = String(file.name || 'document').replace(/[\r\n]/g, ' ');
  var category = String(file.category || 'Other').replace(/[\r\n]/g, ' ');
  var blob = Utilities.newBlob(bytes, file.mimeType || 'application/octet-stream', name);
  var subject = docSubject_(deal, category, name);
  var body = docBody_(deal, category, name, user);
  var to = skySlopeEmail_(deal);
  var row;
  if (to) {
    GmailApp.sendEmail(to, subject, body, { attachments: [blob], name: APP_NAME });
    row = [isoNow_(), deal.deal_id, user.email, category, name, Math.round(bytes.length / 1024), DOC_SENT, '', to, isoNow_(), ''];
  } else {
    // Held as a Gmail draft (to Mac himself, never sent as is) until SkySlope has a file for this deal.
    var draft = GmailApp.createDraft(Session.getEffectiveUser().getEmail(), subject, body, { attachments: [blob], name: APP_NAME });
    row = [isoNow_(), deal.deal_id, user.email, category, name, Math.round(bytes.length / 1024), DOC_WAITING, draft.getId(), '', '', ''];
  }
  docsSheet_().appendRow(row);
  return listDocuments_(deal);
}

/** Sends every waiting upload whose deal now has a SkySlope upload email. Runs every 5 minutes. */
function processDocumentQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return 'Busy';
  var sent = 0, waiting = 0, errors = 0, applied = 0;
  try {
    // Listing changes Matrix has made (price, status, expiration) are applied to their deals here too.
    try { applied = processListingChanges_(); } catch (e) { Logger.log('Listing changes: ' + e.message); }
    var sheet = docsSheet_();
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return applied ? applied + ' listing change(s) applied to deals.' : 'Nothing waiting.';
    var h = indexHeaders_(data[0]);
    var deals = {};
    readDeals_().deals.forEach(function (d) { deals[d.deal_id] = d; });
    for (var i = 1; i < data.length && sent < 25; i++) {
      if (String(data[i][h['Status']]) !== DOC_WAITING) continue;
      var deal = deals[String(data[i][h['Deal ID']])];
      var to = deal ? skySlopeEmail_(deal) : '';
      if (!to) { waiting++; continue; }
      var r = i + 1;
      try {
        var draft = GmailApp.getDraft(String(data[i][h['Draft ID']]));
        var msg = draft.getMessage();
        GmailApp.sendEmail(to, msg.getSubject(), msg.getPlainBody(), { attachments: msg.getAttachments(), name: APP_NAME });
        draft.deleteDraft();
        sheet.getRange(r, h['Status'] + 1).setValue(DOC_SENT);
        sheet.getRange(r, h['Sent To'] + 1).setValue(to);
        sheet.getRange(r, h['Sent At'] + 1).setValue(isoNow_());
        sent++;
      } catch (e) {
        sheet.getRange(r, h['Status'] + 1).setValue('Error');
        sheet.getRange(r, h['Note'] + 1).setValue(String(e.message || e));
        errors++;
      }
    }
  } finally {
    lock.releaseLock();
  }
  var msgOut = (applied ? applied + ' listing change(s) applied to deals. ' : '') + 'Documents: ' + sent + ' sent to SkySlope, ' + waiting + ' still waiting for a SkySlope file' + (errors ? ', ' + errors + ' errors (see Documents tab)' : '') + '.';
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msgOut, 'Deal Tracker', 10); } catch (e) {}
  return msgOut;
}

function installDocumentTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'processDocumentQueue'; });
  if (!exists) ScriptApp.newTrigger('processDocumentQueue').timeBased().everyMinutes(5).create();
}

function skySlopeEmail_(deal) {
  var e = String(deal.skyslope_email || '').trim();
  return SKYSLOPE_EMAIL_RE.test(e) ? e : '';
}

function docSubject_(deal, category, name) {
  return (shortAddress_(deal) || deal.deal_id) + ' - ' + category + ' - ' + name;
}

function docBody_(deal, category, name, user) {
  return [
    'Document uploaded through the ' + APP_NAME + '.',
    'Deal: ' + deal.deal_id + ' (' + deal.side + ')',
    'Property: ' + ([shortAddress_(deal), deal.city].filter(String).join(', ') || 'not entered yet'),
    'Agent: ' + (user.name || user.email),
    'Document type: ' + category,
    'File: ' + name
  ].join('\n');
}

function docsSheet_() {
  return ensureSheet_(getSpreadsheet_(), SHEETS.DOCS, DOC_HEADERS);
}

function listDocuments_(deal) {
  var sheet = getSpreadsheet_().getSheetByName(SHEETS.DOCS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getDisplayValues();
  var h = indexHeaders_(data[0]);
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][h['Deal ID']] !== deal.deal_id) continue;
    out.push({ name: data[i][h['File Name']], category: data[i][h['Document Type']], uploaded: data[i][h['Timestamp']], status: data[i][h['Status']], sent_at: data[i][h['Sent At']] });
  }
  return out.sort(function (a, b) { return String(b.uploaded).localeCompare(String(a.uploaded)); });
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
  'SkySlope Status': 'skyslope_status', 'SkySlope File': 'skyslope_file', 'SkySlope Upload Email': 'skyslope_email', 'SkySlope Notes': 'skyslope_notes',
  'Milestone Summary': 'milestone_summary', 'Inventory Tab': 'inventory_tab', 'Inventory Result': 'inventory_result',
  'SkySlope Payload JSON': 'skyslope_payload'
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
  ['side', 'status', 'agent_email'].concat(FIELDS.map(function (f) { return f.key; })).forEach(function (k) {
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

// ---------------------------------------------------------------------------
// MLS LISTING (Matrix.gs)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// LISTING CHANGES (ListingChanges.gs)
// ---------------------------------------------------------------------------
/**
 * LISTING CHANGES — price change, temporarily off market, back on market, withdraw, cancel, extend.
 *
 * On a Seller or Landlord deal that is on the MLS, the agent (or Mac) requests a change from the
 * "Listing changes" tab. Each request moves through:
 *
 *   Requested ──SkySlope task──▶ Form Ready ──agent/Mac sends──▶ Out for Signature ──seller signs──▶ Signed
 *      └─▶ Matrix Status = Queued ──Matrix task──▶ Updated in Matrix ──this script──▶ deal updated (Applied)
 *
 *   - The SkySlope task (SKYSLOPE_TASK.md, part D) adds the right OneKey form to the deal's SkySlope
 *     file, fills it from "Change Payload JSON", and prepares the signature request.
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
var OFFICE_MLS_CODES = { 'Dix Hills': '', 'Farmingdale': '' }; // e.g. { 'Dix Hills': 'CBAH01', ... }

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
  setChangeCells_(changeId, { 'SkySlope Status': 'Withdrawn by agent',
    'Notes': (c.notes ? c.notes + ' | ' : '') + 'Withdrawn ' + isoNow_().slice(0, 10) + ' by ' + ctx.user.email +
      (c.signature_link ? '. Void the unsigned envelope in SkySlope.' : '') });
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
  return { label: { 'Requested': 'Preparing form in SkySlope', 'Form Ready': 'Form ready to send for signature',
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

// ---------------------------------------------------------------------------
// MATRIX INPUT SHEETS (MatrixSchemas.gs)
// ---------------------------------------------------------------------------
/**
 * GENERATED by build.py from matrix/*.js. Do not edit here; edit matrix/*.js and run build.py.
 * OneKey MLS Matrix input sheets, one schema per property type.
 */
// The schema files were written for the browser; on the server they attach to this object instead.
var window = (typeof window !== 'undefined') ? window : {};

// ---- matrix/residential.js
/*
 * OneKey MLS — Residential
 * Source: "Residential Matrix Listing Profile Sheet", Last Updated 03/27/2026
 * Sections, field labels, option lists and required flags are copied from that sheet,
 * in the same order, so the entry sheet can be keyed into Matrix top to bottom.
 *
 * Field types: text, number, money, date, phone, url, textarea,
 *              radio (pick one), checks (pick any), yesno, rooms (repeater)
 * `req: true`   = red/asterisk field on the OneKey sheet
 * `showIf`      = only shown when another field has a given value
 */
window.SCHEMAS = window.SCHEMAS || {};

const YN = ["Yes", "No"];

window.SCHEMAS.residential = {
  id: "residential",
  name: "Residential",
  sourceDoc: "OneKey MLS Residential Matrix Listing Profile Sheet — Last Updated 03/27/2026",
  sections: [
    {
      title: "Status Information",
      fields: [
        { id: "status", label: "Status Information", type: "radio", req: true, options: ["Coming Soon", "Active"] },
        { id: "onMarketDate", label: "On Market Date", type: "date", req: true,
          help: "The date entered into this field is when the listing should transition to Active status." },
      ],
    },
    {
      title: "Agent & Office Information",
      fields: [
        { id: "listAgentId", label: "List Agent ID", type: "text", req: true },
        { id: "coListAgentId", label: "Co List Agent ID", type: "text" },
        { id: "listAgentName", label: "List Agent Name", type: "text" },
        { id: "coListAgentName", label: "Co List Agent Name", type: "text" },
        { id: "listOfficeName", label: "List Office Name", type: "text" },
        { id: "coListOfficeName", label: "Co List Office Name", type: "text" },
        { id: "listAgentPhone", label: "List Agent Direct Phone", type: "phone" },
        { id: "coListAgentPhone", label: "Co List Agent Direct Phone", type: "phone" },
        { id: "listOfficePhone", label: "List Office Phone", type: "phone" },
        { id: "coListOfficePhone", label: "Co List Office Phone", type: "phone" },
        { id: "negotiateThrough", label: "Negotiate Through", type: "text", req: true, wide: true },
      ],
    },
    {
      title: "Distribution",
      fields: [
        { id: "listingExposure", label: "Listing Exposure", type: "radio", req: true,
          options: ["MLS Only", "Private", "Publish to Internet"] },
        { id: "showAddress", label: "Show Address", type: "yesno", req: true },
        { id: "showAvmVow", label: "Show AVM on VOW", type: "yesno", req: true },
        { id: "showCommentsVow", label: "Show Comments VOW", type: "yesno", req: true },
        { id: "syndicateTo", label: "Syndicate To", type: "checks", options: ["Realtor.com", "OneKeyMLS.com"] },
      ],
    },
    {
      title: "Location Information",
      fields: [
        { id: "streetNumber", label: "Street #", type: "text", req: true },
        { id: "dirPrefix", label: "Dir Prefix", type: "text" },
        { id: "streetName", label: "Street Name", type: "text", req: true,
          help: "Name only — do NOT include Ave, Rd, St (that goes in Street Suffix)." },
        { id: "streetSuffix", label: "Street Suffix - Ave, Rd, St, etc", type: "text" },
        { id: "dirSuffix", label: "Dir Suffix", type: "text" },
        { id: "unitNumber", label: "Unit Number", type: "text" },
        { id: "zip", label: "Zip Code", type: "text", req: true, pattern: "^\\d{5}$", patternMsg: "5-digit zip" },
        { id: "zip4", label: "Zip + 4", type: "text" },
        { id: "county", label: "County", type: "text", req: true },
        { id: "cityTownship", label: "City/Township", type: "text", req: true },
        { id: "postOfficeTown", label: "Post Office/Town", type: "text", req: true },
        { id: "manhattanSection", label: "Manhattan Section", type: "text" },
        { id: "neighborhood", label: "Neighborhood", type: "text" },
        { id: "village", label: "Village", type: "text" },
        { id: "hamlet", label: "Hamlet", type: "text" },
        { id: "subdivision", label: "Subdivision/Development", type: "text" },
        { id: "state", label: "State", type: "text", req: true, default: "NY" },
        { id: "country", label: "Country", type: "text" },
        { id: "crossStreet", label: "Cross Street", type: "text" },
        { id: "directions", label: "Directions", type: "text" },
        { id: "elemDistrict", label: "Elementary School District", type: "text", req: true },
        { id: "elemSchool", label: "Elementary School", type: "text", req: true },
        { id: "middleDistrict", label: "Middle School District", type: "text", req: true },
        { id: "middleSchool", label: "Middle School", type: "text", req: true },
        { id: "highDistrict", label: "High School District", type: "text", req: true },
        { id: "highSchool", label: "High School", type: "text", req: true },
      ],
    },
    {
      title: "Listing/Contract",
      fields: [
        { id: "listingAgreement", label: "Listing Agreement", type: "radio", req: true,
          options: ["Exclusive Agency", "Exclusive Right to Sell"] },
        { id: "listPrice", label: "List Price", type: "money", req: true },
        { id: "listingContractDate", label: "Listing Contract Date", type: "date", req: true },
        { id: "expirationDate", label: "Expiration Date", type: "date", req: true },
        { id: "sellerConcession", label: "Seller to Consider Concession", type: "yesno" },
        { id: "concessionAmount", label: "Concession Amount Considered", type: "text",
          showIf: { field: "sellerConcession", equals: "Yes" } },
        { id: "ownersName", label: "Owner's Name", type: "text", req: true },
        { id: "leaseConsidered", label: "Lease Considered", type: "yesno", req: true },
        { id: "specialListingConditions", label: "Special Listing Conditions", type: "checks", req: true,
          options: ["None", "Auction", "Auction Terms of Sale", "Bankruptcy Property", "Contract Vendee",
            "HUD Owned", "In Foreclosure", "Notice of Default", "Probate Listing", "Real Estate Owned",
            "Short Sale", "Third Party Approval"] },
        { id: "listingTerms", label: "Listing Terms", type: "checks",
          options: ["1031 Exchange", "Assumable", "Cash", "Contract", "Conventional", "FHA", "Lease Option",
            "Lease Purchase", "Other", "Owner Will Take Back 1st", "Owner Will Take Back 2nd",
            "Private Financing Available", "Seller Financing", "Trade", "VA"] },
        { id: "disclosures", label: "Disclosures", type: "checks",
          options: ["Elevation Certificate", "Environmental Disclosure Available", "HOA/Condo Disclosure Available",
            "Lead Paint", "M2 Agent Exclusions", "M6 Disclosure of Ownership Interest", "None", "Other",
            "Seller Property Disclosure"] },
        { id: "additionalFees", label: "Additional Fees", type: "yesno" },
        { id: "additionalFeeAmount", label: "Additional Fee Amount", type: "money",
          showIf: { field: "additionalFees", equals: "Yes" } },
        { id: "additionalFeeFrequency", label: "Additional Fee Frequency", type: "radio",
          options: ["Annually", "Monthly", "Quarterly", "One Time", "See Remarks"],
          showIf: { field: "additionalFees", equals: "Yes" } },
        { id: "additionalFeeDescription", label: "Additional Fee Description", type: "textarea",
          showIf: { field: "additionalFees", equals: "Yes" } },
        { id: "inclusions", label: "Inclusions", type: "textarea" },
        { id: "exclusions", label: "Exclusions", type: "textarea" },
      ],
    },
    {
      title: "Property/Tax/Legal",
      fields: [
        { id: "propertyTaxId", label: "Property Tax ID", type: "text", wide: true,
          help: "Required for MOST properties." },
        { id: "propertySubType", label: "Property Sub Type", type: "radio", req: true,
          options: ["Houseboat", "Manufactured Home", "Manufactured On Land", "Mobile Home",
            "Mobile Home With Land", "Single Family Residence"] },
        { id: "additionalParcels", label: "Additional Parcels", type: "yesno" },
        { id: "bodyType", label: "Body Type", type: "radio",
          options: ["Double Wide", "Other", "Single Wide", "Triple Wide"],
          showIf: { field: "propertySubType", in: ["Manufactured Home", "Manufactured On Land", "Mobile Home", "Mobile Home With Land"] } },
        { id: "taxBlock", label: "Tax Block", type: "text" },
        { id: "taxLot", label: "Tax Lot", type: "text" },
        { id: "taxSection", label: "Tax Section", type: "text" },
        { id: "district", label: "District", type: "text" },
        { id: "buildersLotNumber", label: "Builders Lot Number", type: "text" },
        { id: "builderModel", label: "Builder Model", type: "text" },
        { id: "propertyAttached", label: "Property Attached", type: "yesno", req: true },
        { id: "seniorHousing", label: "Senior Housing Community", type: "yesno", req: true },
        { id: "yearBuilt", label: "Year Built", type: "number", req: true, min: 1600, max: 2100 },
        { id: "yearBuiltEffective", label: "Year Built Effective", type: "number", min: 1600, max: 2100 },
        { id: "propertyCondition", label: "Property Condition", type: "checks",
          options: ["Actual", "Estimated", "Fixer", "New Construction", "To Be Built", "Under Construction",
            "Updated/Remodeled"] },
        { id: "commonInterest", label: "Common Interest", type: "checks", options: ["Planned Development"] },
        { id: "taxYear", label: "Tax Year", type: "number", req: true, min: 1990, max: 2100 },
        { id: "taxAnnualAmount", label: "Tax Annual Amount", type: "money", req: true },
        { id: "taxAssessment", label: "Tax Assessment", type: "money" },
        { id: "taxSource", label: "Tax Source", type: "radio", req: true, options: ["Municipality", "Other"] },
        { id: "includedInTaxes", label: "Included In Taxes", type: "checks", options: ["Sewer", "Water", "Trash"] },
      ],
    },
    {
      title: "Community/Association",
      fields: [
        { id: "association", label: "Association Y/N", type: "yesno", req: true },
        { id: "associationFee", label: "Association Fee", type: "money",
          showIf: { field: "association", equals: "Yes" } },
        { id: "associationFeeFrequency", label: "Association Fee Frequency", type: "radio",
          options: ["Annually", "Monthly", "Quarterly", "Semi-Annually"],
          showIf: { field: "association", equals: "Yes" } },
        { id: "associationName", label: "Association Name", type: "text",
          showIf: { field: "association", equals: "Yes" } },
        { id: "associationPhone", label: "Association Phone", type: "phone",
          showIf: { field: "association", equals: "Yes" } },
        { id: "associationFeeIncludes", label: "Association Fee Includes", type: "checks",
          showIf: { field: "association", equals: "Yes" },
          options: ["Air Conditioning", "All Utilities", "Cable TV", "Common Area Maintenance", "Electricity",
            "Exterior Maintenance", "Gas", "Grounds Care", "Heat", "Hot Water", "Internet", "Other",
            "Pool Maintenance", "Sewer", "Snow Removal", "Trash", "Water"] },
        { id: "associationAmenities", label: "Association Amenities", type: "checks",
          showIf: { field: "association", equals: "Yes" },
          options: ["Basketball Court", "Boat Dock", "Business Center", "Car Wash Area", "Children's Playroom",
            "Clubhouse", "Concierge", "Dog Park", "Elevator(s)", "Fitness Center", "Gated", "Golf Course",
            "Landscaping", "Maintenance", "Maintenance Grounds", "None", "Other", "Park", "Parking",
            "Playground", "Pool", "Powered Boats Allowed", "Recreation Facilities", "Roof Deck", "Sauna",
            "Security", "Snow Removal", "Spa/Hot Tub", "Tennis Court(s)", "Trash"] },
        { id: "communityFeatures", label: "Community Features", type: "checks",
          options: ["Clubhouse", "Curbs", "Fitness Center", "Gated", "Golf", "Other", "Park", "Playground",
            "Pool", "Powered Boats Allowed", "Sidewalks", "Tennis Court(s)"] },
      ],
    },
    {
      title: "Rooms",
      fields: [
        { id: "bedroomsTotal", label: "Bedrooms Total", type: "number", req: true, min: 0 },
        { id: "bathroomsFull", label: "Bathrooms Full", type: "number", req: true, min: 0 },
        { id: "bathroomsHalf", label: "Bathrooms Half", type: "number", req: true, min: 0 },
        { id: "roomsTotal", label: "Rooms Total", type: "number", req: true, min: 0 },
        { id: "additionalRooms", label: "Additional Rooms", type: "checks",
          options: ["Dining Area", "Home Office", "Library/Den", "Loft", "Media Room"] },
        { id: "rooms", label: "Room Details", type: "repeat", addLabel: "Add room", itemLabel: "Room",
          item: [
            { id: "type", label: "Room Type", type: "select",
              options: ["Auxiliary Room", "Basement", "Bathroom 1", "Bathroom 2", "Bathroom 3", "Bathroom 4",
                "Bathroom 5", "Bedroom 1", "Bedroom 2", "Bedroom 3", "Bedroom 4", "Bedroom 5", "Bonus Room", "Den",
                "Dining Room", "Exercise Room", "Family Room", "Gym", "Kitchen", "Laundry", "Lavatory",
                "Living Room", "Loft", "Media Room", "Office", "Primary Bathroom", "Primary Bedroom", "Sauna"] },
            { id: "level", label: "Room Level", type: "select",
              options: ["Basement", "First", "Lower", "Other", "Second", "Third"] },
            { id: "description", label: "Description", type: "textarea", wide: true },
          ] },
      ],
    },
    {
      title: "Interior",
      fields: [
        { id: "gla", label: "Taxable Living Area (GLA)", type: "number", req: true, min: 0, suffix: "sq ft" },
        { id: "buildingAreaTotal", label: "Building Area Total Sqft", type: "number", min: 0, suffix: "sq ft" },
        { id: "glaSource", label: "Taxable Living Area Source (GLA)", type: "radio", req: true,
          options: ["Appraiser", "CubiCasa", "Measured", "Other", "Plans", "Public Records"] },
        { id: "buildingAreaSource", label: "Building Area Total Sqft Source", type: "radio",
          options: ["Appraiser", "CubiCasa", "Measured", "Other", "Plans", "Public Records"] },
        { id: "levels", label: "Levels in Unit/Home", type: "radio",
          options: ["Bi-Level", "Multi/Split", "One", "One and One Half", "Three Or More", "Tri-Level", "Two"] },
        { id: "attic", label: "Attic", type: "checks", req: true,
          options: ["Crawl", "Dormer", "Finished", "Full", "None", "Partial", "Partially Finished",
            "Pull Stairs", "Scuttle", "See Remarks", "Stairs", "Storage", "Unfinished", "Walkup"] },
        { id: "basement", label: "Basement", type: "yesno", req: true },
        { id: "basementFeatures", label: "Basement Features", type: "checks",
          options: ["Bilco Door(s)", "Crawl Space", "Finished", "Full", "None", "Partial", "Partially Finished",
            "See Remarks", "Storage Space", "Unfinished", "Walk-Out Access"] },
        { id: "interiorFeatures", label: "Interior Features", type: "checks", req: true,
          options: ["1st Floor Bedroom", "1st Floor Full Bath", "Beamed Ceilings", "Bidet", "Breakfast Bar",
            "Built-in Features", "Cathedral Ceiling(s)", "Ceiling Fan(s)", "Central Vacuum", "Chandelier",
            "Chef's Kitchen", "Crown Molding", "Double Vanity", "Dry Bar", "Eat-in Kitchen", "Elevator",
            "ENERGY STAR Qualified Door(s)", "Entertainment Cabinets", "Entrance Foyer", "Formal Dining Room",
            "Galley Kitchen", "Granite Counters", "Heated Floors", "High Ceilings", "High Speed Internet",
            "His and Hers Closets", "In-Law Floorplan", "Kitchen Island", "Low Flow Plumbing Fixtures",
            "Marble Counters", "Natural Woodwork", "Open Floorplan", "Open Kitchen", "Original Details",
            "Other", "Pantry", "Primary Bathroom", "Primary Bedroom Downstairs", "Quartz/Quartzite Counters",
            "Recessed Lighting", "Sauna", "Smart Thermostat", "Soaking Tub", "Sound System", "Speakers",
            "Stone Counters", "Storage", "Tile Counters", "Tray Ceiling(s)", "Walk Through Kitchen",
            "Walk-in Closet(s)", "Washer/Dryer Hookup", "Wet Bar", "Whirlpool Tub",
            "Whole House Entertainment System", "Wired for Sound"] },
        { id: "fireplace", label: "Fireplace?", type: "yesno" },
        { id: "fireplacesTotal", label: "Fireplaces Total", type: "number", min: 0,
          showIf: { field: "fireplace", equals: "Yes" } },
        { id: "fireplaceFeatures", label: "Fireplace Features", type: "checks",
          showIf: { field: "fireplace", equals: "Yes" },
          options: ["Basement", "Bedroom", "Decorative", "Electric", "Family Room", "Free Standing", "Gas",
            "Living Room", "Masonry", "None", "Pellet Stove", "Wood Burning", "Wood Burning Stove"] },
        { id: "kitchens", label: "# of Kitchens", type: "number", min: 0 },
        { id: "appliances", label: "Appliances", type: "checks", req: true,
          options: ["Convection Oven", "Cooktop", "Dishwasher", "Disposal", "Dryer", "Electric Cooktop",
            "Electric Oven", "Electric Range", "Electric Water Heater", "ENERGY STAR Qualified Appliances",
            "Exhaust Fan", "Freezer", "Gas Cooktop", "Gas Oven", "Gas Range", "Humidifier", "Microwave", "None",
            "Other", "Oven", "Range", "Refrigerator", "Stainless Steel Appliance(s)", "Tankless Water Heater",
            "Trash Compactor", "Washer", "Water Heater - Gas Stand Alone", "Water Heater - Geothermal",
            "Water Heater - Indirect Tank", "Water Heater - Oil Stand Alone", "Water Heater - Solar Thermal",
            "Water Heater - Tankless Coil", "Water Purifier Owned", "Water Purifier Rented",
            "Water Softener Owned", "Water Softener Rented", "Wine Refrigerator"] },
        { id: "flooring", label: "Flooring", type: "checks",
          options: ["Brick", "Carpet", "Ceramic Tile", "Combination", "Concrete", "Hardwood", "Laminate",
            "Linoleum", "Other", "Reclaimed Wood", "Tile", "Vinyl", "Wood"] },
        { id: "laundryFeatures", label: "Laundry Features", type: "checks",
          options: ["Electric Dryer Hookup", "Gas Dryer Hookup", "In Basement", "In Bathroom", "In Carport",
            "In Garage", "In Hall", "In Kitchen", "Inside", "Laundry Room", "Multiple Locations", "Other",
            "Outside", "Washer Hookup"] },
        { id: "windowFeatures", label: "Window Features", type: "checks",
          options: ["Aluminum Frames", "Bay Window(s)", "Blinds", "Casement Windows", "Double Pane Windows",
            "Drapes", "ENERGY STAR Qualified Windows", "Floor to Ceiling Windows", "Insulated Windows",
            "New Windows", "Oversized Windows", "Screens", "Shutters", "Skylight(s)", "Storm Window(s)",
            "Tilt Turn Windows", "Tinted Windows", "Triple Pane Windows", "Wall of Windows", "Wood Frames"] },
        { id: "accessibilityFeatures", label: "Accessibility Features", type: "checks",
          options: ["Accessible Approach with Ramp", "Accessible Bedroom", "Accessible Central Living Area",
            "Accessible Closets", "Accessible Common Area", "Accessible Doors", "Accessible Elevator Installed",
            "Accessible Entrance", "Accessible for Hearing-Impairment", "Accessible Full Bath",
            "Accessible Hallway(s)", "Accessible Kitchen", "Accessible Kitchen Appliances", "Accessible Stairway",
            "Adaptable Bathroom Walls", "Adaptable For Elevator", "Customized Wheelchair Accessible",
            "Grip-Accessible Features", "Smart Technology", "Stair Lift", "Therapeutic Whirlpool",
            "Visitor Bathroom", "Walker-Accessible Stairs"] },
      ],
    },
    {
      title: "Exterior",
      fields: [
        { id: "architecturalStyle", label: "Architectural Style", type: "checks", req: true,
          options: ["A-Frame", "Barndominium", "Bungalow", "Cabin", "Cape Cod", "Carriage House", "Chalet",
            "Colonial", "Contemporary", "Cottage", "Craftsman", "Estate", "Exp Cape", "Exp Ranch", "Farmhouse",
            "Foursquare", "Garden", "Hi-Ranch", "Includes Legal Accessory Apartment", "Log", "Mediterranean",
            "Mid-Century Modern", "Mini Estate", "Modern", "Other", "Post Modern", "Raised Ranch", "Ranch",
            "Saltbox", "Splanch", "Split Level", "Split Ranch", "Townhouse", "Traditional", "Tudor",
            "Victorian"] },
        { id: "directionFaces", label: "Direction Faces", type: "radio", options: ["North", "South", "East", "West"] },
        { id: "constructionMaterials", label: "Construction Materials", type: "checks", req: true,
          options: ["Advanced Framing Technique", "Aluminum Siding", "Asbestos", "Batts Insulation", "Block",
            "Blown-In Insulation", "Brick", "Brownstone", "Cedar", "Clapboard", "Energy Star",
            "Fiberglass Insulation", "Fiberglass Siding", "Foam Insulation", "Frame", "HardiPlank Type",
            "ICFs (Insulated Concrete Forms)", "Log", "Log Siding", "Manufactured", "Modular", "Other",
            "Post and Beam", "Recycled/Renewable Materials", "Shake Siding", "Shingle Siding", "Stone",
            "Structurally Insulated Panels", "Stucco", "T111", "Unknown", "Vinyl Siding", "Wood Siding"] },
        { id: "foundationDetails", label: "Foundation Details", type: "checks",
          options: ["Block", "Brick/Mortar", "Concrete Perimeter", "Other", "Raised", "Slab", "Stone"] },
        { id: "garage", label: "Garage?", type: "yesno", req: true },
        { id: "garageSpaces", label: "Garage Spaces", type: "number", min: 0,
          showIf: { field: "garage", equals: "Yes" } },
        { id: "carport", label: "Carport?", type: "yesno", req: true },
        { id: "carportSpaces", label: "Carport Spaces", type: "number", min: 0,
          showIf: { field: "carport", equals: "Yes" } },
        { id: "parkingTotal", label: "Parking Total", type: "number", min: 0 },
        { id: "parkingFeatures", label: "Parking Features", type: "checks", req: true,
          options: ["Alley Access", "Assigned", "Attached", "Carport", "Common", "Covered", "Detached",
            "Driveway", "Electric Vehicle Charging Station(s)", "Garage", "Garage Door Opener", "Heated Garage",
            "None", "Off Site", "Off Street", "On Street", "Other", "Oversized", "Parking Lot", "Private",
            "Public", "Shared Driveway", "Storage", "Tandem", "Unassigned", "Underground", "Unpaved"] },
        { id: "poolPrivate", label: "Pool Private Y/N", type: "yesno", req: true },
        { id: "spa", label: "Spa Y/N", type: "yesno" },
        { id: "poolFeatures", label: "Pool Features", type: "checks",
          options: ["Above Ground", "Community", "Diving Board", "Electric Heat", "Fenced", "In Ground",
            "Indoor", "Infinity", "Other", "Outdoor Pool", "Pool Cover", "Pool/Spa Combo", "Salt Water",
            "Screen Enclosure", "Solar Cover", "Solar Heat", "Tile", "Vinyl"] },
        { id: "lotSizeAcres", label: "Lot Size Acres", type: "number", min: 0, step: "any" },
        { id: "lotSizeSqft", label: "Lot Size Square Feet", type: "number", min: 0 },
        { id: "lotSizeDimensions", label: "Lot Size Dimensions", type: "text" },
        { id: "distanceToTrain", label: "Distance to Train (in miles)", type: "number", min: 0, step: "any" },
        { id: "lotFeatures", label: "Lot Features", type: "checks",
          options: ["Back Yard", "Borders State Land", "City Lot", "Cleared", "Corner Lot", "Corners Marked",
            "Cul-De-Sac", "Fill Needed", "Front Yard", "Garden", "Hilly", "Historic District", "Interior Lot",
            "Irregular Lot", "Landscaped", "Level", "Near Golf Course", "Near Public Transit", "Near School",
            "Near Shops", "On Golf Course", "Other", "Partly Wooded", "Paved", "Private", "Restrictions",
            "Rolling Slope", "Secluded", "See Remarks", "Sloped", "Split Possible", "Sprinklers In Front",
            "Sprinklers In Rear", "Steep Slope", "Stone/Brick Wall", "Subdivided", "Upland", "Views",
            "Waterfront", "Wooded"] },
        { id: "exteriorFeatures", label: "Exterior Features", type: "checks",
          options: ["Awning(s)", "Balcony", "Basketball Court", "Basketball Hoop", "Boat Slip", "Courtyard",
            "Dock", "Dog Run", "Electric Grill", "Fire Pit", "Garden", "Gas Grill", "Juliet Balcony",
            "Lighting", "Mailbox", "Mooring", "None", "Other", "Playground", "Rain Gutters", "Speakers",
            "Storm Doors", "Tennis Court(s)"] },
        { id: "fencing", label: "Fencing", type: "checks",
          options: ["Back Yard", "Barbed Wire", "Brick", "Chain Link", "Cross Fenced", "Electric", "Fenced",
            "Front Yard", "Full", "None", "Other", "Partial", "Perimeter", "Vinyl", "Wood"] },
        { id: "securityFeatures", label: "Security Features", type: "checks",
          options: ["Building Security", "Fire Alarm", "Fire Escape", "Fire Sprinkler System",
            "Gated Community", "Key Card Entry", "Other", "Security Gate", "Security Lights",
            "Security System", "Smoke Detector(s)", "Video Cameras", "Window Bars"] },
        { id: "otherStructures", label: "Other Structures", type: "checks",
          options: ["Arena", "Barn(s)", "Cabana", "Carport(s)", "Corral(s)", "Covered Arena", "Garage(s)",
            "Gazebo", "Greenhouse", "Guest House", "Kennel/Dog Run", "None", "Other", "Outbuilding",
            "Outdoor Kitchen", "Pergola", "Pool House", "Residence", "Shed(s)", "Stable(s)", "Workshop"] },
        { id: "patioPorchFeatures", label: "Patio and Porch Features", type: "checks",
          options: ["Covered", "Deck", "None", "Patio", "Porch", "Screened", "Terrace", "Wrap Around"] },
        { id: "horse", label: "Horse Y/N", type: "yesno" },
        { id: "otherEquipment", label: "Other Equipment", type: "checks",
          options: ["Compressor", "Dehumidifier", "Farm Equipment", "Fuel Tank(s)", "Generator", "Intercom",
            "Irrigation Equipment", "Lawn Maintenance Equipment", "Livestock Equipment", "Negotiable", "None",
            "Other", "Pool Equip/Cover", "Satellite Dish", "TV Antenna"] },
        { id: "waterfront", label: "Waterfront?", type: "yesno", req: true },
        { id: "waterFrontageLength", label: "Water Frontage Length", type: "text",
          showIf: { field: "waterfront", equals: "Yes" } },
        { id: "waterAccess", label: "Water Access", type: "yesno" },
        { id: "waterfrontFeatures", label: "Waterfront Features", type: "checks",
          options: ["Bayfront", "Beach Access", "Beach Front", "Bulkhead", "Canal Access", "Canal Front", "Creek",
            "Lake Front", "Lake Privileges", "Ocean Access", "Ocean Front", "Pond", "River Access",
            "River Front", "Sound", "Stream", "Water Access", "Waterfront"] },
        { id: "view", label: "View", type: "checks",
          options: ["Bridge(s)", "City", "Lake", "Mountain(s)", "Neighborhood", "None", "Open", "Panoramic",
            "Park/Greenbelt", "River", "Skyline", "Trees/Woods", "Water"] },
        { id: "greenVerificationType", label: "Green Building Verification Type", type: "checks",
          options: ["HERS Index Score", "Leed For Homes", "NGBS New Construction", "NGBS Small Projects Remodel",
            "NGBS Whole-Home Remodel"] },
        { id: "greenVerificationYear", label: "Green Verification Year", type: "number", min: 1990, max: 2100 },
        { id: "greenEnergyGeneration", label: "Green Energy Generation", type: "checks", options: ["Solar"] },
        { id: "solarOwnership", label: "Solar Ownership", type: "radio", options: ["Leased", "Owned"],
          showIf: { field: "greenEnergyGeneration", includes: "Solar" } },
        { id: "roadFrontageType", label: "Road Frontage Type", type: "checks",
          options: ["Alley", "County Road", "Easement", "Freeway", "Highway", "Interstate", "Municipal", "None",
            "Other", "Private Road", "See Remarks", "State Road", "Unimproved", "Unknown"] },
        { id: "roadResponsibility", label: "Road Responsibility", type: "checks",
          options: ["Private Maintained Road", "Public Maintained Road", "Road Maintenance Agreement",
            "To be Dedicated"] },
      ],
    },
    {
      title: "Utilities",
      fields: [
        { id: "heating", label: "Heating", type: "checks", req: true,
          options: ["Baseboard", "Coal", "Ducts", "Electric", "ENERGY STAR Qualified Equipment", "Forced Air",
            "Geothermal", "Gravity", "Heat Pump", "Heat Recovery System", "Hot Air", "Hot Water", "Hydro Air",
            "Kerosene", "Natural Gas", "None", "Oil", "Other", "Passive Solar", "Propane", "Radiant",
            "See Remarks", "Solar", "Steam", "Wood"] },
        { id: "heatingZones", label: "# of Heating Zones", type: "number", min: 0 },
        { id: "electricCompany", label: "Electric Company", type: "radio",
          options: ["Central Hudson", "Con-Edison", "NYSEG", "Orange & Rockland", "Other", "PSEG"] },
        { id: "cooling", label: "Cooling", type: "checks", req: true,
          options: ["Air Purification System", "Attic Fan", "Central Air", "Ductless", "Ductwork", "Electric",
            "ENERGY STAR Qualified Equipment", "Geothermal", "Individual", "None", "Wall/Window Unit(s)",
            "Zoned"] },
        { id: "utilities", label: "Utilities", type: "checks", req: true,
          options: ["Cable Available", "Cable Connected", "Electricity Available", "Electricity Connected",
            "Natural Gas Available", "Natural Gas Connected", "None", "Phone Available", "Phone Connected",
            "Propane", "See Remarks", "Sewer Available", "Sewer Connected", "Trash Collection Private",
            "Trash Collection Public", "Underground Utilities", "Water Available", "Water Connected"] },
        { id: "sewer", label: "Sewer", type: "checks", req: true,
          options: ["Cesspool", "None", "Other", "Public Sewer", "Septic Above Ground", "Septic Tank",
            "Shared Septic", "Shared Sewer"] },
        { id: "waterSource", label: "Water Source", type: "checks", req: true,
          options: ["Drilled Well", "Dug Well", "None", "Other", "Private", "Public", "Shared Well", "Spring"] },
      ],
    },
    {
      title: "Remarks",
      fields: [
        { id: "publicRemarks", label: "Public Remarks", type: "textarea", req: true, rows: 7, noComp: true,
          help: "No mention of compensation may be included on the MLS." },
        { id: "agentRemarks", label: "Agent Only Remarks", type: "textarea", rows: 5, noComp: true,
          help: "No mention of compensation may be included on the MLS." },
      ],
    },
    {
      title: "Showing",
      fields: [
        { id: "showingPhone", label: "Showing Contact Phone", type: "phone" },
        { id: "showingPhone2", label: "Showing Contact Phone 2", type: "phone" },
        { id: "showingInstructions", label: "Showing Instructions", type: "textarea" },
        { id: "lockboxSerial", label: "Lockbox Serial Number", type: "text" },
        { id: "lockboxDescription", label: "Lockbox Description", type: "checks", options: ["SentriLock"] },
        { id: "virtualTourBranded", label: "Virtual Tour URL Branded", type: "url" },
        { id: "virtualTourUnbranded", label: "Virtual Tour URL Unbranded", type: "url" },
        { id: "showingRequirements", label: "Showing Requirements", type: "checks", req: true,
          options: ["24 Hour Notice", "Appointment Only", "Call Listing Agent", "Call Listing Office",
            "Call Manager", "Call Owner", "Call Tenant", "Combination Lock Box", "Key In Office", "Lockbox",
            "No Lockbox", "No Sign", "Occupied", "Pet(s) on Premises", "Restricted Hours", "Security System",
            "See Remarks", "Showing Service"] },
      ],
    },
  ],
};

// ---- matrix/derive.js
/*
 * Build a property type's schema as a set of edits to another type's schema.
 * Most OneKey sheets share 80–90% of their fields with Residential, so each type
 * only lists what its sheet does differently. Unknown field ids throw, so a typo
 * in a spec fails loudly instead of silently dropping a change.
 *
 * spec keys (all optional, applied in this order):
 *   removeSections: [title]                   drop whole sections
 *   renameSections: {old: new}
 *   addSections:    [{after: title, section}] insert a new section
 *   moveSectionsToEnd: [title]
 *   remove:   [fieldId]                       drop fields
 *   patch:    {fieldId: {...props}}           change label/req/options/showIf/...
 *   addOpts:  {fieldId: [option]}             add options (list is re-sorted A–Z)
 *   removeOpts: {fieldId: [option]}
 *   insertAfter:  {fieldId: [field]}
 *   insertBefore: {fieldId: [field]}
 *   move: {fieldId: afterFieldId}             reposition an existing field
 */
window.SCHEMAS = window.SCHEMAS || {};

window.deriveSchema = function deriveSchema(baseId, spec) {
  const base = window.SCHEMAS[baseId];
  if (!base) throw new Error(`deriveSchema: unknown base schema "${baseId}"`);
  const s = JSON.parse(JSON.stringify(base));
  Object.assign(s, { id: spec.id, name: spec.name, sourceDoc: spec.sourceDoc });

  const secByTitle = (t) => {
    const sec = s.sections.find((x) => x.title === t);
    if (!sec) throw new Error(`${spec.id}: unknown section "${t}"`);
    return sec;
  };
  const locate = (id) => {
    for (const sec of s.sections) {
      const i = sec.fields.findIndex((f) => f.id === id);
      if (i >= 0) return { sec, i, f: sec.fields[i] };
    }
    throw new Error(`${spec.id}: unknown field "${id}"`);
  };
  const sortOpts = (a) => a.sort((x, y) => x.localeCompare(y, "en", { numeric: true, sensitivity: "base" }));

  (spec.removeSections || []).forEach((t) => { s.sections.splice(s.sections.indexOf(secByTitle(t)), 1); });
  Object.entries(spec.renameSections || {}).forEach(([a, b]) => { secByTitle(a).title = b; });
  (spec.addSections || []).forEach(({ after, section }) => {
    s.sections.splice(s.sections.indexOf(secByTitle(after)) + 1, 0, section);
  });
  (spec.moveSectionsToEnd || []).forEach((t) => {
    const sec = secByTitle(t);
    s.sections.splice(s.sections.indexOf(sec), 1);
    s.sections.push(sec);
  });
  (spec.remove || []).forEach((id) => { const { sec, i } = locate(id); sec.fields.splice(i, 1); });
  Object.entries(spec.patch || {}).forEach(([id, p]) => {
    const { f } = locate(id);
    Object.entries(p).forEach(([k, v]) => { if (v === undefined) delete f[k]; else f[k] = v; });
  });
  Object.entries(spec.addOpts || {}).forEach(([id, opts]) => {
    const { f } = locate(id);
    opts.forEach((o) => { if (!f.options.includes(o)) f.options.push(o); });
    sortOpts(f.options);
  });
  Object.entries(spec.removeOpts || {}).forEach(([id, opts]) => {
    const { f } = locate(id);
    opts.forEach((o) => {
      const i = f.options.indexOf(o);
      if (i < 0) throw new Error(`${spec.id}: option "${o}" not in "${id}"`);
      f.options.splice(i, 1);
    });
  });
  Object.entries(spec.insertAfter || {}).forEach(([id, fields]) => { const { sec, i } = locate(id); sec.fields.splice(i + 1, 0, ...fields); });
  Object.entries(spec.insertBefore || {}).forEach(([id, fields]) => { const { sec, i } = locate(id); sec.fields.splice(i, 0, ...fields); });
  Object.entries(spec.move || {}).forEach(([id, afterId]) => {
    const from = locate(id);
    from.sec.fields.splice(from.i, 1);
    const to = locate(afterId);
    to.sec.fields.splice(to.i + 1, 0, from.f);
  });

  // Every showIf must point at a field that still exists.
  const ids = new Set(s.sections.flatMap((x) => x.fields.map((f) => f.id)));
  s.sections.forEach((sec) => [sec, ...sec.fields].forEach((f) => {
    if (f.showIf && !ids.has(f.showIf.field)) throw new Error(`${spec.id}: "${f.id || f.title}" depends on removed field "${f.showIf.field}"`);
  }));
  return s;
};

/* Fields shared by several of the derived sheets (Coop, Condo, Rental, Multi 2-4). */
window.SHARED_FIELDS = {
  petsAllowed: (opts) => ({ id: "petsAllowed", label: "Pets Allowed", type: "checks", req: true, options: opts ||
    ["Breed Restrictions", "Call", "Cats OK", "Dogs OK", "No", "No Dogs", "No Restrictions", "Number Limit", "Size Limit", "Yes"] }),
  commonWalls: () => ({ id: "commonWalls", label: "Common Walls", type: "checks",
    options: ["1 Common Wall", "2+ Common Walls", "Center", "End Unit", "No Common Walls", "No One Above", "No One Below"] }),
  locationDescription: () => ({ id: "locationDescription", label: "Location Description", type: "checks",
    options: ["6th Floor Or Higher", "Basement", "Between 3rd And 5th Floors", "First Floor", "Front", "Ground Floor", "Rear",
      "Second Floor", "See Remarks", "Top Floor"] }),
  entryLevel: () => ({ id: "entryLevel", label: "Entry Level (Floor Number)", type: "number", req: true, min: 0 }),
  totalStories: () => ({ id: "totalStories", label: "Total Stories in Building", type: "number", min: 0 }),
  buildingAmenities: ["Building Link", "Doorman", "Live-In Super", "Lounge", "Receiving Room"],
  propertyManager: () => [
    { id: "propertyManagerName", label: "Property Manager Name", type: "text" },
    { id: "propertyManagerPhone", label: "Property Manager Phone", type: "phone" },
  ],
  taxAssessedValue: () => ({ id: "taxAssessedValue", label: "Tax Assessed Value", type: "money" }),
  parkingFee: () => ({ id: "parkingFee", label: "Parking Fee", type: "money" }),
};

// ---- matrix/coop-condo.js
/*
 * OneKey MLS — Residential - Coop and Residential - Condo
 * Sources: "Residential - Coop Matrix Listing Profile Sheet" and
 *          "Residential - Condo Matrix Listing Profile Sheet", both Last Updated 03/27/2026.
 * Written as differences from the Residential sheet (see residential.js).
 */
(function () {
  const S = window.SHARED_FIELDS;

  // Edits common to both building-style sheets.
  const shared = {
    removeOpts: {
      disclosures: ["Elevation Certificate"],
      appliances: ["Water Heater - Geothermal"],
    },
    addOpts: {
      disclosures: ["By Laws"],
      associationAmenities: S.buildingAmenities,
      basementFeatures: ["Common"],
      attic: ["Common"],
      laundryFeatures: ["Common Area", "In Unit"],
      parkingFeatures: ["Valet", "Waitlist"],
      exteriorFeatures: ["Private Entrance", "Private Roof", "Roof Deck"],
    },
    remove: ["propertySubType", "bodyType", "buildersLotNumber", "buildingAreaTotal", "buildingAreaSource",
      "kitchens", "poolPrivate", "spa", "lotSizeDimensions", "horse"],
    patch: {
      architecturalStyle: { options: ["Garden", "High Rise", "Includes Legal Accessory Apartment", "Mid Rise", "Other",
        "Penthouse", "Townhouse"] },
    },
    insertAfter: {
      gla: [S.entryLevel(), S.totalStories()],
      associationPhone: S.propertyManager(),
      parkingTotal: [S.parkingFee()],
    },
    insertBefore: {
      appliances: [{ id: "buildingFeatures", label: "Building Features", type: "checks",
        options: ["Bicycle Room", "Outdoor Space", "Pool", "Walk Up"] }],
    },
  };
  const merge = (a, b) => {
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (typeof (b[k] ?? a[k]) !== "object") out[k] = b[k] ?? a[k];
      else if (Array.isArray(a[k]) || Array.isArray(b[k])) out[k] = [...(a[k] || []), ...(b[k] || [])];
      else {
        out[k] = { ...(a[k] || {}) };
        for (const [kk, vv] of Object.entries(b[k] || {})) out[k][kk] = Array.isArray(vv) && Array.isArray(out[k][kk]) ? [...out[k][kk], ...vv] : vv;
      }
    }
    return out;
  };

  // ---------- Coop ----------
  window.SCHEMAS.coop = window.deriveSchema("residential", merge(shared, {
    id: "coop",
    name: "Residential - Coop",
    sourceDoc: "OneKey MLS Residential - Coop Matrix Listing Profile Sheet — Last Updated 03/27/2026",
    // Coop sheet has no tax fields (taxes are in the maintenance).
    remove: ["taxYear", "taxAnnualAmount", "taxAssessment", "taxSource", "includedInTaxes"],
    patch: {
      attic: { req: false },
      glaSource: { label: "Taxable Living Area (GLA) Source" },
    },
    insertAfter: {
      specialListingConditions: [S.petsAllowed()],
      disclosures: [{ id: "shares", label: "# of Shares", type: "number", min: 0 }],
      exclusions: [
        { id: "minIncomeRequired", label: "Minimum Income Required", type: "yesno" },
        { id: "minIncomeAmount", label: "Minimum Income Amount", type: "money", showIf: { field: "minIncomeRequired", equals: "Yes" } },
        { id: "minDownPct", label: "Minimum % Down Payment", type: "number", req: true, min: 0, max: 100, step: "any", suffix: "%" },
        { id: "maxFinancePct", label: "Max Finance %", type: "number", min: 0, max: 100, step: "any", suffix: "%" },
        { id: "estMmDeduct", label: "Estimated MM Deduct", type: "text" },
      ],
      builderModel: [
        { id: "flipTax", label: "Flip Tax", type: "yesno" },
        { id: "flipTaxAmount", label: "Flip Tax Amount", type: "text", showIf: { field: "flipTax", equals: "Yes" } },
        S.commonWalls(),
        S.locationDescription(),
      ],
      communityFeatures: [
        { id: "estMonthlyMaintenance", label: "Estimated Monthly Maintenance", type: "money" },
        { id: "rentingAllowed", label: "Renting Allowed", type: "yesno" },
        { id: "approvalRequired", label: "Approval Required", type: "yesno", req: true },
      ],
    },
  }));

  // ---------- Condo ----------
  window.SCHEMAS.condo = window.deriveSchema("residential", merge(shared, {
    id: "condo",
    name: "Residential - Condo",
    sourceDoc: "OneKey MLS Residential - Condo Matrix Listing Profile Sheet — Last Updated 03/27/2026",
    remove: ["taxAssessment"],
    insertAfter: {
      specialListingConditions: [S.petsAllowed(["Breed Restrictions", "Call", "Cats OK", "Dogs OK", "No Dogs",
        "No Restrictions", "Number Limit", "Size Limit"])],
      disclosures: [{ id: "maxFinancePct", label: "Max Finance %", type: "number", min: 0, max: 100, step: "any", suffix: "%" }],
      includedInTaxes: [S.taxAssessedValue()],
      builderModel: [S.commonWalls(), S.locationDescription()],
      communityFeatures: [
        { id: "rentingAllowed", label: "Renting Allowed", type: "yesno" },
        { id: "approvalRequired", label: "Approval Required", type: "yesno" },
      ],
    },
  }));
})();

// ---- matrix/multi-2-4.js
/*
 * OneKey MLS — Residential - Multi 2-4  (Matrix menu: "Res Income - Multi 2-4")
 * Source: "Residential - Multi 2-4 Matrix Listing Profile Sheet", Last Updated 03/27/2026.
 * Written as differences from the Residential sheet (see residential.js).
 */
(function () {
  const S = window.SHARED_FIELDS;
  window.SCHEMAS.multi24 = window.deriveSchema("residential", {
    id: "multi24",
    name: "Res Income - Multi 2-4",
    sourceDoc: "OneKey MLS Residential - Multi 2-4 Matrix Listing Profile Sheet — Last Updated 03/27/2026",
    removeSections: ["Rooms"],
    addSections: [{
      after: "Community/Association",
      section: {
        title: "Units",
        fields: [
          { id: "unitsTotal", label: "Units Total", type: "number", req: true, min: 2, max: 4 },
          { id: "totalVacancies", label: "Total Vacancies", type: "number", min: 0 },
          { id: "units", label: "Unit Details", type: "repeat", max: 4, addLabel: "Add unit", itemLabel: "Unit",
            item: [
              { id: "unitType", label: "Unit Type", type: "select",
                options: ["1 Bedroom", "2 Bedroom", "3 Bedroom", "4 Bedroom Or More", "Efficiency", "Loft", "Penthouse", "Studio"] },
              { id: "entryLevel", label: "Entry Level (Floor Number)", type: "number" },
              { id: "bedrooms", label: "Total # of Bedrooms", type: "number" },
              { id: "bathrooms", label: "Total # of Bathrooms (full/half/partial)", type: "text" },
              { id: "roomsTotal", label: "Rooms Total", type: "number" },
              { id: "livingArea", label: "Unit Living Area", type: "number" },
              { id: "leased", label: "Leased Y/N", type: "yesno" },
              { id: "leaseExpiration", label: "Lease Expiration", type: "date" },
              { id: "actualRent", label: "Actual Rent", type: "money" },
              { id: "appliances", label: "Appliances", type: "checks",
                options: ["Dishwasher", "Dryer", "ENERGY STAR Qualified Appliances", "Microwave", "Oven", "Range",
                  "Refrigerator", "Washer"] },
            ] },
        ],
      },
    }],
    remove: [
      "leaseConsidered",
      "bodyType", "buildersLotNumber", "builderModel", "taxAssessment",
      // No HOA block on this sheet, only amenities and community features.
      "association", "associationFee", "associationFeeFrequency", "associationName", "associationPhone", "associationFeeIncludes",
      // Living area, levels and appliances are captured per unit instead.
      "gla", "glaSource", "levels", "kitchens", "appliances",
      "horse",
    ],
    patch: {
      propertySubType: { options: ["Duplex", "Triplex", "Quadruplex"] },
      associationAmenities: { showIf: undefined },
      attic: { req: false },
      architecturalStyle: { req: false },
      poolPrivate: { req: false },
    },
    removeOpts: {
      disclosures: ["Elevation Certificate", "HOA/Condo Disclosure Available"],
      architecturalStyle: ["Split Level", "Traditional"],
    },
    addOpts: {
      attic: ["Common"],
      basementFeatures: ["Common"],
      laundryFeatures: ["Common Area", "In Unit"],
      architecturalStyle: ["Flats", "High Rise", "Mid Rise", "Row Dwelling"],
      parkingFeatures: ["Valet", "Waitlist"],
      exteriorFeatures: ["Private Roof"],
      heating: ["Separate Meters"],
      cooling: ["Separate Meters", "Varies by Unit"],
    },
    insertAfter: {
      specialListingConditions: [{ id: "tenantPays", label: "Tenant Pays", type: "checks",
        options: ["All Utilities", "Electricity", "Gas", "Heat", "None", "See Remarks", "Water"] }],
      listingTerms: [{ id: "capRate", label: "Cap Rate", type: "number", min: 0, step: "any", suffix: "%" }],
      seniorHousing: [
        { id: "grossIncome", label: "Gross Income", type: "money" },
        { id: "operatingExpense", label: "Operating Expense", type: "money" },
      ],
      includedInTaxes: [S.taxAssessedValue()],
      heatingZones: [{ id: "heatUnits", label: "# Heat Units", type: "number", min: 0 }],
      electricCompany: [
        { id: "electricMeters", label: "# Electric Meters", type: "number", min: 0 },
        { id: "gasMeters", label: "# Gas Meters", type: "number", min: 0 },
      ],
      waterSource: [
        { id: "waterSewerExpense", label: "Water Sewer Expense", type: "money" },
        { id: "fuelExpense", label: "Fuel Expense", type: "money" },
        { id: "insuranceExpense", label: "Insurance Expense", type: "money" },
        { id: "otherExpense", label: "Other Expense", type: "money" },
        { id: "trashExpense", label: "Trash Expense", type: "money" },
        { id: "commonAreaMaintenance", label: "Common Area Maintenance", type: "money" },
      ],
    },
  });
})();

// ---- matrix/rental.js
/*
 * OneKey MLS — Rental
 * Source: "Rental Matrix Listing Profile Sheet", Last Updated 03/27/2026.
 * Written as differences from the Residential sheet (see residential.js).
 */
(function () {
  const S = window.SHARED_FIELDS;
  const SEASONAL = { field: "leaseTerm", includes: "Short Term/Seasonal" };

  const LANGUAGES = ["Abkhazian", "Afar", "Afrikaans", "Albanian", "American Sign Language", "Amharic", "Arabic", "Aramaic",
    "Armenian", "Assamese", "Assyrian Neo-Aramaic", "Avestan", "Aymara", "Azerbaijani", "Bambara", "Bashkir", "Basque",
    "Bengali", "Bihari", "Bikol", "Bislama", "Bosnian", "Brazilian Portuguese", "Bulgarian", "Burmese", "Byelorussian",
    "Cambodian", "Cantonese", "Cape Verdean Creole", "Catalan", "Cebuano", "Chamorro", "Chechen", "Chinese", "Chuukese",
    "Chuvash", "Cornish", "Corsican", "Croatian", "Czech", "Danish", "Dari (Afghan Persian)", "Dioula", "Dutch", "Dzongkha",
    "English", "Esperanto", "Estonian", "Faroese", "Farsi", "Fiji", "Finnish", "Flemish", "French", "Frisian", "Galician",
    "Georgian", "German", "Greek", "Greenlandic", "Guarani", "Gujarati", "Haitian Creole", "Hausa", "Hebrew", "Herero",
    "Hiligaynon", "Hindi", "Hiri Motu", "Hmong", "Hungarian", "Iban", "Icelandic", "Igbo", "Ilocano", "Indonesian",
    "Interlingua", "Inuktitut", "Inupiak", "Irish (Gaelic)", "Italian", "Japanese", "Javanese", "K'iche'", "Kannada",
    "Kashmiri", "Kazakh", "Kichwa", "Kikuyu", "Kinyarwanda", "Kirghiz", "Kirundi", "Komi", "Korean", "Kpelle", "Kru",
    "Kurdish", "Lao", "Latin", "Latvian", "Lingala", "Lithuanian", "Luxemburgish", "Macedonian", "Malagasy", "Malay",
    "Malayalam", "Maltese", "Mandarin", "Maninka", "Manx Gaelic", "Maori", "Marathi", "Marshallese", "Moldovan",
    "Mongolian", "Nauru", "Navajo", "Ndebele", "Ndonga", "Nepali", "Norwegian", "Norwegian (Nynorsk)", "Nyanja", "Occitan",
    "Oriya", "Oromo", "Ossetian", "Pali", "Pangasinan", "Papiamento", "Pashto", "Patois", "Persian", "Polish", "Portuguese",
    "Punjabi", "Quechua", "Romanian", "Romany", "Russian", "Sami", "Samoan", "Sangho", "Sanskrit", "Sardinian",
    "Scots Gaelic", "Serbian", "Serbo-Croatian", "Sesotho", "Setswana", "Shan", "Shona", "Sindhi", "Sinhalese", "Siswati",
    "Slovak", "Slovenian", "Somali", "Southern Ndebele", "Spanish", "Sundanese", "Swahili", "Swedish", "Swiss German",
    "Syriac", "Tagalog", "Tahitian", "Taiwanese", "Tajik", "Tamil", "Tatar", "Telugu", "Thai", "Tibetan", "Tigrinya",
    "Tongan", "Tsonga", "Turkish", "Turkmen", "Twi", "Uigur", "Ukrainian", "Urdu", "Uzbek", "Vietnamese", "Volapuk",
    "Welsh", "Wolof", "Xhosa", "Yiddish", "Yoruba", "Zhuang", "Zulu"];

  window.SCHEMAS.rental = window.deriveSchema("residential", {
    id: "rental",
    name: "Rental",
    sourceDoc: "OneKey MLS Rental Matrix Listing Profile Sheet — Last Updated 03/27/2026",
    addSections: [{
      after: "Listing/Contract",
      section: {
        title: "Short Term/Seasonal",
        showIf: SEASONAL,
        fields: [
          { id: "cleaningFee", label: "Cleaning Fee", type: "money", req: true },
          { id: "sleeps", label: "Sleeps", type: "number", min: 0 },
          { id: "numberOfBeds", label: "Number of Beds", type: "number", min: 0 },
          { id: "interiorAccommodations", label: "Interior Accommodations", type: "checks",
            options: ["Charging Station(s)", "Crib", "Fire Extinguisher(s)", "Full Length Mirror", "Inflatable Mattress(s)",
              "Iron/Ironing Board", "Pack & Play", "Pool Table", "Printer", "Smart TV(s)"] },
          { id: "kitchenAccommodations", label: "Kitchen Accommodations", type: "checks",
            options: ["Air Fryer", "Blender", "Can Opener", "Coffee Pot", "Cookware", "Crock Pot", "Cutlery", "Dishware",
              "Glassware", "Keurig", "Microwave", "Percolator", "Wine Bottle Opener", "Wine Glasses"] },
          { id: "bathroomAccommodations", label: "Bathroom Accommodations", type: "checks",
            options: ["Blow Dryer", "Conditioner", "Hot Tub", "Rubs", "Shampoo", "Soap/Body Wash", "Towels"] },
          { id: "hostProvided", label: "Host Provided", type: "checks",
            options: ["Beach/Pool Towels", "Board Games", "Bottled Water", "Cleaning Supplies", "Coffee/K-Cups", "Duvet",
              "Extra Pillows", "Extra Sheets/Blankets", "First Aid Kit", "Grilling Tools & Accessories", "Groceries",
              "Laundry Detergent", "Napkins/Tissues", "Paper Towels", "Provided", "Spices/Seasonings", "Streaming Services",
              "Toilet Paper", "WiFi"] },
          { id: "poolAccommodations", label: "Pool Accommodations", type: "checks",
            options: ["Diving Board", "Goggles", "Inflatable Floats", "Pool Noodles", "Pool Safety Fence", "Pool Toys", "Slide"] },
          { id: "exteriorAccommodations", label: "Exterior Accommodations", type: "checks",
            options: ["Bicycle(s)", "Canoe(s)", "Cornhole", "Dock Space", "Exterior Shower", "Fishing Poles", "Golf Cart(s)",
              "Hammock", "Jet Ski(s)", "Kayak(s)", "Lounge Chairs", "Pickle Ball Equipment", "Wagon(s)"] },
          { id: "hostLanguage", label: "Host or Owner Language", type: "checks", options: LANGUAGES },
        ],
      },
    }],
    remove: [
      "listPrice", "leaseConsidered", "listingTerms",
      "additionalParcels", "taxYear", "taxAnnualAmount", "taxAssessment", "taxSource", "includedInTaxes",
      "associationName", "associationPhone",
      "kitchens",
    ],
    patch: {
      listingAgreement: { options: ["Exclusive Agency", "Exclusive Right to Lease"] },
      specialListingConditions: { options: ["None", "Purchase Option", "Renewal Option", "See Remarks", "Sublease", "Third Party Approval"] },
      propertySubType: { options: ["Apartment", "Condominium", "Duplex", "Houseboat", "Manufactured Home", "Manufactured On Land",
        "Mobile Home", "Mobile Home With Land", "Multi Family", "Single Family Residence", "Stock Cooperative"] },
      buildersLotNumber: { label: "Builder's Lot #" },
      poolPrivate: { req: false },
      roadResponsibility: { options: ["Landlord", "Tenant"] },
    },
    removeOpts: { disclosures: ["Elevation Certificate"] },
    addOpts: {
      disclosures: ["By Laws"],
      associationAmenities: S.buildingAmenities,
      attic: ["Common"],
      basementFeatures: ["Common"],
      laundryFeatures: ["Common Area", "In Unit"],
      architecturalStyle: ["Full Floor Apartment", "High Rise", "Mid Rise", "Penthouse"],
      exteriorFeatures: ["Private Entrance", "Private Roof", "Roof Deck"],
    },
    insertAfter: {
      listingAgreement: [{ id: "leasePrice", label: "Lease Price", type: "money", req: true }],
      ownersName: [{ id: "smoking", label: "Smoking", type: "yesno" }],
      specialListingConditions: [
        S.petsAllowed(),
        { id: "rentalPermitRequired", label: "Rental Permit Required", type: "yesno" },
        { id: "permitNumber", label: "Permit Number", type: "text", showIf: { field: "rentalPermitRequired", equals: "Yes" } },
        { id: "permitExpDate", label: "Permit Exp Date", type: "date", showIf: { field: "rentalPermitRequired", equals: "Yes" } },
        { id: "leaseTerm", label: "Lease Term", type: "checks", req: true,
          options: ["1-6 Months", "6 Months", "6-12 Months", "12 Months", "24 Months", "Negotiable", "Other", "Over 12 Months",
            "Short Term/Seasonal"] },
        { id: "availabilityDate", label: "Availability Date", type: "date", req: true },
        { id: "monthSeasonAvailable", label: "Month or Season Available", type: "checks",
          options: ["Memorial-Labor", "June-July", "July-August", "July-Labor Day", "August-Labor Day", "January", "February",
            "March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "Off Season"] },
      ],
      exclusions: [
        { id: "securityDeposit", label: "Security Deposit (Include Pet Deposit)", type: "money", req: true,
          help: "All fees associated with renting the property must be clearly disclosed. Any required fee that has no field here must go in Public Remarks." },
      ],
      builderModel: [S.locationDescription(), S.commonWalls()],
      fireplaceFeatures: [
        { id: "furnished", label: "Furnished", type: "radio", options: ["Furnished", "Partially", "Unfurnished"] },
        { id: "furnishings", label: "Furnishings", type: "checks",
          showIf: { field: "furnished", in: ["Furnished", "Partially"] },
          options: ["Bunk Bed(s)", "Day Bed(s)", "Dining Table", "Dresser(s)", "Full Sized Bed(s)", "King Size Bed(s)", "Lamp(s)",
            "Love Seat", "Queen Size Bed(s)", "Recliner(s)", "Sectional Sofa", "Sofa Bed(s)", "Twin Size Bed(s)"] },
      ],
      parkingTotal: [S.parkingFee()],
      cooling: [{ id: "rentIncludes", label: "Rent Includes", type: "checks",
        options: ["Air Conditioning", "All Utilities", "Association Fees", "Cable TV", "Electricity", "Gas", "Grounds Care", "Heat",
          "Pool Maintenance", "Recycling", "See Remarks", "Sewer", "Snow Removal", "Trash", "Water"] }],
      showingRequirements: [{ id: "rentSpree", label: "RentSpree Online Tenant Screening Y/N", type: "yesno", req: true }],
    },
    insertBefore: {
      appliances: [S.entryLevel(), S.totalStories()],
    },
    // On the Rental sheet the additional-fee fields sit under "Fees", after the security deposit.
    move: {
      additionalFees: "securityDeposit",
      additionalFeeAmount: "additionalFees",
      additionalFeeFrequency: "additionalFeeAmount",
      additionalFeeDescription: "additionalFeeFrequency",
    },
  });
})();

// ---- matrix/land.js
/*
 * OneKey MLS — Land
 * Source: "Land Matrix Input Form", Last Updated 11/12/2024 (older than the other sheets).
 * Written as differences from the Residential sheet (see residential.js).
 */
(function () {
  window.SCHEMAS.land = window.deriveSchema("residential", {
    id: "land",
    name: "Land",
    sourceDoc: "OneKey MLS Land Matrix Input Form — Last Updated 11/12/2024",
    removeSections: ["Rooms", "Interior"],
    // On the Land sheet, Distribution is the last section.
    moveSectionsToEnd: ["Distribution"],
    remove: [
      "listingExposure",
      "elemDistrict", "middleDistrict", "highDistrict",
      "propertySubType", "bodyType", "buildersLotNumber", "builderModel", "propertyAttached", "yearBuilt",
      "yearBuiltEffective", "propertyCondition",
      "associationFee", "associationFeeFrequency", "associationName", "associationPhone", "associationFeeIncludes",
      "architecturalStyle", "directionFaces", "constructionMaterials", "foundationDetails", "garage", "garageSpaces",
      "carport", "carportSpaces", "parkingTotal", "parkingFeatures", "poolPrivate", "spa", "poolFeatures",
      "distanceToTrain", "exteriorFeatures", "securityFeatures", "patioPorchFeatures",
      "greenVerificationType", "greenVerificationYear", "greenEnergyGeneration", "solarOwnership",
      "heating", "heatingZones", "cooling",
    ],
    patch: {
      streetNumber: { req: false },
      postOfficeTown: { req: false },
      syndicateTo: { options: ["Realtor.com"] },
      leaseConsidered: { req: false },
      additionalFeeFrequency: { options: ["Annually", "Monthly", "Quarterly"] },
      seniorHousing: { req: false },
      taxYear: { req: false },
      taxAnnualAmount: { req: false },
      taxSource: { req: false },
      includedInTaxes: { label: "Tax Includes" },
      association: { req: false },
      associationAmenities: { showIf: undefined },
      lotSizeAcres: { req: true },
      lotSizeSqft: { req: true },
      lotFeatures: { req: true },
      waterfront: { req: false },
      utilities: { req: false },
      waterSource: { req: false },
      showingRequirements: { req: false },
    },
    removeOpts: {
      specialListingConditions: ["Auction Terms of Sale"],
      lotFeatures: ["Back Yard", "Front Yard"],
      otherStructures: ["Residence"],
    },
    addOpts: {
      specialListingConditions: ["Standard"],
      lotFeatures: ["Pasture", "Tillable"],
      otherStructures: ["Residence(s)"],
    },
    insertBefore: {
      elemSchool: [{ id: "schoolDistrict", label: "School District", type: "text", req: true }],
      showAddress: [{ id: "publishToInternet", label: "Publish to Internet", type: "yesno", req: true }],
    },
    insertAfter: {
      directions: [
        { id: "latitude", label: "Latitude", type: "number", req: true, step: "any", min: -90, max: 90 },
        { id: "longitude", label: "Longitude", type: "number", req: true, step: "any", min: -180, max: 180 },
      ],
      specialListingConditions: [
        { id: "documentsAvailable", label: "Documents Available", type: "checks",
          options: ["Aerial Photo", "Appraisal", "Building Plan", "Deed Restrictions", "Documents", "Engineering Report",
            "Filed Map", "Other", "Percolation Test", "Potable Water Test", "Siteplan", "Subdivision Plan", "Survey",
            "Topographical"] },
        { id: "restrictions", label: "Restrictions", type: "checks",
          options: ["Agricultural District", "Association Restrictions", "Building Restrictions", "Deed Restrictions",
            "Dot Approval Required", "Easements", "Forestry District", "Health Department Approval Required", "Mineral Rights",
            "None", "Other", "Subdivision Restrictions", "Waterfront Restrictions", "Wet Lands Restrictions"] },
        { id: "numberOfLots", label: "# of Lots", type: "number", min: 0 },
      ],
      taxSource: [
        { id: "currentUse", label: "Current Use", type: "checks", req: true,
          options: ["Agricultural", "Automotive", "Commercial", "Dairy", "Farm", "Fishery", "Highway/Tourist Service", "Horses",
            "Industrial", "Livestock", "Mixed Use", "Multi-Family", "Municipal", "Office", "Other", "Ranch", "Recreational",
            "Residential", "Retail", "Single Family", "Subdivision", "Timber", "Unimproved", "Vacant"] },
        { id: "boardOfHealthApp", label: "Board of Health App", type: "yesno" },
      ],
      utilities: [
        { id: "utilitiesOnAbuttingSite", label: "Utilities On Abutting Site", type: "checks",
          options: ["Cable", "Electric", "Gas", "None", "Phone", "See Remarks", "Septic", "Sewer", "Water", "Well"] },
        { id: "distanceToWaterComments", label: "Distance To Water Comments", type: "text" },
        { id: "distanceToSewerComments", label: "Distance To Sewer Comments", type: "text" },
      ],
      syndicateTo: [{ id: "privateListing", label: "Private Listing", type: "yesno" }],
    },
    move: {
      horse: "lotSizeDimensions",
      roadFrontageType: "view",
      roadResponsibility: "roadFrontageType",
    },
  });
})();

function MATRIX_SCHEMAS_() { return window.SCHEMAS; }

// ---------------------------------------------------------------------------
// THE PAGE AGENTS SEE (kept in this file so the whole app is one paste)
// ---------------------------------------------------------------------------
var INDEX_HTML = "<!DOCTYPE html>\n<html>\n<head>\n<base target=\"_top\">\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Agent Deal Tracker</title>\n<style>\n  :root {\n    --bg: #f4f5f7; --card: #ffffff; --ink: #111827; --muted: #6b7280; --line: #e5e7eb;\n    --brand: #1f2937; --accent: #2563eb; --accent-ink: #ffffff; --ok: #059669; --warn: #d97706; --bad: #dc2626;\n    --seller: #7c3aed; --buyer: #2563eb; --tenant: #0d9488; --landlord: #c2410c;\n    --radius: 12px;\n  }\n  * { box-sizing: border-box; }\n  body { margin: 0; font: 15px/1.45 -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--ink); }\n  header.top { background: var(--brand); color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }\n  header.top h1 { font-size: 17px; margin: 0; flex: 1; letter-spacing: .2px; }\n  header.top .who { font-size: 13px; opacity: .85; }\n  main { max-width: 980px; margin: 0 auto; padding: 16px; }\n  .hidden { display: none !important; }\n  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; }\n  .btn { appearance: none; border: 1px solid var(--line); background: #fff; color: var(--ink); padding: 9px 14px; border-radius: 9px; font: inherit; font-weight: 600; cursor: pointer; }\n  .btn:hover { background: #f9fafb; }\n  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }\n  .btn.primary:hover { filter: brightness(1.07); }\n  .btn.ghost { background: transparent; border-color: rgba(255,255,255,.35); color: #fff; }\n  .btn:disabled { opacity: .55; cursor: default; }\n  label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px; }\n  input, select, textarea { width: 100%; font: inherit; padding: 9px 10px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: var(--ink); }\n  input:focus, select:focus, textarea:focus { outline: 2px solid #bfdbfe; border-color: var(--accent); }\n  textarea { min-height: 90px; resize: vertical; }\n  .req::after { content: \" *\"; color: var(--bad); }\n  .muted { color: var(--muted); }\n  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }\n\n  /* Login */\n  #login { max-width: 380px; margin: 8vh auto 0; }\n  #login h2 { margin: 0 0 4px; }\n  #login .field { margin-top: 12px; }\n\n  /* Toolbar & list */\n  .toolbar { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin-bottom: 12px; }\n  .filters { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 8px; margin-bottom: 14px; }\n  .filters.admin { grid-template-columns: 2fr 1fr 1fr 1.3fr; }\n  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }\n  .stat { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }\n  .stat b { display: block; font-size: 20px; }\n  .stat span { font-size: 12px; color: var(--muted); }\n  .deal { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; padding: 14px 16px; margin-bottom: 10px; cursor: pointer; transition: border-color .15s; }\n  .deal:hover { border-color: #93c5fd; }\n  .deal .addr { font-weight: 700; }\n  .deal .meta { font-size: 13px; color: var(--muted); }\n  .badge { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; color: #fff; }\n  .b-Seller { background: var(--seller); } .b-Buyer { background: var(--buyer); } .b-Tenant { background: var(--tenant); } .b-Landlord { background: var(--landlord); }\n  .status { font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; white-space: nowrap; }\n  .s-Sold { background: #d1fae5; color: #065f46; } .s-Cancelled { background: #fee2e2; color: #991b1b; } .s-TOM { background: #fef3c7; color: #92400e; }\n  .s-Under, .s-Closing { background: #dbeafe; color: #1e40af; } .s-Accepted { background: #ede9fe; color: #5b21b6; } .s-Coming { background: #f3f4f6; color: #374151; }\n  .stage-banner { background: #fff7e6; border: 1px solid #f5c26b; color: #7a4b00; border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; font-size: 14px; }\n  .stage-banner.ok { background: #ecfdf5; border-color: #8fd9b6; color: #065f46; }\n  .need label, label.need { color: #b45309; }\n  .need input, .need select, .need textarea { border-color: #f5a524; background: #fffbeb; }\n  .mlsrow { display: flex; gap: 8px; } .mlsrow input { flex: 1; min-width: 0; } .mlsrow .btn { white-space: nowrap; padding: 9px 12px; }\n  .help { display: block; font-size: 12px; color: var(--muted); margin-top: 3px; }\n  .sky { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: #f3f4f6; color: #374151; white-space: nowrap; }\n  .sky.ok { background: #d1fae5; color: #065f46; } .sky.wait { background: #fef3c7; color: #92400e; } .sky.err { background: #fee2e2; color: #991b1b; }\n  .bar { height: 6px; background: #e5e7eb; border-radius: 99px; overflow: hidden; grid-column: 1 / -1; }\n  .bar > i { display: block; height: 100%; background: var(--ok); }\n  .empty { text-align: center; padding: 40px 16px; color: var(--muted); }\n\n  /* Side picker */\n  .sides { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 12px; }\n  .side-tile { border: 2px solid var(--line); border-radius: var(--radius); padding: 18px; background: #fff; cursor: pointer; text-align: left; font: inherit; }\n  .side-tile:hover { border-color: var(--accent); }\n  .side-tile b { display: block; font-size: 18px; margin-bottom: 4px; }\n  .side-tile span { font-size: 13px; color: var(--muted); }\n\n  /* Editor */\n  .ed-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }\n  .ed-head h2 { margin: 0; font-size: 20px; flex: 1; min-width: 200px; }\n  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 14px; overflow-x: auto; }\n  .tab { padding: 10px 14px; border: 0; background: none; font: inherit; font-weight: 600; color: var(--muted); border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; }\n  .tab.on { color: var(--accent); border-color: var(--accent); }\n  fieldset { border: 0; padding: 0; margin: 0 0 18px; }\n  legend { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin-bottom: 10px; }\n  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px 14px; }\n  .grid .wide { grid-column: 1 / -1; }\n  .ms { display: grid; grid-template-columns: 28px 1fr 150px; gap: 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); }\n  .ms:last-child { border-bottom: 0; }\n  .ms input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--ok); }\n  .ms .ml { font-weight: 600; }\n  .ms.done .ml { color: var(--ok); }\n  .ms .note { grid-column: 2 / -1; font-size: 13px; padding: 6px 8px; }\n  .savebar { position: sticky; bottom: 0; background: rgba(244,245,247,.95); backdrop-filter: blur(4px); padding: 12px 0; display: flex; gap: 10px; justify-content: flex-end; border-top: 1px solid var(--line); margin-top: 10px; }\n  .docs-upload { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: end; margin-bottom: 14px; }\n  .doc { display: flex; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 14px; }\n  .doc a { color: var(--accent); font-weight: 600; text-decoration: none; word-break: break-word; }\n\n  /* MLS listing tab */\n  .mx-top { display: grid; grid-template-columns: 1fr auto; gap: 10px 14px; align-items: end; margin-bottom: 12px; }\n  .mx-prog { height: 6px; background: #e5e7eb; border-radius: 99px; overflow: hidden; margin: 4px 0 4px; }\n  .mx-prog > i { display: block; height: 100%; background: var(--seller); width: 0; transition: width .2s; }\n  .mx-nav { display: flex; gap: 6px; overflow-x: auto; padding: 6px 0 10px; position: sticky; top: 52px; background: #fff; z-index: 4; }\n  .mx-nav a { flex: none; font-size: 12px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink); text-decoration: none; background: #fff; }\n  .mx-nav a.ok { color: var(--ok); border-color: #8fd9b6; }\n  .chips { display: flex; flex-wrap: wrap; gap: 6px; }\n  .chip { position: relative; margin: 0; font-weight: 400; }\n  .chip input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; width: 100%; height: 100%; }\n  .chip span { display: inline-block; padding: 6px 11px; border-radius: 999px; border: 1px solid #d1d5db; background: #f9fafb; font-size: 13px; color: var(--ink); user-select: none; }\n  .chip input:checked + span { background: var(--seller); border-color: var(--seller); color: #fff; }\n  .chip input:focus-visible + span { outline: 2px solid #bfdbfe; }\n  .opt-filter { margin-bottom: 6px; }\n  .mx-err { color: var(--bad); font-size: 12px; margin-top: 3px; }\n  .mx-field.flash { animation: mxflash 1.6s; border-radius: 8px; }\n  @keyframes mxflash { 0%, 60% { box-shadow: 0 0 0 4px #f5c26b; } 100% { box-shadow: none; } }\n  .rep { display: grid; gap: 10px; margin-bottom: 8px; }\n  .rep-item { background: #f9fafb; border: 1px solid var(--line); border-radius: 10px; padding: 10px; }\n  .rep-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }\n  .icon-btn { width: 34px; height: 34px; padding: 0; border-radius: 8px; border: 1px solid var(--line); background: #fff; cursor: pointer; font-size: 16px; line-height: 1; }\n  .icon-btn:disabled { opacity: .35; cursor: default; }\n  .icon-btn.danger { color: var(--bad); }\n  .drop { position: relative; display: block; border: 2px dashed #d1d5db; border-radius: 12px; padding: 18px; text-align: center; color: var(--muted); font-weight: 500; margin: 6px 0 10px; }\n  .drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }\n  .photos { list-style: none; margin: 0 0 16px; padding: 0; display: grid; gap: 10px; }\n  .photo { display: grid; grid-template-columns: 110px 1fr; gap: 10px; align-items: start; }\n  .thumb { position: relative; aspect-ratio: 4 / 3; background: #f3f4f6; border-radius: 8px; overflow: hidden; }\n  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }\n  .thumb b { position: absolute; left: 5px; top: 5px; background: rgba(0,0,0,.65); color: #fff; font-size: 11px; padding: 1px 6px; border-radius: 6px; }\n  .mx-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; margin-top: 8px; }\n  .mx-issues { border-radius: 10px; padding: 10px 14px; margin: 10px 0; font-size: 14px; }\n  .mx-issues.bad { background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; }\n  .mx-issues.warn { background: #fff7e6; border: 1px solid #f5c26b; color: #7a4b00; }\n  .mx-issues ul { margin: 6px 0 0; padding-left: 18px; }\n  .mx-issues a { color: inherit; }\n\n  /* Listing changes tab */\n  .chg-types { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); margin-top: 8px; }\n  .chg-tile { padding: 12px 14px; }\n  .chg-tile b { font-size: 15px; }\n  .chg-tile:disabled { opacity: .45; cursor: default; }\n  .chg-steps { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }\n  .chg-steps span { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #f3f4f6; color: var(--muted); }\n  .chg-steps span.on { background: #d1fae5; color: #065f46; }\n\n  /* Toast */\n  #toast { position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); background: #111827; color: #fff; padding: 11px 16px; border-radius: 10px; font-size: 14px; max-width: calc(100% - 32px); z-index: 50; box-shadow: 0 8px 24px rgba(0,0,0,.2); }\n  #toast.err { background: var(--bad); }\n  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -2px; margin-right: 6px; }\n  @keyframes spin { to { transform: rotate(360deg); } }\n\n  @media (max-width: 640px) {\n    .grid, .filters, .filters.admin, .sides, .docs-upload, .mx-top { grid-template-columns: 1fr; }\n    .photo { grid-template-columns: 90px 1fr; }\n    .stats { grid-template-columns: repeat(2, 1fr); }\n    .ms { grid-template-columns: 28px 1fr; }\n    .ms input[type=date] { grid-column: 2; }\n    header.top .who { display: none; }\n  }\n</style>\n</head>\n<body>\n\n<header class=\"top\">\n  <h1 id=\"appTitle\">Agent Deal Tracker</h1>\n  <span class=\"who\" id=\"who\"></span>\n  <button class=\"btn ghost hidden\" id=\"logoutBtn\">Sign out</button>\n</header>\n\n<main>\n  <!-- LOGIN -->\n  <section id=\"login\" class=\"card hidden\">\n    <h2>Agent sign-in</h2>\n    <p class=\"muted\" style=\"margin:0\">Your email, and your MLS ID as your PIN.</p>\n    <form id=\"loginForm\">\n      <div class=\"field\"><label for=\"loginEmail\">Email</label><input id=\"loginEmail\" type=\"email\" autocomplete=\"email\" required></div>\n      <div class=\"field\"><label for=\"loginPin\">PIN (your MLS ID)</label><input id=\"loginPin\" type=\"password\" autocomplete=\"current-password\" required></div>\n      <div class=\"field\"><button class=\"btn primary\" style=\"width:100%\" type=\"submit\" id=\"loginBtn\">Sign in</button></div>\n    </form>\n  </section>\n\n  <!-- LIST -->\n  <section id=\"list\" class=\"hidden\">\n    <div class=\"toolbar\">\n      <h2 style=\"margin:0;align-self:center\" id=\"listTitle\">My deals</h2>\n      <button class=\"btn primary\" id=\"newDealBtn\">+ New deal</button>\n    </div>\n    <div class=\"stats\" id=\"stats\"></div>\n    <div class=\"filters\" id=\"filters\">\n      <input id=\"fSearch\" placeholder=\"Search address, client, deal ID\u2026\">\n      <select id=\"fSide\"><option value=\"\">All sides</option></select>\n      <select id=\"fStatus\"><option value=\"\">All statuses</option></select>\n      <select id=\"fAgent\" class=\"hidden\"><option value=\"\">All agents</option></select>\n    </div>\n    <div id=\"deals\"></div>\n  </section>\n\n  <!-- SIDE PICKER -->\n  <section id=\"picker\" class=\"hidden\">\n    <button class=\"btn\" data-go=\"list\">\u2190 Back</button>\n    <h2 style=\"margin:16px 0 0\">Who are you representing?</h2>\n    <div class=\"sides\">\n      <button class=\"side-tile\" data-side=\"Seller\"><b>Seller</b><span>Listing side of a sale</span></button>\n      <button class=\"side-tile\" data-side=\"Buyer\"><b>Buyer</b><span>Purchase side of a sale</span></button>\n      <button class=\"side-tile\" data-side=\"Tenant\"><b>Tenant</b><span>Helping someone lease a property</span></button>\n      <button class=\"side-tile\" data-side=\"Landlord\"><b>Landlord</b><span>Leasing out an owner's property</span></button>\n    </div>\n  </section>\n\n  <!-- EDITOR -->\n  <section id=\"editor\" class=\"hidden\">\n    <button class=\"btn\" data-go=\"list\">\u2190 All deals</button>\n    <div class=\"ed-head\" style=\"margin-top:14px\">\n      <span class=\"badge\" id=\"edSide\"></span>\n      <h2 id=\"edTitle\">New deal</h2>\n      <div style=\"min-width:170px\"><select id=\"edStatus\" aria-label=\"Deal status\"></select></div>\n    </div>\n    <p class=\"muted\" id=\"edMeta\" style=\"margin:-4px 0 10px;font-size:13px\"></p>\n    <div id=\"edAgentWrap\" class=\"card hidden\" style=\"margin-bottom:12px;padding:12px 16px\">\n      <label for=\"edAgent\" class=\"req\">Agent on this deal</label>\n      <select id=\"edAgent\"></select>\n      <span class=\"help\">The deal goes under this agent: their list, their office's inventory tab, and their name in SkySlope.</span>\n    </div>\n    <div id=\"stageBanner\" class=\"stage-banner hidden\" aria-live=\"polite\"></div>\n    <div class=\"tabs\">\n      <button class=\"tab on\" data-tab=\"details\">Deal details</button>\n      <button class=\"tab\" data-tab=\"milestones\">Milestones <span id=\"msCount\"></span></button>\n      <button class=\"tab\" data-tab=\"docs\">Documents</button>\n      <button class=\"tab hidden\" data-tab=\"changes\" id=\"chgTabBtn\">Listing changes</button>\n      <button class=\"tab hidden\" data-tab=\"mls\" id=\"mlsTabBtn\">MLS listing <span id=\"mxTabCount\"></span></button>\n    </div>\n\n    <form id=\"dealForm\" novalidate>\n      <div data-pane=\"details\" class=\"card\" id=\"detailsPane\"></div>\n      <div data-pane=\"milestones\" class=\"card hidden\">\n        <p class=\"muted\" style=\"margin-top:0\">Check each milestone as it happens. Dates default to today; change them if needed. Saving sends the update to the office.</p>\n        <div class=\"bar\" style=\"margin-bottom:8px\"><i id=\"msBar\" style=\"width:0\"></i></div>\n        <div id=\"msList\"></div>\n      </div>\n      <div data-pane=\"docs\" class=\"card hidden\">\n        <div id=\"docsLocked\" class=\"muted\">Save the deal first, then upload documents here.</div>\n        <p class=\"muted\" id=\"docsHelp\" style=\"margin-top:0;font-size:13px\"></p>\n        <div id=\"docsArea\" class=\"hidden\">\n          <div class=\"docs-upload\">\n            <div><label for=\"docCat\">Document type</label>\n              <select id=\"docCat\">\n                <option>Contract / Purchase Agreement</option><option>Listing Agreement</option><option>Buyer Agreement</option>\n                <option>Lease</option><option>Rental Application</option><option>Addendum / Amendment</option>\n                <option>Disclosure</option><option>Inspection Report</option><option>Earnest Money Receipt</option>\n                <option>Closing Disclosure / Settlement</option><option>Commission Disbursement</option><option>Other</option>\n              </select></div>\n            <div><label for=\"docFile\">File (max 20 MB)</label><input id=\"docFile\" type=\"file\" multiple></div>\n            <button class=\"btn primary\" type=\"button\" id=\"uploadBtn\">Upload</button>\n          </div>\n          <div id=\"docList\"></div>\n        </div>\n      </div>\n\n      <div data-pane=\"changes\" class=\"card hidden\" id=\"chgPane\">\n        <p class=\"muted\" style=\"margin-top:0;font-size:13px\">Price change, temporarily off market, back on market, withdraw, cancel or extend. Each one fills in the OneKey form in SkySlope for signature. <b>Once it is signed</b>, the change is made in Matrix and on this deal.</p>\n        <div id=\"chgNoMls\" class=\"stage-banner hidden\">Add the <b>MLS #</b> on Deal details and save first. Changes are for listings that are already on the MLS.</div>\n        <div id=\"chgOpenNote\" class=\"stage-banner hidden\"></div>\n        <div class=\"sides chg-types\" id=\"chgTypes\"></div>\n        <div id=\"chgForm\"></div>\n        <fieldset style=\"margin-top:18px\"><legend>Requests on this listing</legend><div id=\"chgList\"></div></fieldset>\n      </div>\n\n      <div data-pane=\"mls\" class=\"card hidden\" id=\"mlsPane\">\n        <div class=\"mx-top\">\n          <div>\n            <label for=\"mxType\" class=\"req\">Property type (as in Matrix)</label>\n            <select id=\"mxType\"></select>\n            <span class=\"help\" id=\"mxTypeHelp\">The same list as the + button in Matrix Listing Manager. The form below matches OneKey's input sheet for that type.</span>\n          </div>\n          <div id=\"mxStatus\" style=\"text-align:right\"></div>\n        </div>\n        <div id=\"mxBody\" class=\"hidden\">\n          <div class=\"mx-prog\"><i id=\"mxBar\"></i></div>\n          <p class=\"muted\" id=\"mxProgText\" style=\"margin:0 0 4px;font-size:13px\"></p>\n          <nav class=\"mx-nav\" id=\"mxNav\"></nav>\n          <div id=\"mxForm\"></div>\n\n          <fieldset id=\"mxMedia\">\n            <legend>Photos</legend>\n            <p class=\"muted\" style=\"margin:0;font-size:13px\">Photo #1 is the primary photo in Matrix. Use the arrows to set the order; captions are optional.</p>\n            <div id=\"mxMediaLocked\" class=\"muted hidden\" style=\"margin:8px 0\">Submit the deal first, then add photos and documents here.</div>\n            <div id=\"mxMediaArea\">\n              <label class=\"drop\" id=\"mxPhotoDrop\"><input type=\"file\" id=\"mxPhotoInput\" accept=\"image/*\" multiple><span>Tap to add photos (or drop them here)</span></label>\n              <ol class=\"photos\" id=\"mxPhotos\"></ol>\n              <legend style=\"margin-top:6px\">Documents for the MLS</legend>\n              <div class=\"docs-upload\">\n                <div><label for=\"mxDocCat\">Document type</label><select id=\"mxDocCat\"></select></div>\n                <div><label for=\"mxDocInput\">File (max 20 MB)</label><input type=\"file\" id=\"mxDocInput\" multiple accept=\".pdf,.doc,.docx,.jpg,.jpeg,.png\"></div>\n                <span class=\"muted\" style=\"font-size:12px;align-self:center\">Uploads start as soon as you pick a file.</span>\n              </div>\n              <div id=\"mxDocs\"></div>\n            </div>\n          </fieldset>\n\n          <div id=\"mxIssues\"></div>\n          <div class=\"mx-actions\">\n            <button class=\"btn\" type=\"button\" id=\"mxPdfBtn\">Download PDF</button>\n            <button class=\"btn primary\" type=\"button\" id=\"mxSendBtn\">Send to Matrix</button>\n          </div>\n          <p class=\"muted\" style=\"font-size:12px;text-align:right;margin:6px 0 0\">Send to Matrix enters the listing in Matrix as <b>Incomplete</b> for review. It is never submitted to the MLS automatically.</p>\n        </div>\n      </div>\n\n      <div class=\"savebar\">\n        <button class=\"btn\" type=\"button\" data-go=\"list\">Cancel</button>\n        <button class=\"btn primary\" type=\"submit\" id=\"saveBtn\">Save deal</button>\n      </div>\n    </form>\n  </section>\n</main>\n\n<div id=\"toast\" class=\"hidden\"></div>\n\n<script>\n(function () {\n  'use strict';\n\n  // ---------- server bridge ----------\n  function call(fn) {\n    var args = Array.prototype.slice.call(arguments, 1);\n    return new Promise(function (resolve, reject) {\n      google.script.run\n        .withSuccessHandler(resolve)\n        .withFailureHandler(function (err) {\n          var msg = (err && err.message) || String(err);\n          if (msg.indexOf('SESSION_EXPIRED') >= 0) { clearToken(); show('login'); msg = 'Your session expired. Please sign in again.'; }\n          reject(new Error(msg));\n        })[fn].apply(null, args);\n    });\n  }\n\n  // ---------- state ----------\n  var CFG = null, TOKEN = null, USER = null, DEALS = [], CURRENT = null;\n  var $ = function (id) { return document.getElementById(id); };\n  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }\n  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }\n  function clearToken() { TOKEN = null; store('dt_token', null); store('dt_user', null); }\n  function esc(s) { return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]; }); }\n\n  function toast(msg, isErr) {\n    var t = $('toast'); t.textContent = msg; t.className = isErr ? 'err' : '';\n    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = 'hidden'; }, isErr ? 6000 : 3500);\n  }\n  function busy(btn, on, text) {\n    if (on) { btn._txt = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class=\"spinner\"></span>' + (text || 'Working\u2026'); }\n    else { btn.disabled = false; if (btn._txt) btn.innerHTML = btn._txt; }\n  }\n  function show(view) {\n    ['login', 'list', 'picker', 'editor'].forEach(function (v) { $(v).classList.toggle('hidden', v !== view); });\n    $('logoutBtn').classList.toggle('hidden', view === 'login' || !TOKEN);\n    window.scrollTo(0, 0);\n  }\n\n  // ---------- boot ----------\n  call('getAppConfig').then(function (cfg) {\n    CFG = cfg;\n    $('appTitle').textContent = cfg.appName;\n    cfg.sides.forEach(function (s) { $('fSide').insertAdjacentHTML('beforeend', '<option>' + s + '</option>'); });\n    cfg.statuses.forEach(function (s) {\n      $('fStatus').insertAdjacentHTML('beforeend', '<option>' + s + '</option>');\n      $('edStatus').insertAdjacentHTML('beforeend', '<option>' + s + '</option>');\n    });\n    document.body.insertAdjacentHTML('beforeend', '<datalist id=\"rosterList\">' + (cfg.roster || []).map(function (n) { return '<option value=\"' + esc(n) + '\">'; }).join('') + '</datalist>');\n    TOKEN = load('dt_token');\n    try { USER = JSON.parse(load('dt_user') || 'null'); } catch (e) { USER = null; }\n    if (TOKEN && USER) return enterApp();\n    return call('tryAutoLogin').then(function (s) { if (s) { setSession(s); enterApp(); } else show('login'); });\n  }).catch(function (e) { show('login'); toast(e.message, true); });\n\n  function setSession(s) { TOKEN = s.token; USER = s.user; store('dt_token', TOKEN); store('dt_user', JSON.stringify(USER)); }\n\n  $('loginForm').addEventListener('submit', function (ev) {\n    ev.preventDefault();\n    var btn = $('loginBtn'); busy(btn, true, 'Signing in\u2026');\n    call('login', $('loginEmail').value, $('loginPin').value)\n      .then(function (s) { setSession(s); $('loginPin').value = ''; enterApp(); })\n      .catch(function (e) { toast(e.message, true); })\n      .then(function () { busy(btn, false); });\n  });\n\n  $('logoutBtn').addEventListener('click', function () { call('logout', TOKEN).catch(function () {}); clearToken(); USER = null; $('who').textContent = ''; show('login'); });\n\n  function enterApp() {\n    $('who').textContent = USER.name ? USER.name + (USER.isAdmin ? ' \u00b7 Admin' : '') : USER.email;\n    $('listTitle').textContent = USER.isAdmin ? 'All deals' : 'My deals';\n    $('fAgent').classList.toggle('hidden', !USER.isAdmin);\n    $('filters').classList.toggle('admin', !!USER.isAdmin);\n    if (USER.isAdmin) call('listAgentsForAdmin', TOKEN).then(function (a) { AGENTS = a || []; }).catch(function () {});\n    show('list');\n    return refreshList();\n  }\n\n  var AGENTS = [];\n  function fillAgentPicker(deal) {\n    var wrap = $('edAgentWrap');\n    wrap.classList.toggle('hidden', !USER.isAdmin);\n    if (!USER.isAdmin) return;\n    var cur = deal.agent_email || '';\n    var list = AGENTS.slice();\n    if (cur && !list.some(function (a) { return a.email === cur; })) list.unshift({ name: deal.agent_name || cur, email: cur, office: '' });\n    $('edAgent').innerHTML = '<option value=\"\">\u2014 Choose the agent \u2014</option>' + list.map(function (a) {\n      var label = a.name + (a.office ? ' \u00b7 ' + a.office : '') + (a.isAdmin ? ' (admin)' : '') + (a.email ? '' : ' (no email in Agents tab yet)');\n      return '<option value=\"' + esc(a.email) + '\"' + (a.email ? '' : ' disabled') + (a.email === cur ? ' selected' : '') + '>' + esc(label) + '</option>';\n    }).join('');\n  }\n  $('edAgent').addEventListener('change', function () {\n    var a = AGENTS.filter(function (x) { return x.email === $('edAgent').value; })[0];\n    if (a && a.office && $('f_office')) $('f_office').value = a.office;\n  });\n\n  // ---------- list ----------\n  function refreshList() {\n    $('deals').innerHTML = '<div class=\"empty\"><span class=\"spinner\"></span>Loading deals\u2026</div>';\n    return call('listDeals', TOKEN).then(function (deals) {\n      DEALS = deals || [];\n      if (USER.isAdmin) {\n        var agents = {}; DEALS.forEach(function (d) { agents[d.agent_email] = d.agent_name || d.agent_email; });\n        var cur = $('fAgent').value;\n        $('fAgent').innerHTML = '<option value=\"\">All agents</option>' + Object.keys(agents).sort().map(function (e) { return '<option value=\"' + esc(e) + '\">' + esc(agents[e]) + '</option>'; }).join('');\n        $('fAgent').value = cur;\n      }\n      renderList();\n    }).catch(function (e) { $('deals').innerHTML = '<div class=\"empty\">' + esc(e.message) + '</div>'; });\n  }\n\n  ['fSearch', 'fSide', 'fStatus', 'fAgent'].forEach(function (id) { $(id).addEventListener('input', renderList); });\n\n  function renderList() {\n    var q = $('fSearch').value.trim().toLowerCase(), side = $('fSide').value, st = $('fStatus').value, ag = $('fAgent').value;\n    var rows = DEALS.filter(function (d) {\n      if (side && d.side !== side) return false;\n      if (st && d.status !== st) return false;\n      if (ag && d.agent_email !== ag) return false;\n      if (q && [d.address, d.city, d.client_name, d.deal_id, d.agent_name].join(' ').toLowerCase().indexOf(q) < 0) return false;\n      return true;\n    });\n    var c = { active: 0, pending: 0, sold: 0 };\n    DEALS.forEach(function (d) {\n      if (d.status === 'Active' || d.status === 'Coming Soon') c.active++;\n      else if (['Accepted Offer', 'Under Contract', 'Closing Set'].indexOf(d.status) >= 0) c.pending++;\n      else if (d.status === 'Sold') c.sold++;\n    });\n    $('stats').innerHTML = [['Total', DEALS.length], ['Active / coming soon', c.active], ['Accepted / in contract', c.pending], ['Sold / leased', c.sold]]\n      .map(function (s) { return '<div class=\"stat\"><b>' + s[1] + '</b><span>' + s[0] + '</span></div>'; }).join('');\n\n    if (!rows.length) {\n      $('deals').innerHTML = '<div class=\"empty card\">' + (DEALS.length ? 'No deals match those filters.' : 'No deals yet. Tap <b>+ New deal</b> to add your first one.') + '</div>';\n      return;\n    }\n    $('deals').innerHTML = rows.map(function (d) {\n      var done = parseInt(String(d.milestones_done || '0'), 10) || 0, total = d.milestones_total || 1;\n      return '<div class=\"card deal\" data-id=\"' + esc(d.deal_id) + '\" tabindex=\"0\">' +\n        '<div><span class=\"badge b-' + esc(d.side) + '\">' + esc(d.side) + '</span> <span class=\"addr\">' + esc(d.address) + '</span>' +\n        '<div class=\"meta\">' + esc(d.client_name) + (d.city ? ' \u00b7 ' + esc(d.city) : '') + (USER.isAdmin ? ' \u00b7 ' + esc(d.agent_name || d.agent_email) : '') + ' \u00b7 ' + esc(d.deal_id) + '</div></div>' +\n        '<div style=\"text-align:right\"><span class=\"status s-' + esc(String(d.status).split(' ')[0]) + '\">' + esc(d.status) + '</span><div style=\"margin-top:6px\">' + skyChip(d.skyslope_status) + '</div>' +\n        (d.open_change ? '<div style=\"margin-top:4px\"><span class=\"sky wait\">' + esc(d.open_change) + '</span></div>' : '') +\n        (d.matrix_status && d.matrix_status !== 'Draft' ? '<div style=\"margin-top:4px\"><span class=\"sky ' + (/queued/i.test(d.matrix_status) ? 'wait' : /entered|active|live/i.test(d.matrix_status) ? 'ok' : 'err') + '\">Matrix: ' + esc(d.matrix_status) + '</span></div>' : '') + '</div>' +\n        '<div class=\"meta\" style=\"grid-column:1/-1\">Next: <b style=\"color:#374151\">' + esc(d.next_milestone || '') + '</b>' +\n        (d.current_milestone_date ? ' \u00b7 Last update ' + esc(d.current_milestone_date) : '') + (d.closing_date ? ' \u00b7 Closing ' + esc(d.closing_date) : '') + '</div>' +\n        '<div class=\"bar\"><i style=\"width:' + Math.round(done / total * 100) + '%\"></i></div></div>';\n    }).join('');\n  }\n\n  $('deals').addEventListener('click', function (ev) { var el = ev.target.closest('.deal'); if (el) openDeal(el.getAttribute('data-id')); });\n  $('deals').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { var el = ev.target.closest('.deal'); if (el) openDeal(el.getAttribute('data-id')); } });\n\n  document.addEventListener('click', function (ev) {\n    var go = ev.target.closest('[data-go]');\n    if (go) { ev.preventDefault(); show(go.getAttribute('data-go')); if (go.getAttribute('data-go') === 'list') renderList(); }\n  });\n  $('newDealBtn').addEventListener('click', function () { show('picker'); });\n  Array.prototype.forEach.call(document.querySelectorAll('.side-tile'), function (b) {\n    b.addEventListener('click', function () { openEditor({ side: b.getAttribute('data-side'), status: 'Active', milestones: {}, office: USER.office }); });\n  });\n\n  // ---------- editor ----------\n  function openDeal(id) {\n    toast('Opening deal\u2026');\n    call('getDeal', TOKEN, id).then(openEditor).catch(function (e) { toast(e.message, true); });\n  }\n\n  function labelFor(f, side) { return (f.labels && f.labels[side]) || f.label; }\n  function optionsFor(f, side) { return f.optionsBySide ? (f.optionsBySide[side] || []) : (f.options || []); }\n  function isReq(f, side) { return f.req === true || (Array.isArray(f.req) && f.req.indexOf(side) >= 0); }\n  function skyChip(st) {\n    if (!st) return '';\n    var cls = /created|complete/i.test(st) ? 'ok' : /error|review/i.test(st) ? 'err' : 'wait';\n    return '<span class=\"sky ' + cls + '\">SkySlope: ' + esc(st) + '</span>';\n  }\n  function addrOf(d) { return [d.street_number, d.direction, d.street_name].filter(Boolean).join(' ') + (d.unit ? ' #' + d.unit : ''); }\n\n  function openEditor(deal) {\n    CURRENT = deal;\n    var side = deal.side;\n    $('edSide').textContent = side; $('edSide').className = 'badge b-' + side;\n    $('edTitle').textContent = deal.deal_id ? (addrOf(deal) || ([deal.client_first, deal.client_last].filter(Boolean).join(' ') + ' (no property yet)')) : 'New ' + side.toLowerCase() + ' deal';\n    $('edStatus').value = deal.status || 'Active';\n    fillAgentPicker(deal);\n    $('edMeta').innerHTML = deal.deal_id\n      ? esc(deal.deal_id + ' \u00b7 ' + (deal.agent_name || deal.agent_email) + ' \u00b7 last updated ' + (deal.updated_at || '').replace('T', ' ')) + ' &nbsp;' + skyChip(deal.skyslope_status) +\n        (deal.skyslope_file ? ' <a href=\"' + esc(deal.skyslope_file) + '\" target=\"_blank\" rel=\"noopener\">Open in SkySlope</a>' : '')\n      : 'Fields marked * are required. Fill in whatever else you have now and add the rest as the deal moves along.';\n    $('saveBtn').textContent = deal.deal_id ? 'Save changes' : 'Submit deal';\n\n    // Details\n    var sections = [];\n    CFG.fields.forEach(function (f) {\n      if (f.sides.indexOf(side) < 0) return;\n      var sec = sections.filter(function (s) { return s.name === f.section; })[0];\n      if (!sec) { sec = { name: f.section, fields: [] }; sections.push(sec); }\n      sec.fields.push(f);\n    });\n    $('detailsPane').innerHTML = sections.map(function (s) {\n      return '<fieldset><legend>' + esc(s.name) + '</legend><div class=\"grid\">' + s.fields.map(function (f) { return fieldHtml(f, side, deal[f.key], !deal.deal_id); }).join('') + '</div></fieldset>';\n    }).join('');\n\n    // Milestones\n    var list = CFG.milestones[side] || [];\n    var ms = deal.milestones || {};\n    $('msList').innerHTML = list.map(function (m) {\n      var s = ms[m.key] || {};\n      return '<div class=\"ms' + (s.done ? ' done' : '') + '\" data-ms=\"' + m.key + '\">' +\n        '<input type=\"checkbox\" id=\"ms_' + m.key + '\"' + (s.done ? ' checked' : '') + '>' +\n        '<label for=\"ms_' + m.key + '\" class=\"ml\" style=\"margin:0\">' + esc(m.label) + '</label>' +\n        '<input type=\"date\" aria-label=\"' + esc(m.label) + ' date\" value=\"' + esc(s.date || '') + '\">' +\n        '<input class=\"note\" placeholder=\"Note (optional)\" value=\"' + esc(s.note || '') + '\"></div>';\n    }).join('');\n    updateMsProgress();\n\n    // Docs\n    $('docsLocked').classList.toggle('hidden', !!deal.deal_id);\n    $('docsArea').classList.toggle('hidden', !deal.deal_id);\n    renderDocs(deal.documents || []);\n\n    mxOpen(deal);\n    chgOpen(deal);\n\n    setTab('details');\n    show('editor');\n    updateStageMarks();\n  }\n\n  function fieldHtml(f, side, val, isNew) {\n    var id = 'f_' + f.key, v = val == null ? '' : val, required = isReq(f, side), req = required ? ' required' : '';\n    if (isNew && v === '') v = f.default || (f.optionsBySide ? '' : '');\n    var wide = f.type === 'textarea' || f.key === 'checklist_type' || f.key === 'represent_both' ? ' wide' : '';\n    var lab = '<label for=\"' + id + '\" class=\"' + (required ? 'req' : '') + '\">' + esc(labelFor(f, side)) + '</label>';\n    var helpText = (f.helpBySide && f.helpBySide[side]) || f.help;\n    var help = helpText ? '<span class=\"help\">' + esc(helpText) + '</span>' : '';\n    var input;\n    if (f.type === 'select') {\n      var opts = optionsFor(f, side);\n      input = '<select id=\"' + id + '\" name=\"' + f.key + '\"' + req + '><option value=\"\">\u2014</option>' +\n        opts.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';\n    } else if (f.type === 'roster') {\n      input = '<input id=\"' + id + '\" name=\"' + f.key + '\" list=\"rosterList\" autocomplete=\"off\" placeholder=\"Start typing a name\" value=\"' + esc(v) + '\">';\n    } else if (f.type === 'textarea') {\n      input = '<textarea id=\"' + id + '\" name=\"' + f.key + '\"' + req + '>' + esc(v) + '</textarea>';\n    } else {\n      var type = { money: 'text', number: 'text', date: 'date', email: 'email', tel: 'tel' }[f.type] || 'text';\n      var mode = f.type === 'money' || f.type === 'number' ? ' inputmode=\"decimal\"' : '';\n      var ph = f.type === 'money' ? ' placeholder=\"$\"' : '';\n      input = '<input id=\"' + id + '\" name=\"' + f.key + '\" type=\"' + type + '\"' + mode + ph + req + ' value=\"' + esc(v) + '\">';\n      if (f.key === 'mls_number') input = '<div class=\"mlsrow\">' + input + '<button type=\"button\" class=\"btn\" id=\"mlsFind\">Find address</button></div>';\n    }\n    return '<div class=\"' + wide.trim() + '\">' + lab + input + help + '</div>';\n  }\n\n  $('msList').addEventListener('change', function (ev) {\n    var row = ev.target.closest('.ms'); if (!row) return;\n    var cb = row.querySelector('input[type=checkbox]'), date = row.querySelector('input[type=date]');\n    if (ev.target === cb && cb.checked && !date.value) date.value = todayStr();\n    if (ev.target === date && date.value && !cb.checked) cb.checked = true;\n    row.classList.toggle('done', cb.checked);\n    // Checking \"Accepted offer\" / \"Contract fully signed\" (or the lease versions) fills that date on Deal details\n    var m = (CFG.milestones[CURRENT.side] || []).filter(function (x) { return x.key === row.getAttribute('data-ms'); })[0];\n    var target = m && { 'Accepted Offer': 'f_acceptance_date', 'Under Contract': 'f_contract_date' }[m.status];\n    if (cb.checked && target && $(target) && !$(target).value && date.value) $(target).value = date.value;\n    updateMsProgress();\n    updateStageMarks();\n  });\n\n  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }\n\n  // ---------- stage requirements (rules come from the server) ----------\n  function fieldVal(k) { var el = $('f_' + k); return el ? el.value.trim() : ''; }\n  function filledKey(k) { var p = k.split('='); var v = fieldVal(p[0]); return p.length > 1 ? v === p[1] : v !== ''; }\n  function commissionGroups(side) {\n    var listing = ['listing_comm_pct', 'listing_comm_amt'], buying = ['sale_comm_pct', 'sale_comm_amt'];\n    if (fieldVal('represent_both') === 'Yes') return [listing, buying];\n    return (side === 'Seller' || side === 'Landlord') ? [listing] : [buying];\n  }\n  function stageCheck() {\n    if (!CURRENT) return { stage: '', missing: [], keys: [] };\n    var side = CURRENT.side, st = $('edStatus').value, R = CFG.statusRank || {};\n    if (st === 'Cancelled' || st === 'TOM' || st === 'Withdrawn') return { stage: '', missing: [], keys: [] };\n    var rank = R[st] || 0;\n    (CFG.milestones[side] || []).forEach(function (m) {\n      var cb = $('ms_' + m.key);\n      if (m.status && cb && cb.checked) rank = Math.max(rank, R[m.status] || 0);\n    });\n    var stage = '', missing = [], keys = [];\n    Object.keys(CFG.stageRules || {}).forEach(function (name) {\n      if (!rank || rank < R[name]) return;\n      stage = name;\n      CFG.stageRules[name].forEach(function (rule) {\n        var groups = rule.commission ? commissionGroups(side) : rule.anyOf;\n        var ok = rule.commission\n          ? groups.every(function (alts) { return alts.some(filledKey); })\n          : groups.some(function (g) { return g.every(filledKey); });\n        if (!ok) {\n          if (missing.indexOf(rule.label) < 0) missing.push(rule.label);\n          groups.forEach(function (g) { g.forEach(function (k) { keys.push(k.split('=')[0]); }); });\n        }\n      });\n    });\n    return { stage: stage, missing: missing, keys: keys };\n  }\n  function updateStageMarks() {\n    var r = stageCheck(), b = $('stageBanner');\n    Array.prototype.forEach.call(document.querySelectorAll('#detailsPane .need'), function (el) { el.classList.remove('need'); });\n    r.keys.forEach(function (k) { var el = $('f_' + k); if (el) el.closest('#detailsPane > fieldset > .grid > div').classList.add('need'); });\n    if (!r.stage) { b.classList.add('hidden'); return r; }\n    b.classList.remove('hidden');\n    b.classList.toggle('ok', !r.missing.length);\n    b.innerHTML = r.missing.length\n      ? '<b>' + esc(r.stage) + '</b>: still needed before you can save: ' + esc(r.missing.join(' \u00b7 ')) + '. Those fields are highlighted on Deal details.'\n      : '<b>' + esc(r.stage) + '</b>: everything this stage needs is filled in.';\n    return r;\n  }\n  $('edStatus').addEventListener('change', updateStageMarks);\n  $('detailsPane').addEventListener('input', updateStageMarks);\n  $('detailsPane').addEventListener('change', updateStageMarks);\n  $('detailsPane').addEventListener('click', function (ev) {\n    if (ev.target.id !== 'mlsFind') return;\n    var mls = fieldVal('mls_number');\n    if (!mls) { toast('Type the MLS # first.', true); return; }\n    var btn = ev.target; busy(btn, true, 'Looking\u2026');\n    call('lookupMls', TOKEN, mls).then(function (f) {\n      if (!f) { toast('MLS # ' + mls + ' isn\\'t on the office inventory yet. Type the address, or save with just the MLS #: the SkySlope file will import the address from the MLS.', true); return; }\n      var filled = [];\n      [['street_number', 'street_number'], ['street_name', 'street_name'], ['city', 'city'], ['list_price', 'list_price']].forEach(function (p) {\n        var el = $('f_' + p[0]); if (el && !el.value.trim() && f[p[1]]) { el.value = f[p[1]]; filled.push(p[0].replace('_', ' ')); }\n      });\n      toast(filled.length ? 'Filled ' + filled.join(', ') + ' from ' + f.source + '.' : 'Found on ' + f.source + '; your address fields were already filled.');\n      updateStageMarks();\n    }).catch(function (e) { toast(e.message, true); }).then(function () { busy(btn, false); });\n  });\n\n  function updateMsProgress() {\n    var rows = document.querySelectorAll('#msList .ms'), done = document.querySelectorAll('#msList .ms.done').length;\n    $('msBar').style.width = rows.length ? Math.round(done / rows.length * 100) + '%' : '0';\n    $('msCount').textContent = '(' + done + '/' + rows.length + ')';\n  }\n\n  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {\n    t.addEventListener('click', function () { setTab(t.getAttribute('data-tab')); });\n  });\n  function setTab(name) {\n    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.classList.toggle('on', t.getAttribute('data-tab') === name); });\n    Array.prototype.forEach.call(document.querySelectorAll('[data-pane]'), function (p) { p.classList.toggle('hidden', p.getAttribute('data-pane') !== name); });\n    if (name === 'mls' && MX && mxSchema() && !MX.loading) mxRender();\n  }\n\n  $('dealForm').addEventListener('submit', function (ev) {\n    ev.preventDefault();\n    var side = CURRENT.side, fields = {}, missing = [];\n    CFG.fields.forEach(function (f) {\n      if (f.sides.indexOf(side) < 0) return;\n      var el = $('f_' + f.key); var v = el ? el.value.trim() : '';\n      fields[f.key] = v;\n      if (el) el.style.borderColor = '';\n      if (isReq(f, side) && !v) { missing.push(labelFor(f, side)); if (el) el.style.borderColor = 'var(--bad)'; }\n    });\n    if (USER.isAdmin && !$('edAgent').value) missing.unshift('Agent on this deal');\n    var sc = updateStageMarks();\n    if (!missing.length && sc.missing.length) { setTab('details'); toast(sc.stage + ': please fill in ' + sc.missing.join(', '), true); return; }\n    if (missing.length) { setTab('details'); toast('Please fill in: ' + missing.join(', '), true); return; }\n\n    var milestones = {};\n    Array.prototype.forEach.call(document.querySelectorAll('#msList .ms'), function (row) {\n      milestones[row.getAttribute('data-ms')] = {\n        done: row.querySelector('input[type=checkbox]').checked,\n        date: row.querySelector('input[type=date]').value,\n        note: row.querySelector('.note').value\n      };\n    });\n\n    var btn = $('saveBtn'); busy(btn, true, 'Saving\u2026');\n    call('saveDeal', TOKEN, { deal_id: CURRENT.deal_id || '', side: side, status: $('edStatus').value, fields: fields, milestones: milestones, agent_email: USER.isAdmin ? $('edAgent').value : '' })\n      .then(function (res) {\n        if (MX && MX.type && MX.dirty) {\n          return call('saveMatrixListing', TOKEN, res.deal_id, { type: MX.type, data: MX.data, media: mxMediaPayload() })\n            .then(function () { return res; })\n            .catch(function (e) { toast('Deal saved, but the MLS listing was not: ' + e.message, true); return res; });\n        }\n        return res;\n      })\n      .then(function (res) {\n        var msg = res.isNew ? 'Deal submitted (' + res.deal_id + '). Queued for SkySlope.' : 'Changes saved.';\n        if (res.status && res.status !== $('edStatus').value) msg += ' Status moved to ' + res.status + '.';\n        if (res.inventory && !res.inventory.ok) toast(msg + ' Office inventory note: ' + res.inventory.message, true); else toast(msg);\n        return call('getDeal', TOKEN, res.deal_id).then(function (d) {\n          var tab = document.querySelector('.tab.on').getAttribute('data-tab');\n          openEditor(d); setTab(tab); refreshListQuiet();\n        });\n      })\n      .catch(function (e) { toast(e.message, true); })\n      .then(function () { busy(btn, false); btn.textContent = CURRENT && CURRENT.deal_id ? 'Save changes' : 'Submit deal'; });\n  });\n\n  function refreshListQuiet() { call('listDeals', TOKEN).then(function (d) { DEALS = d || []; }).catch(function () {}); }\n\n  // ---------- documents ----------\n  function renderDocs(docs) {\n    $('docList').innerHTML = docs.length ? docs.map(function (d) {\n      var sentOk = d.status === 'Sent to SkySlope';\n      var chip = '<span class=\"sky ' + (sentOk ? 'ok' : d.status === 'Error' ? 'err' : 'wait') + '\">' + esc(sentOk ? 'In SkySlope' : d.status === 'Error' ? 'Error: Mac has been told' : 'Waiting for SkySlope file') + '</span>';\n      return '<div class=\"doc\"><div><b>' + esc(d.name) + '</b><div class=\"muted\" style=\"font-size:12px\">' + esc(d.category) + '</div></div>' +\n        '<div style=\"text-align:right\"><div>' + chip + '</div><div class=\"muted\" style=\"font-size:12px;white-space:nowrap;margin-top:4px\">' + esc(String(d.sent_at || d.uploaded || '').slice(0, 10)) + '</div></div></div>';\n    }).join('') : '<p class=\"muted\">No documents uploaded yet.</p>';\n    var hasFile = CURRENT && /@skyslope\\.com$/i.test(String(CURRENT.skyslope_email || ''));\n    $('docsHelp').textContent = hasFile\n      ? 'Uploads go straight into this deal\\'s SkySlope file (Documents tab).'\n      : 'Uploads go straight into this deal\\'s SkySlope file. The file is being opened now; anything you upload before then is sent automatically as soon as it is.';\n  }\n\n  $('uploadBtn').addEventListener('click', function () {\n    var files = Array.prototype.slice.call($('docFile').files || []);\n    if (!files.length) { toast('Choose a file first.', true); return; }\n    var big = files.filter(function (f) { return f.size > CFG.maxUploadBytes; });\n    if (big.length) { toast(big[0].name + ' is over 20 MB.', true); return; }\n    var btn = $('uploadBtn'); busy(btn, true, 'Uploading\u2026');\n    var cat = $('docCat').value;\n    files.reduce(function (p, file) {\n      return p.then(function () {\n        return readB64(file).then(function (data) {\n          return call('uploadDocument', TOKEN, CURRENT.deal_id, { name: file.name, mimeType: file.type, data: data, category: cat });\n        }).then(renderDocs);\n      });\n    }, Promise.resolve())\n      .then(function () { $('docFile').value = ''; toast(files.length + ' file' + (files.length > 1 ? 's' : '') + (/@skyslope\\.com$/i.test(String(CURRENT.skyslope_email || '')) ? ' sent to SkySlope.' : ' queued for SkySlope.')); })\n      .catch(function (e) { toast(e.message, true); })\n      .then(function () { busy(btn, false); });\n  });\n\n  function readB64(file) {\n    return new Promise(function (resolve, reject) {\n      var r = new FileReader();\n      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };\n      r.onerror = function () { reject(new Error('Could not read ' + file.name)); };\n      r.readAsDataURL(file);\n    });\n  }\n\n  // =====================================================================\n  // LISTING CHANGES \u2014 price change, TOM, back on market, withdraw, cancel, extend\n  // =====================================================================\n  var CHG = { type: '', list: [] };\n\n  function chgOpen(deal) {\n    var show = mxIsListingSide(deal.side) && !!deal.deal_id;\n    $('chgTabBtn').classList.toggle('hidden', !show);\n    CHG = { type: '', list: [] };\n    if (!show) return;\n    $('chgTypes').innerHTML = CFG.changes.types.map(function (t) {\n      return '<button type=\"button\" class=\"side-tile chg-tile\" data-chg=\"' + t.id + '\"><b>' + esc(t.name) + '</b><span>' + esc(t.form) + '</span></button>';\n    }).join('');\n    $('chgForm').innerHTML = '';\n    $('chgList').innerHTML = '<p class=\"muted\"><span class=\"spinner\"></span>Loading\u2026</p>';\n    chgNoMls();\n    call('listListingChanges', TOKEN, deal.deal_id).then(function (list) { if (CURRENT === deal) { CHG.list = list || []; chgRenderList(); } })\n      .catch(function (e) { $('chgList').innerHTML = '<p class=\"muted\">' + esc(e.message) + '</p>'; });\n  }\n\n  function chgNoMls() {\n    var noMls = !(CURRENT && CURRENT.mls_number);\n    $('chgNoMls').classList.toggle('hidden', !noMls);\n    $('chgTypes').classList.toggle('hidden', noMls);\n    return noMls;\n  }\n\n  function chgRenderList() {\n    var open = CHG.list.filter(function (c) { return c.open; })[0];\n    $('chgOpenNote').classList.toggle('hidden', !open);\n    if (open) $('chgOpenNote').innerHTML = '<b>' + esc(open.type_name) + '</b> is in progress. Finish or withdraw it before requesting another change.';\n    Array.prototype.forEach.call(document.querySelectorAll('.chg-tile'), function (b) { b.disabled = !!open; });\n    $('chgList').innerHTML = CHG.list.length ? CHG.list.map(function (c) {\n      var steps = [['Requested', true], ['Form prepared', c.skyslope_status !== 'Requested'], ['Signed', c.skyslope_status === 'Signed' || !!c.matrix_status],\n        ['Changed in Matrix', /^updated/i.test(c.matrix_status)], ['Deal updated', !!c.applied_at]];\n      if (/withdrawn/i.test(c.skyslope_status)) steps = [['Withdrawn', true]];\n      return '<div class=\"doc\" style=\"display:block\"><div class=\"row\" style=\"justify-content:space-between\">' +\n        '<div><b>' + esc(c.type_name) + '</b> \u00b7 ' + esc(c.summary) + '<div class=\"muted\" style=\"font-size:12px\">' + esc(String(c.requested_at).replace('T', ' ').slice(0, 16)) + ' \u00b7 ' + esc(c.requested_by) + '</div></div>' +\n        '<span class=\"sky ' + esc(c.stage.tone) + '\">' + esc(c.stage.label) + '</span></div>' +\n        '<div class=\"chg-steps\">' + steps.map(function (s) { return '<span class=\"' + (s[1] ? 'on' : '') + '\">' + (s[1] ? '\u2713 ' : '') + esc(s[0]) + '</span>'; }).join('') + '</div>' +\n        (c.signature_link && !c.matrix_status ? '<div style=\"margin-top:6px\"><a href=\"' + esc(c.signature_link) + '\" target=\"_blank\" rel=\"noopener\">Open the signature request in SkySlope</a>' +\n          (c.skyslope_status === 'Form Ready' ? ' <span class=\"muted\" style=\"font-size:12px\">\u00b7 review it and press Send</span>' : '') + '</div>' : '') +\n        (c.notes ? '<div class=\"muted\" style=\"font-size:12px;margin-top:4px\">' + esc(c.notes) + '</div>' : '') +\n        (c.open && c.skyslope_status !== 'Signed' && !c.matrix_status ? '<div style=\"margin-top:6px\"><button type=\"button\" class=\"btn\" data-chgwithdraw=\"' + esc(c.change_id) + '\">Withdraw this request</button></div>' : '') +\n        '</div>';\n    }).join('') : '<p class=\"muted\" style=\"margin:0\">No changes requested yet.</p>';\n  }\n\n  function chgField(label, html, help, wide) {\n    return '<div class=\"' + (wide ? 'wide' : '') + '\"><label class=\"req\">' + esc(label) + '</label>' + html + (help ? '<span class=\"help\">' + esc(help) + '</span>' : '') + '</div>';\n  }\n\n  function chgShowForm(id) {\n    var t = CFG.changes.types.filter(function (x) { return x.id === id; })[0];\n    CHG.type = id;\n    var d = CURRENT, today = todayStr();\n    var money = function (v) { return v ? '$' + Number(v).toLocaleString('en-US') : 'not entered'; };\n    var f = [];\n    f.push(chgField(id === 'withdraw' ? 'Date of withdrawal' : id === 'cancel' ? 'Date of cancellation' : 'Effective date',\n      '<input type=\"date\" id=\"chg_effective_date\" value=\"' + today + '\">'));\n    if (id === 'price') f.push(chgField('New price', '<input id=\"chg_new_price\" inputmode=\"decimal\" placeholder=\"$\">', 'Current list price: ' + money(d.list_price)));\n    if (id === 'back') f.push(chgField('Date it originally went off the market', '<input type=\"date\" id=\"chg_original_off_date\">', 'Coming back from ' + (d.status === 'Withdrawn' ? 'Withdrawn' : 'Temporarily Off Market') + '.'));\n    if (id === 'withdraw') {\n      f.push(chgField('Seller still owes the commission if it sells on or before', '<input type=\"date\" id=\"chg_protection_date\" value=\"' + esc(d.listing_expiration || '') + '\">', 'Usually the listing expiration date (' + (d.listing_expiration || 'not entered') + ').'));\n      f.push(chgField('Seller relists with us if offered again on or before', '<input type=\"date\" id=\"chg_relist_date\" value=\"' + esc(d.listing_expiration || '') + '\">'));\n    }\n    if (id === 'extend') {\n      var agr = (MX && MX.data && MX.data.listingAgreement) || '';\n      f.push(chgField('New expiration date', '<input type=\"date\" id=\"chg_new_expiration\">', 'Current expiration: ' + (d.listing_expiration || 'not entered on Deal details') + '.'));\n      f.push(chgField('Original listing agreement', '<select id=\"chg_agreement\"><option value=\"\">\u2014</option><option' + (agr !== 'Exclusive Agency' ? ' selected' : '') + '>Exclusive Right to Sell / Rent</option><option' + (agr === 'Exclusive Agency' ? ' selected' : '') + '>Exclusive Agency</option></select>'));\n      f.push('<div class=\"wide\"><label>Exceptions to the original terms</label><input id=\"chg_exceptions\" placeholder=\"None\"><span class=\"help\">Leave blank for \"None\".</span></div>');\n    }\n    if (id === 'other') f.push('<div class=\"wide\"><label class=\"req\">What exactly should change in Matrix?</label><textarea id=\"chg_note\"></textarea></div>');\n    else f.push('<div class=\"wide\"><label>Note for the office (optional)</label><input id=\"chg_note\"></div>');\n    if (id === 'withdraw' || id === 'cancel') f.push('<div class=\"wide\"><label style=\"font-weight:400;display:flex;gap:8px;align-items:flex-start\"><input type=\"checkbox\" id=\"chg_no_negotiations\" style=\"width:auto;margin-top:3px\"> I confirm there are no negotiations pending with anyone for the sale, lease or exchange of this property.</label></div>');\n    var signers = (t.ownerSigns ? 'the seller(s) (' + ([d.client_company || [d.client_first, d.client_last].filter(Boolean).join(' '), [d.client2_first, d.client2_last].filter(Boolean).join(' ')].filter(Boolean).join(' & ') || 'client on Deal details') + ')' : '') +\n      (t.firmSigns ? ' and the firm representative' : t.ownerSigns ? ' and you' : 'you');\n    $('chgForm').innerHTML = '<div class=\"card\" style=\"margin-top:12px;border-color:#c4b5fd\"><div class=\"row\" style=\"justify-content:space-between\"><b style=\"font-size:16px\">' + esc(t.name) + '</b><button type=\"button\" class=\"btn\" id=\"chgCancelForm\">Close</button></div>' +\n      '<p class=\"muted\" style=\"font-size:13px;margin:6px 0 12px\">' + esc(t.help) + '</p><div class=\"grid\">' + f.join('') + '</div>' +\n      '<p style=\"font-size:13px;margin:12px 0 0\"><b>What happens next:</b> the OneKey <b>' + esc(t.form) + '</b> is filled in from this deal in SkySlope for ' + esc(signers) + ' to sign. ' +\n      'Once it is signed, ' + esc(t.matrix.charAt(0).toLowerCase() + t.matrix.slice(1)) + ' in Matrix and the deal is updated. Nothing changes before the signature.</p>' +\n      '<div class=\"mx-actions\"><button type=\"button\" class=\"btn primary\" id=\"chgSubmit\">Request ' + esc(t.name.toLowerCase()) + '</button></div></div>';\n    $('chgForm').scrollIntoView({ behavior: 'smooth', block: 'start' });\n  }\n\n  $('chgPane').addEventListener('click', function (ev) {\n    var tile = ev.target.closest('[data-chg]');\n    if (tile && !tile.disabled) { chgShowForm(tile.getAttribute('data-chg')); return; }\n    if (ev.target.id === 'chgCancelForm') { $('chgForm').innerHTML = ''; CHG.type = ''; return; }\n    var wd = ev.target.closest('[data-chgwithdraw]');\n    if (wd) {\n      if (!confirm('Withdraw this request? If a signature request was already sent, void it in SkySlope.')) return;\n      busy(wd, true, 'Withdrawing\u2026');\n      call('withdrawListingChange', TOKEN, CURRENT.deal_id, wd.getAttribute('data-chgwithdraw'))\n        .then(function (list) { CHG.list = list; chgRenderList(); toast('Request withdrawn.'); refreshListQuiet(); })\n        .catch(function (e) { toast(e.message, true); busy(wd, false); });\n      return;\n    }\n    if (ev.target.id === 'chgSubmit') {\n      var v = function (k) { var el = $('chg_' + k); return el ? (el.type === 'checkbox' ? el.checked : el.value.trim()) : ''; };\n      var details = { effective_date: v('effective_date'), new_price: v('new_price'), original_off_date: v('original_off_date'),\n        protection_date: v('protection_date'), relist_date: v('relist_date'), new_expiration: v('new_expiration'),\n        agreement: v('agreement'), exceptions: v('exceptions'), note: v('note'), no_negotiations: v('no_negotiations') === true };\n      var btn = ev.target; busy(btn, true, 'Sending request\u2026');\n      call('requestListingChange', TOKEN, CURRENT.deal_id, { type: CHG.type, details: details })\n        .then(function () { return call('listListingChanges', TOKEN, CURRENT.deal_id); })\n        .then(function (list) { CHG.list = list; $('chgForm').innerHTML = ''; chgRenderList(); toast('Requested. The form is being prepared in SkySlope for signature.'); refreshListQuiet(); })\n        .catch(function (e) { toast(e.message, true); busy(btn, false); });\n    }\n  });\n\n  // =====================================================================\n  // MLS LISTING (OneKey Matrix input sheet) \u2014 Seller and Landlord deals\n  // =====================================================================\n  var MX = null; // { type, data, media, status, notes, thumbs, local, dirty, my_mls_id }\n  var COMP_RE = /\\b(commission|compensation|co-?broke|cobroke|bonus|buyer'?s? agent fee|\\d+(\\.\\d+)?\\s*%)/i;\n  // Deal fields that fill the matching Matrix field while it is still blank.\n  var MX_PREFILL = {\n    streetNumber: 'street_number', dirPrefix: 'direction', unitNumber: 'unit',\n    postOfficeTown: 'city', zip: 'zip', county: 'county', yearBuilt: 'year_built', listPrice: 'list_price',\n    leasePrice: 'list_price', listingContractDate: 'listing_date', expirationDate: 'listing_expiration',\n    securityDeposit: 'security_deposit', coListAgentName: 'co_agent'\n  };\n\n  // Matrix wants \"Oak\" in Street Name and \"Lane\" in Street Suffix; the deal has \"Oak Lane\" in one field.\n  var MX_SUFFIX = /^(.*\\S)\\s+(street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|place|pl|boulevard|blvd|way|terrace|ter|circle|cir|parkway|pkwy|highway|hwy|path|trail|trl|turnpike|tpke|loop|run|walk|row|square|sq|plaza|plz|crescent|cres|alley|aly|close|hollow|holw|knoll|lndg|landing|pass|point|pt|ridge|rdg|view|vw)\\.?$/i;\n  function mxSplitStreet(name) { var m = MX_SUFFIX.exec(String(name || '').trim()); return m ? [m[1], m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase()] : [String(name || '').trim(), '']; }\n\n  function mxIsListingSide(side) { return CFG.matrix && CFG.matrix.listingSides.indexOf(side) >= 0; }\n  function mxSchema() { var t = mxTypeDef(MX && MX.type); return t && t.schema ? CFG.matrix.schemas[t.schema] : null; }\n  function mxTypeDef(id) { return (CFG.matrix ? CFG.matrix.types : []).filter(function (t) { return t.id === id; })[0] || null; }\n  function mxFields() { var s = mxSchema(); return s ? s.sections.reduce(function (a, x) { return a.concat(x.fields); }, []) : []; }\n  function mxField(id) { return mxFields().filter(function (f) { return f.id === id; })[0] || null; }\n  function mxEmpty(v) {\n    if (v == null) return true;\n    if (Array.isArray(v)) return !v.length || v.every(function (x) { return x && typeof x === 'object' && Object.keys(x).every(function (k) { return mxEmpty(x[k]); }); });\n    return String(v).trim() === '';\n  }\n  function mxTest(c) {\n    if (!c) return true;\n    var v = MX.data[c.field];\n    if ('equals' in c) return v === c.equals;\n    if ('in' in c) return c['in'].indexOf(v) >= 0;\n    if ('includes' in c) return Array.isArray(v) && v.indexOf(c.includes) >= 0;\n    return true;\n  }\n  function mxSectionOf(f) { return mxSchema().sections.filter(function (s) { return s.fields.indexOf(f) >= 0; })[0]; }\n  function mxVisible(f) {\n    if (f.title) return mxTest(f.showIf);\n    var s = mxSectionOf(f);\n    return mxTest(s && s.showIf) && mxTest(f.showIf);\n  }\n\n  /** Called from openEditor for every deal. */\n  function mxOpen(deal) {\n    var listing = mxIsListingSide(deal.side);\n    $('mlsTabBtn').classList.toggle('hidden', !listing);\n    MX = null;\n    if (!listing) return;\n    var types = CFG.matrix.types.filter(function (t) { return t.side === deal.side; });\n    $('mxType').innerHTML = '<option value=\"\">\u2014 Choose \u2014</option>' + types.map(function (t) {\n      return '<option value=\"' + esc(t.id) + '\"' + (t.schema ? '' : ' disabled') + '>' + esc(t.name) + (t.schema ? '' : ' (input sheet needed)') + '</option>';\n    }).join('');\n    $('mxDocCat').innerHTML = CFG.matrix.docTypes.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');\n    MX = { type: '', data: {}, media: [], status: '', notes: '', thumbs: {}, local: {}, dirty: false, loading: !!deal.deal_id };\n    var ready = types.filter(function (t) { return t.schema; });\n    if (ready.length === 1) MX.type = ready[0].id; // Landlord: Rental is the only option today\n    if (deal.deal_id) {\n      $('mxForm').innerHTML = '<p class=\"muted\"><span class=\"spinner\"></span>Loading MLS listing\u2026</p>';\n      call('getMatrixListing', TOKEN, deal.deal_id).then(function (r) {\n        if (!MX || CURRENT !== deal) return;\n        MX.loading = false;\n        if (r.type) MX.type = r.type;\n        MX.data = r.data || {}; MX.media = r.media || []; MX.status = r.matrix_status; MX.notes = r.matrix_notes; MX.my_mls_id = r.my_mls_id;\n        mxRender();\n        if (MX.media.some(function (m) { return m.kind === 'photo'; })) {\n          call('matrixThumbs', TOKEN, deal.deal_id).then(function (t) { if (MX && CURRENT === deal) { MX.thumbs = t || {}; mxRenderPhotos(); } }).catch(function () {});\n        }\n      }).catch(function (e) { if (MX) { MX.loading = false; mxRender(); } toast(e.message, true); });\n    }\n    mxRender();\n  }\n\n  function mxPrefill() {\n    if (!MX || !mxSchema()) return;\n    var changed = false;\n    mxFields().forEach(function (f) {\n      if (!mxEmpty(MX.data[f.id])) return;\n      var v = '';\n      if (MX_PREFILL[f.id]) v = fieldVal(MX_PREFILL[f.id]);\n      if (f.id === 'streetName') v = mxSplitStreet(fieldVal('street_name'))[0];\n      if (f.id === 'streetSuffix') v = mxSplitStreet(fieldVal('street_name'))[1];\n      if (f.id === 'state') v = fieldVal('state') === 'New York' || !fieldVal('state') ? 'NY' : fieldVal('state');\n      if (f.id === 'ownersName') {\n        var c1 = fieldVal('client_company') || [fieldVal('client_first'), fieldVal('client_last')].filter(Boolean).join(' ');\n        var c2 = [fieldVal('client2_first'), fieldVal('client2_last')].filter(Boolean).join(' ');\n        v = [c1, c2].filter(Boolean).join(' & ');\n      }\n      if (f.id === 'listAgentName') v = (CURRENT && CURRENT.agent_name) || (!USER.isAdmin ? USER.name : '');\n      if (f.id === 'listAgentId' && MX.my_mls_id) v = MX.my_mls_id;\n      if (f.type === 'radio' && v && f.options.indexOf(v) < 0) v = '';\n      if (v) { MX.data[f.id] = v; changed = true; }\n    });\n    if (changed) MX.dirty = true;\n  }\n\n  // ---------- rendering ----------\n  function mxRender() {\n    if (!MX) return;\n    $('mxType').value = MX.type || '';\n    $('mxType').disabled = !!MX.loading;\n    mxRenderStatus();\n    var schema = mxSchema();\n    $('mxBody').classList.toggle('hidden', !schema || MX.loading);\n    if (!schema) { $('mxTabCount').textContent = ''; return; }\n    mxPrefill();\n    $('mxNav').style.top = (document.querySelector('header.top').offsetHeight || 52) + 'px';\n    $('mxForm').innerHTML = schema.sections.map(function (sec, i) {\n      return '<fieldset id=\"mxsec-' + i + '\"' + (mxVisible(sec) ? '' : ' class=\"hidden\"') + '><legend>' + esc(sec.title) + '</legend><div class=\"grid\">' +\n        sec.fields.map(mxFieldHtml).join('') + '</div></fieldset>';\n    }).join('');\n    Array.prototype.forEach.call(document.querySelectorAll('#mxForm [data-repeat]'), function (el) { mxRenderRepeat(el.getAttribute('data-repeat')); });\n    var locked = !(CURRENT && CURRENT.deal_id);\n    $('mxMediaLocked').classList.toggle('hidden', !locked);\n    $('mxMediaArea').classList.toggle('hidden', locked);\n    $('mxIssues').innerHTML = '';\n    mxRenderPhotos(); mxRenderDocs(); mxUpdate();\n  }\n\n  function mxRenderStatus() {\n    var st = MX && MX.status;\n    var cls = !st || st === 'Draft' ? '' : /queued/i.test(st) ? 'wait' : /entered|active|live/i.test(st) ? 'ok' : 'err';\n    $('mxStatus').innerHTML = st ? '<span class=\"sky ' + cls + '\">Matrix: ' + esc(st) + '</span>' + (MX.notes ? '<div class=\"help\" style=\"max-width:260px\">' + esc(MX.notes) + '</div>' : '') : '';\n  }\n\n  function mxFieldHtml(f) {\n    var v = MX.data[f.id], id = 'mx_' + f.id;\n    var lab = '<label for=\"' + id + '\" class=\"' + (f.req ? 'req' : '') + '\">' + esc(f.label) + '</label>';\n    var help = f.help ? '<span class=\"help\">' + esc(f.help) + '</span>' : '';\n    var input;\n    if (f.type === 'textarea') {\n      input = '<textarea id=\"' + id + '\" data-mx=\"' + f.id + '\" rows=\"' + (f.rows || 3) + '\">' + esc(v || '') + '</textarea>';\n    } else if (f.type === 'radio' || f.type === 'yesno') {\n      var opts = f.type === 'yesno' ? ['Yes', 'No'] : f.options;\n      input = '<div class=\"chips\" role=\"radiogroup\" id=\"' + id + '\">' + opts.map(function (o) {\n        return '<label class=\"chip\"><input type=\"radio\" name=\"' + id + '\" data-mx=\"' + f.id + '\" value=\"' + esc(o) + '\"' + (v === o ? ' checked' : '') + '><span>' + esc(o) + '</span></label>';\n      }).join('') + '</div>';\n    } else if (f.type === 'checks') {\n      var sel = Array.isArray(v) ? v : [];\n      input = (f.options.length > 14 ? '<input type=\"search\" class=\"opt-filter\" data-mxfilter=\"' + f.id + '\" placeholder=\"Filter ' + f.options.length + ' options\u2026\">' : '') +\n        '<div class=\"chips\" id=\"' + id + '\">' + f.options.map(function (o) {\n          return '<label class=\"chip\"><input type=\"checkbox\" data-mx=\"' + f.id + '\" value=\"' + esc(o) + '\"' + (sel.indexOf(o) >= 0 ? ' checked' : '') + '><span>' + esc(o) + '</span></label>';\n        }).join('') + '</div><span class=\"help\" data-mxcount=\"' + f.id + '\">' + (sel.length ? sel.length + ' selected' : '') + '</span>';\n    } else if (f.type === 'repeat') {\n      input = '<div class=\"rep\" data-repeat=\"' + f.id + '\"></div><button type=\"button\" class=\"btn\" data-mxadd=\"' + f.id + '\">+ ' + esc(f.addLabel || 'Add') + '</button>';\n    } else {\n      var t = { number: 'text', money: 'text', date: 'date', phone: 'tel', url: 'url' }[f.type] || 'text';\n      var mode = f.type === 'money' || f.type === 'number' ? ' inputmode=\"decimal\"' : '';\n      var ph = f.type === 'money' ? ' placeholder=\"$\"' : f.suffix ? ' placeholder=\"' + esc(f.suffix) + '\"' : '';\n      input = '<input id=\"' + id + '\" type=\"' + t + '\" data-mx=\"' + f.id + '\"' + mode + ph + ' value=\"' + esc(v == null ? '' : v) + '\">';\n    }\n    var wide = f.wide || ['textarea', 'checks', 'repeat', 'radio'].indexOf(f.type) >= 0 ? ' wide' : '';\n    return '<div class=\"mx-field' + wide + (mxVisible(f) ? '' : ' hidden') + '\" data-mxfield=\"' + f.id + '\">' + lab + help + input + '<div class=\"mx-err\" data-mxerr=\"' + f.id + '\"></div></div>';\n  }\n\n  function mxItemControl(f, sub, row, i) {\n    var v = row[sub.id], a = 'data-rep=\"' + f.id + '\" data-i=\"' + i + '\" data-k=\"' + sub.id + '\"';\n    if (sub.type === 'select' || sub.type === 'yesno') {\n      return '<select ' + a + '><option value=\"\">\u2014</option>' + (sub.type === 'yesno' ? ['Yes', 'No'] : sub.options).map(function (o) {\n        return '<option' + (v === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';\n    }\n    if (sub.type === 'textarea') return '<textarea ' + a + ' rows=\"2\">' + esc(v || '') + '</textarea>';\n    if (sub.type === 'checks') {\n      return '<div class=\"chips\">' + sub.options.map(function (o) {\n        return '<label class=\"chip\"><input type=\"checkbox\" ' + a + ' value=\"' + esc(o) + '\"' + ((v || []).indexOf(o) >= 0 ? ' checked' : '') + '><span>' + esc(o) + '</span></label>';\n      }).join('') + '</div>';\n    }\n    var t = sub.type === 'date' ? 'date' : 'text';\n    return '<input type=\"' + t + '\" ' + a + (sub.type === 'money' || sub.type === 'number' ? ' inputmode=\"decimal\"' : '') + (sub.type === 'money' ? ' placeholder=\"$\"' : '') + ' value=\"' + esc(v == null ? '' : v) + '\">';\n  }\n\n  function mxRenderRepeat(id) {\n    var f = mxField(id), rows = MX.data[id] || [], name = esc(f.itemLabel || 'Item');\n    document.querySelector('[data-repeat=\"' + id + '\"]').innerHTML = rows.map(function (row, i) {\n      return '<div class=\"rep-item\"><div class=\"rep-head\"><b>' + name + ' ' + (i + 1) + '</b>' +\n        '<button type=\"button\" class=\"icon-btn danger\" data-mxdel=\"' + id + '\" data-i=\"' + i + '\" aria-label=\"Remove ' + name + ' ' + (i + 1) + '\">\u00d7</button></div>' +\n        '<div class=\"grid\">' + f.item.map(function (sub) {\n          return '<div class=\"' + (sub.wide || sub.type === 'checks' || sub.type === 'textarea' ? 'wide' : '') + '\"><label>' + esc(sub.label) + '</label>' + mxItemControl(f, sub, row, i) + '</div>';\n        }).join('') + '</div></div>';\n    }).join('') || '<p class=\"muted\" style=\"margin:0\">None added yet.</p>';\n    var btn = document.querySelector('[data-mxadd=\"' + id + '\"]');\n    if (btn) btn.classList.toggle('hidden', f.max != null && rows.length >= f.max);\n  }\n\n  function mxUpdate() {\n    var schema = mxSchema(); if (!schema) return;\n    schema.sections.forEach(function (sec, i) { var el = $('mxsec-' + i); if (el) el.classList.toggle('hidden', !mxVisible(sec)); });\n    mxFields().forEach(function (f) { var el = document.querySelector('[data-mxfield=\"' + f.id + '\"]'); if (el) el.classList.toggle('hidden', !mxVisible(f)); });\n    var reqs = mxFields().filter(function (f) { return f.req && mxVisible(f); });\n    var done = reqs.filter(function (f) { return !mxEmpty(MX.data[f.id]); }).length;\n    var photos = MX.media.filter(function (m) { return m.kind === 'photo'; }).length;\n    $('mxBar').style.width = (reqs.length ? Math.round(done / reqs.length * 100) : 100) + '%';\n    $('mxProgText').textContent = done + ' of ' + reqs.length + ' required fields \u00b7 ' + photos + ' photo' + (photos === 1 ? '' : 's') + ' \u00b7 ' +\n      MX.media.filter(function (m) { return m.kind === 'doc'; }).length + ' document(s)' + (MX.dirty ? ' \u00b7 unsaved changes' : '');\n    $('mxTabCount').textContent = reqs.length ? '(' + Math.round(done / reqs.length * 100) + '%)' : '';\n    $('mxNav').innerHTML = schema.sections.map(function (sec, i) {\n      if (!mxVisible(sec)) return '';\n      var ok = sec.fields.filter(function (f) { return f.req && mxVisible(f); }).every(function (f) { return !mxEmpty(MX.data[f.id]); });\n      return '<a href=\"#mxsec-' + i + '\" class=\"' + (ok ? 'ok' : '') + '\">' + (ok ? '\u2713 ' : '') + esc(sec.title) + '</a>';\n    }).join('') + '<a href=\"#mxMedia\">Photos &amp; docs</a>';\n  }\n\n  // ---------- form events ----------\n  $('mxType').addEventListener('change', function () {\n    if (MX.type && !mxEmpty(MX.data) && Object.keys(MX.data).length > 6 &&\n        !confirm('Change the property type? Fields that the new type doesn\\'t have will be dropped when you save.')) { $('mxType').value = MX.type; return; }\n    MX.type = $('mxType').value; MX.dirty = true; mxRender();\n  });\n\n  $('mxForm').addEventListener('input', mxOnInput);\n  $('mxForm').addEventListener('change', mxOnInput);\n  function mxOnInput(ev) {\n    var t = ev.target;\n    if (t.getAttribute('data-mxfilter')) {\n      var q = t.value.toLowerCase();\n      Array.prototype.forEach.call(t.parentNode.querySelectorAll('.chip'), function (c) { c.classList.toggle('hidden', !!q && c.textContent.toLowerCase().indexOf(q) < 0); });\n      return;\n    }\n    var rep = t.getAttribute('data-rep');\n    if (rep) {\n      var row = MX.data[rep][+t.getAttribute('data-i')], k = t.getAttribute('data-k');\n      row[k] = t.type === 'checkbox'\n        ? Array.prototype.map.call(document.querySelectorAll('[data-rep=\"' + rep + '\"][data-i=\"' + t.getAttribute('data-i') + '\"][data-k=\"' + k + '\"]:checked'), function (x) { return x.value; })\n        : t.value;\n      MX.dirty = true; return;\n    }\n    var id = t.getAttribute('data-mx'); if (!id || t.type === 'radio') return;\n    if (t.type === 'checkbox') {\n      MX.data[id] = Array.prototype.map.call(document.querySelectorAll('[data-mx=\"' + id + '\"]:checked'), function (x) { return x.value; });\n      var c = document.querySelector('[data-mxcount=\"' + id + '\"]'); if (c) c.textContent = MX.data[id].length ? MX.data[id].length + ' selected' : '';\n    } else MX.data[id] = t.value;\n    var e = document.querySelector('[data-mxerr=\"' + id + '\"]'); if (e) e.textContent = '';\n    MX.dirty = true; mxUpdate();\n  }\n\n  $('mxForm').addEventListener('click', function (ev) {\n    var add = ev.target.closest('[data-mxadd]');\n    if (add) { var id = add.getAttribute('data-mxadd'); (MX.data[id] = MX.data[id] || []).push({}); MX.dirty = true; mxRenderRepeat(id); return; }\n    var del = ev.target.closest('[data-mxdel]');\n    if (del) { MX.data[del.getAttribute('data-mxdel')].splice(+del.getAttribute('data-i'), 1); MX.dirty = true; mxRenderRepeat(del.getAttribute('data-mxdel')); mxUpdate(); return; }\n    var t = ev.target;\n    if (t.type === 'radio' && t.getAttribute('data-mx')) { // tap a chosen chip again to clear it\n      var f = t.getAttribute('data-mx');\n      if (MX.data[f] === t.value) { t.checked = false; delete MX.data[f]; } else MX.data[f] = t.value;\n      var e = document.querySelector('[data-mxerr=\"' + f + '\"]'); if (e) e.textContent = '';\n      MX.dirty = true; mxUpdate();\n    }\n  });\n\n  $('mxNav').addEventListener('click', function (ev) {\n    var a = ev.target.closest('a'); if (!a) return;\n    ev.preventDefault();\n    var el = document.querySelector(a.getAttribute('href')); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });\n  });\n\n  // ---------- photos & documents ----------\n  function mxMediaPayload() { return MX.media.map(function (m) { return { id: m.id, caption: m.caption, category: m.category }; }); }\n\n  function mxRenderPhotos() {\n    var photos = MX.media.filter(function (m) { return m.kind === 'photo'; });\n    $('mxPhotos').innerHTML = photos.map(function (p, i) {\n      var src = MX.local[p.id] || MX.thumbs[p.id] || '';\n      return '<li class=\"photo\"><div class=\"thumb\">' + (src ? '<img alt=\"\" src=\"' + esc(src) + '\">' : '') + '<b>' + (i + 1) + (i === 0 ? ' \u00b7 Primary' : '') + '</b></div>' +\n        '<div><input type=\"text\" data-cap=\"' + esc(p.id) + '\" value=\"' + esc(p.caption) + '\" placeholder=\"Caption (optional)\">' +\n        '<div class=\"muted\" style=\"font-size:12px;margin:4px 0\">' + esc(p.name) + (p.size_kb ? ' \u00b7 ' + (p.size_kb / 1024).toFixed(1) + ' MB' : '') + '</div>' +\n        '<div class=\"row\" style=\"gap:6px\"><button type=\"button\" class=\"icon-btn\" data-pmove=\"' + esc(p.id) + '\" data-d=\"-1\"' + (i === 0 ? ' disabled' : '') + ' aria-label=\"Move up\">\u2191</button>' +\n        '<button type=\"button\" class=\"icon-btn\" data-pmove=\"' + esc(p.id) + '\" data-d=\"1\"' + (i === photos.length - 1 ? ' disabled' : '') + ' aria-label=\"Move down\">\u2193</button>' +\n        (i ? '<button type=\"button\" class=\"btn\" style=\"padding:6px 10px\" data-pfirst=\"' + esc(p.id) + '\">Make primary</button>' : '') +\n        '<button type=\"button\" class=\"icon-btn danger\" data-pdel=\"' + esc(p.id) + '\" aria-label=\"Remove photo\">\u00d7</button></div></div></li>';\n    }).join('');\n    if (mxSchema()) mxUpdate();\n  }\n\n  function mxRenderDocs() {\n    var docs = MX.media.filter(function (m) { return m.kind === 'doc'; });\n    $('mxDocs').innerHTML = docs.length ? docs.map(function (d) {\n      return '<div class=\"doc\"><div><b>' + esc(d.name) + '</b><div class=\"muted\" style=\"font-size:12px\">' + (d.size_kb ? (d.size_kb / 1024).toFixed(1) + ' MB' : '') + '</div></div>' +\n        '<div class=\"row\" style=\"gap:6px;flex-wrap:nowrap\"><select data-dcat=\"' + esc(d.id) + '\" style=\"width:auto\">' + CFG.matrix.docTypes.map(function (c) {\n          return '<option' + (c === d.category ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +\n        '<button type=\"button\" class=\"icon-btn danger\" data-pdel=\"' + esc(d.id) + '\" aria-label=\"Remove document\">\u00d7</button></div></div>';\n    }).join('') : '<p class=\"muted\" style=\"margin:0\">No documents yet.</p>';\n  }\n\n  function mxMovePhoto(id, to) {\n    var photos = MX.media.filter(function (m) { return m.kind === 'photo'; });\n    var from = photos.map(function (m) { return m.id; }).indexOf(id);\n    if (from < 0 || to < 0 || to >= photos.length) return;\n    var p = photos.splice(from, 1)[0]; photos.splice(to, 0, p);\n    MX.media = photos.concat(MX.media.filter(function (m) { return m.kind !== 'photo'; }));\n    MX.dirty = true; mxRenderPhotos();\n  }\n\n  $('mlsPane').addEventListener('click', function (ev) {\n    var b = ev.target.closest('button'); if (!b) return;\n    if (b.hasAttribute('data-pmove')) { var id = b.getAttribute('data-pmove'); var ph = MX.media.filter(function (m) { return m.kind === 'photo'; }).map(function (m) { return m.id; }); mxMovePhoto(id, ph.indexOf(id) + (+b.getAttribute('data-d'))); }\n    if (b.hasAttribute('data-pfirst')) mxMovePhoto(b.getAttribute('data-pfirst'), 0);\n    if (b.hasAttribute('data-pdel')) {\n      var fid = b.getAttribute('data-pdel');\n      if (!confirm('Remove this file from the listing?')) return;\n      busy(b, true, '');\n      mxSaveIfDirty().then(function () { return call('deleteMatrixFile', TOKEN, CURRENT.deal_id, fid); })\n        .then(function (media) { MX.media = media; mxRenderPhotos(); mxRenderDocs(); toast('Removed.'); })\n        .catch(function (e) { toast(e.message, true); busy(b, false); });\n    }\n  });\n  $('mlsPane').addEventListener('input', function (ev) {\n    var id = ev.target.getAttribute('data-cap');\n    if (id) { MX.media.forEach(function (m) { if (m.id === id) m.caption = ev.target.value; }); MX.dirty = true; }\n  });\n  $('mlsPane').addEventListener('change', function (ev) {\n    var id = ev.target.getAttribute('data-dcat');\n    if (id) { MX.media.forEach(function (m) { if (m.id === id) m.category = ev.target.value; }); MX.dirty = true; }\n  });\n\n  function mxUpload(files, kind) {\n    files = Array.prototype.slice.call(files || []);\n    if (!files.length) return;\n    if (!CURRENT || !CURRENT.deal_id) { toast('Submit the deal first, then add photos and documents.', true); return; }\n    if (kind === 'photo') files = files.filter(function (f) { return /^image\\//.test(f.type); });\n    var big = files.filter(function (f) { return f.size > CFG.maxUploadBytes; });\n    if (big.length) { toast(big[0].name + ' is over 20 MB.', true); return; }\n    var cat = $('mxDocCat').value, n = 0;\n    toast('Uploading ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '\u2026');\n    mxSaveIfDirty().then(function () {\n      return files.reduce(function (p, file) {\n        return p.then(function () {\n          return readB64(file).then(function (data) {\n            return call('uploadMatrixFile', TOKEN, CURRENT.deal_id, { name: file.name, mimeType: file.type, data: data, kind: kind, category: cat });\n          }).then(function (media) {\n            var known = {}; MX.media.forEach(function (m) { known[m.id] = 1; });\n            media.forEach(function (m) { if (!known[m.id] && kind === 'photo') MX.local[m.id] = URL.createObjectURL(file); });\n            // keep any captions/order typed but not yet saved\n            var local = {}; MX.media.forEach(function (m) { local[m.id] = m; });\n            MX.media = media.map(function (m) { return local[m.id] ? Object.assign(m, { caption: local[m.id].caption, category: local[m.id].category || m.category }) : m; });\n            n++; toast('Uploaded ' + n + ' of ' + files.length + '\u2026');\n            mxRenderPhotos(); mxRenderDocs();\n          });\n        });\n      }, Promise.resolve());\n    }).then(function () { toast(files.length + ' file' + (files.length > 1 ? 's' : '') + ' added to the listing.'); })\n      .catch(function (e) { toast(e.message, true); });\n  }\n  $('mxPhotoInput').addEventListener('change', function (ev) { mxUpload(ev.target.files, 'photo'); ev.target.value = ''; });\n  $('mxDocInput').addEventListener('change', function (ev) { mxUpload(ev.target.files, 'doc'); ev.target.value = ''; });\n  ['dragover', 'drop'].forEach(function (type) {\n    $('mxPhotoDrop').addEventListener(type, function (ev) { ev.preventDefault(); if (type === 'drop') mxUpload(ev.dataTransfer.files, 'photo'); });\n  });\n\n  // ---------- save / PDF / send ----------\n  function mxSaveIfDirty() {\n    if (!MX || !MX.dirty || !MX.type || !CURRENT || !CURRENT.deal_id) return Promise.resolve();\n    return call('saveMatrixListing', TOKEN, CURRENT.deal_id, { type: MX.type, data: MX.data, media: mxMediaPayload() })\n      .then(function (r) { MX.dirty = false; MX.status = r.matrix_status; MX.notes = r.matrix_notes; mxRenderStatus(); mxUpdate(); });\n  }\n\n  function mxCheck() {\n    var missing = [], warnings = [];\n    Array.prototype.forEach.call(document.querySelectorAll('#mxForm [data-mxerr]'), function (e) { e.textContent = ''; });\n    mxSchema().sections.forEach(function (sec) {\n      if (!mxVisible(sec)) return;\n      sec.fields.forEach(function (f) {\n        if (!mxVisible(f)) return;\n        var v = MX.data[f.id];\n        if (f.req && mxEmpty(v)) { missing.push({ sec: sec.title, f: f }); var e = document.querySelector('[data-mxerr=\"' + f.id + '\"]'); if (e) e.textContent = 'Required'; }\n        if (/Remarks/.test(f.label) && v && COMP_RE.test(v)) warnings.push({ sec: sec.title, f: f, msg: 'looks like it mentions compensation, which is not allowed in MLS remarks' });\n      });\n    });\n    if (!MX.media.some(function (m) { return m.kind === 'photo'; })) warnings.push({ sec: 'Photos', f: null, msg: 'no photos yet' });\n    var item = function (x, msg) { return '<li>' + (x.f ? '<a href=\"#\" data-goto=\"' + esc(x.f.id) + '\">' + esc(x.sec) + ' \u2192 ' + esc(x.f.label) + '</a>' : esc(x.sec)) + (msg ? ': ' + esc(msg) : '') + '</li>'; };\n    var html = '';\n    if (missing.length) html += '<div class=\"mx-issues bad\"><b>' + missing.length + ' required field' + (missing.length > 1 ? 's' : '') + ' still empty</b><ul>' +\n      missing.slice(0, 8).map(function (x) { return item(x); }).join('') + (missing.length > 8 ? '<li>\u2026and ' + (missing.length - 8) + ' more (marked \"Required\" above)</li>' : '') + '</ul></div>';\n    if (warnings.length) html += '<div class=\"mx-issues warn\"><b>Check these</b><ul>' + warnings.map(function (x) { return item(x, x.msg); }).join('') + '</ul></div>';\n    $('mxIssues').innerHTML = html;\n    return { missing: missing, warnings: warnings };\n  }\n  $('mxIssues').addEventListener('click', function (ev) {\n    var id = ev.target.getAttribute('data-goto'); if (!id) return;\n    ev.preventDefault();\n    var el = document.querySelector('[data-mxfield=\"' + id + '\"]'); if (!el) return;\n    el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(function () { el.classList.remove('flash'); }, 1600);\n  });\n\n  $('mxPdfBtn').addEventListener('click', function () {\n    if (!CURRENT.deal_id) { toast('Submit the deal first.', true); return; }\n    mxCheck();\n    var btn = $('mxPdfBtn'); busy(btn, true, 'Making PDF\u2026');\n    mxSaveIfDirty().then(function () { return call('matrixPdf', TOKEN, CURRENT.deal_id); }).then(function (r) {\n      var bin = atob(r.data), bytes = new Uint8Array(bin.length);\n      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n      var a = document.createElement('a');\n      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));\n      a.download = r.name; document.body.appendChild(a); a.click();\n      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);\n      toast(r.missing ? 'PDF downloaded. ' + r.missing + ' required field(s) are still missing (marked in red).' : 'PDF downloaded.');\n    }).catch(function (e) { toast(e.message, true); }).then(function () { busy(btn, false); });\n  });\n\n  $('mxSendBtn').addEventListener('click', function () {\n    if (!CURRENT.deal_id) { toast('Submit the deal first.', true); return; }\n    var c = mxCheck();\n    if (c.missing.length) { toast('Fill in the ' + c.missing.length + ' required field(s) listed below first.', true); return; }\n    if (c.warnings.some(function (w) { return w.sec === 'Photos'; })) { toast('Add at least one photo first.', true); return; }\n    if (c.warnings.length && !confirm('Send anyway? ' + c.warnings.map(function (w) { return (w.f ? w.f.label : w.sec) + ' ' + w.msg; }).join('; '))) return;\n    var btn = $('mxSendBtn'); busy(btn, true, 'Sending\u2026');\n    mxSaveIfDirty().then(function () { return call('sendToMatrix', TOKEN, CURRENT.deal_id); }).then(function (r) {\n      MX.status = r.matrix_status; MX.notes = r.matrix_notes; MX.media = r.media; mxRenderStatus(); mxRenderPhotos();\n      toast('Queued for Matrix. It will be entered as Incomplete for review.');\n      refreshListQuiet();\n    }).catch(function (e) { toast(e.message, true); }).then(function () { busy(btn, false); });\n  });\n})();\n</script>\n</body>\n</html>\n";
