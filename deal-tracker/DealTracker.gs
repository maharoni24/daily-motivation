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
  { key: 'client_address', col: 'Client Current Address', label: 'Client\'s current home address', type: 'text', sides: ALL, section: 'Your client', sky: 'Purchase Offer: Residing at' },

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
  { key: 'client_attorney_address', col: 'Client Attorney Address', label: 'Attorney\'s office address', type: 'text', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'client_attorney_phone', col: 'Client Attorney Phone', label: 'Attorney phone', type: 'tel', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'client_attorney_email', col: 'Client Attorney Email', label: 'Attorney email', type: 'email', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'other_attorney_name', col: 'Other Attorney', label: 'Other side\'s attorney (first & last)', type: 'text', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'other_attorney_firm', col: 'Other Attorney Firm', label: 'Their firm', type: 'text', sides: ALL, section: 'Attorneys, lender & title' },
  { key: 'other_attorney_address', col: 'Other Attorney Address', label: 'Their office address', type: 'text', sides: ALL, section: 'Attorneys, lender & title' },
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
  // ---- Purchase Offer Agreement (buyer deals): fills the CBAH offer sheet
  { key: 'offer_date', col: 'Offer Date', label: 'Offer date', type: 'date', sides: ['Buyer'], section: 'Purchase offer' },
  { key: 'offer_price', col: 'Offer Price', label: 'Purchase price offered', type: 'money', sides: ['Buyer'], section: 'Purchase offer' },
  { key: 'offer_cash_on_signing', col: 'Offer Cash on Signing', label: 'Cash on signing of contracts', type: 'money', sides: ['Buyer'], section: 'Purchase offer' },
  { key: 'offer_mortgage', col: 'Offer First Mortgage', label: 'Subject to obtaining first mortgage of', type: 'money', sides: ['Buyer'], section: 'Purchase offer',
    help: 'Leave at 0 or blank for a cash offer.' },
  { key: 'offer_cash_on_deed', col: 'Offer Cash on Deed', label: 'Cash on delivery of deed', type: 'money', sides: ['Buyer'], section: 'Purchase offer',
    help: 'Fills in automatically: price minus cash on signing minus mortgage. You can change it.' },
  { key: 'offer_comp_from_proceeds', col: 'Offer Comp From Proceeds', label: 'Buyer broker compensation paid out of proceeds?', type: 'select', options: ['Yes', 'No'], sides: ['Buyer'], section: 'Purchase offer',
    help: 'The compensation % comes from "Buyer/tenant-side commission %" under Commission.' },
  { key: 'offer_loan_terms', col: 'Offer Loan Type & Duration', label: 'Loan type and duration (e.g. Conventional, 30-year fixed)', type: 'text', sides: ['Buyer'], section: 'Purchase offer' },
  { key: 'offer_contract_by', col: 'Offer Contract By', label: 'Formal contract signed on/about', type: 'date', sides: ['Buyer'], section: 'Purchase offer' },
  { key: 'offer_deed_by', col: 'Offer Deed By', label: 'Deed delivered on/about', type: 'date', sides: ['Buyer'], section: 'Purchase offer' },
  { key: 'offer_remarks', col: 'Offer Remarks', label: 'Remarks', type: 'textarea', sides: ['Buyer'], section: 'Purchase offer' },

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
  'SkySlope Status', 'SkySlope File', 'SkySlope Upload Email', 'SkySlope Notes', 'Offer Status', 'Offer Sent'];
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
  ensureSheet_(ss, SHEETS.DOCS, DOC_HEADERS);
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
      if (c.change === 'completed' && c.status && status !== 'Cancelled' && status !== 'TOM' &&
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
// PURCHASE OFFER AGREEMENT (buyer deals)
// The agent fills the "Purchase offer" section and clicks "Email offer PDF".
// The deal is saved, a PDF of the CBAH Purchase Offer Agreement is emailed to
// the deal's agent, and "Offer Status" is set so the SkySlope task fills the
// same form ("Purchase Offer Agreement - Coldwell Banker American Homes Main")
// in that buyer's SkySlope Forms file.
// ---------------------------------------------------------------------------

var OFFER_FORM_NAME = 'Purchase Offer Agreement - Coldwell Banker American Homes Main';
var OFFER_REQUIRED = ['offer_date', 'offer_price', 'street_number', 'street_name', 'city', 'sale_comm_pct', 'offer_comp_from_proceeds'];

function sendPurchaseOffer(token, input) {
  if (!input || input.side !== 'Buyer') throw new Error('Purchase offers are for buyer deals.');
  var saved = saveDeal(token, input);
  var d = findDealRow_(saved.deal_id).deal;
  var missing = OFFER_REQUIRED.filter(function (k) { return !String(d[k] || '').trim(); }).map(function (k) {
    var f = FIELDS.filter(function (x) { return x.key === k; })[0];
    return f ? labelFor_(f, 'Buyer') : k;
  });
  if (missing.length) throw new Error('Deal saved. To create the offer, also fill in: ' + missing.join(', '));
  if (!d.agent_email) throw new Error('Deal saved, but this agent has no email in the Agents tab, so the offer can\'t be emailed.');

  var v = offerValues_(d);
  var pdf = buildOfferPdf_(v);
  var subject = 'Purchase Offer Agreement: ' + v.premises + ' ($' + v.purchase_price + ')';
  var body = 'Hi ' + (d.agent_name || '').split(' ')[0] + ',\n\nAttached is the Purchase Offer Agreement for ' + v.purchaser + ' on ' + v.premises +
    ', at $' + v.purchase_price + '.\n\nThe same offer is being filled in on this buyer\'s SkySlope file.\n\n' + APP_NAME + ' (deal ' + d.deal_id + ')';
  GmailApp.sendEmail(d.agent_email, subject, body, { attachments: [pdf], name: APP_NAME });

  var sentNote = isoNow_() + ' emailed to ' + d.agent_email;
  setDealCells_(d.deal_id, { 'Offer Status': 'Queued for SkySlope', 'Offer Sent': sentNote });
  logSync_(d.deal_id, 'Purchase offer', 'OK', 'PDF emailed to ' + d.agent_email + ' ($' + v.purchase_price + ')');
  return { deal_id: d.deal_id, isNew: saved.isNew, status: saved.status, emailed_to: d.agent_email, inventory: saved.inventory };
}

/** Values for each blank on the offer sheet, formatted the way they print. */
function offerValues_(d) {
  var money = function (x) {
    var n = Number(String(x || '').replace(/[$,\s]/g, ''));
    return x === '' || x == null || isNaN(n) ? '' : n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };
  var name = function (f, l) { return [f, l].filter(String).join(' ').trim(); };
  var p1 = d.client_is_entity === 'Yes' && d.client_company ? d.client_company : name(d.client_first, d.client_last);
  var p2 = name(d.client2_first, d.client2_last);
  var price = Number(String(d.offer_price || '').replace(/[$,]/g, '')) || 0;
  var signing = Number(String(d.offer_cash_on_signing || '').replace(/[$,]/g, '')) || 0;
  var mortgage = Number(String(d.offer_mortgage || '').replace(/[$,]/g, '')) || 0;
  var deed = d.offer_cash_on_deed !== '' && d.offer_cash_on_deed != null ? d.offer_cash_on_deed : (price ? price - signing - mortgage : '');
  var street = [d.street_number, d.direction, d.street_name].filter(String).join(' ') + (d.unit ? ' Unit ' + d.unit : '');
  var premises = [street, d.city, [d.state === 'New York' ? 'NY' : d.state, d.zip].filter(String).join(' ')].filter(String).join(', ');
  var attyLine = function (n, firm) { return [n, firm].filter(String).join(', '); };
  return {
    form_name: OFFER_FORM_NAME,
    date: slash_(d.offer_date),
    purchaser: [p1, p2].filter(String).join(' and '),
    residing_at: d.client_address || '',
    premises: premises,
    purchase_price: money(d.offer_price),
    cash_on_signing: money(d.offer_cash_on_signing),
    first_mortgage: mortgage ? money(mortgage) : (d.offer_mortgage === '0' ? '0' : ''),
    cash_on_deed: money(deed),
    buyer_broker_comp_pct: d.sale_comm_pct || '',
    comp_from_proceeds: d.offer_comp_from_proceeds || '',
    loan_type_and_duration: d.offer_loan_terms || (d.cash_deal === 'Yes' ? 'Cash' : (d.loan_type || '')),
    remarks: d.offer_remarks || '',
    contract_on_about: slash_(d.offer_contract_by),
    deed_on_about: slash_(d.offer_deed_by || d.closing_date),
    purchaser_1: p1, purchaser_2: p2,
    purchaser_attorney: attyLine(d.client_attorney_name, d.client_attorney_firm),
    purchaser_attorney_address: d.client_attorney_address || '',
    purchaser_attorney_phone: d.client_attorney_phone || '',
    purchaser_attorney_email: d.client_attorney_email || '',
    seller_1: name(d.other_first, d.other_last),
    seller_attorney: attyLine(d.other_attorney_name, d.other_attorney_firm),
    seller_attorney_address: d.other_attorney_address || '',
    seller_attorney_phone: d.other_attorney_phone || '',
    seller_attorney_email: d.other_attorney_email || '',
    broker_agent: (d.agent_name || '') + ', Coldwell Banker American Homes'
  };
}

/** Letter-size PDF laid out like the CBAH Purchase Offer Agreement (Rev 06/09/25). */
function buildOfferPdf_(v) {
  var e = function (x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fill = function (x, w) { return '<span class="f" style="min-width:' + (w || 200) + 'px">' + (e(x) || '&nbsp;') + '</span>'; };
  var dot = function (on) { return on ? '&#9679;' : '&#9675;'; };
  var row = function (label, val) { return '<tr><td class="l">' + label + '</td><td class="d">$</td><td class="v">' + fill(val, 170) + '</td></tr>'; };
  var sig = function (left, leftLabel, right, rightLabel) {
    return '<tr><td class="s">' + fill(left, 210) + '<div class="sl">' + leftLabel + '</div></td><td></td><td class="s">' + fill(right, 210) + '<div class="sl">' + rightLabel + '</div></td></tr>';
  };
  var remarks = String(v.remarks || '');
  var html = '<html><head><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#000;margin:28px 48px}' +
    '.f{display:inline-block;border-bottom:1px solid #000;padding:0 4px;font-family:"Courier New",monospace;font-size:10pt;color:#0b2a8a}' +
    'h1{text-align:center;font-size:20pt;margin:6px 0 10px} table{border-collapse:collapse;width:100%}' +
    '.l{padding:3px 0}.d{width:12px;text-align:right}.v{width:190px}.s{width:46%;padding-top:14px;vertical-align:top}.sl{font-size:9.5pt;padding-top:2px}' +
    '.small{font-size:8pt;color:#333}.ack{font-weight:bold;font-size:9.5pt}' +
    '</style></head><body>' +
    '<img src="data:image/jpeg;base64,' + OFFER_LOGO_B64 + '" style="height:46px">' +
    '<h1>Purchase Offer Agreement</h1>' +
    '<div style="text-align:right">Date: ' + fill(v.date, 120) + '</div>' +
    '<div style="margin-top:6px">Received from Purchaser: ' + fill(v.purchaser, 470) + '</div>' +
    '<div style="margin-top:4px">Residing at: ' + fill(v.residing_at, 545) + '</div>' +
    '<div style="margin-top:4px">In reference to the premises: ' + fill(v.premises, 445) + '</div>' +
    '<table style="margin-top:12px">' +
    row('PURCHASE PRICE', v.purchase_price) +
    row('TERMS: &nbsp; Cash on Signing of Contracts', v.cash_on_signing) +
    row('&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Subject to obtaining first mortgage of', v.first_mortgage) +
    row('&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Cash on delivery of deed', v.cash_on_deed) +
    '<tr><td class="l">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Buyer Broker Compensation</td><td></td><td class="v">' + fill(v.buyer_broker_comp_pct, 150) + ' %</td></tr>' +
    '</table>' +
    '<div style="margin-top:6px;padding-left:96px">Buyer Broker Compensation to be paid out of proceeds: &nbsp; Yes ' + dot(v.comp_from_proceeds === 'Yes') + ' &nbsp; No ' + dot(v.comp_from_proceeds === 'No') + '</div>' +
    '<div style="margin-top:14px">Loan Type and Duration: ' + fill(v.loan_type_and_duration, 470) + '</div>' +
    '<div style="margin-top:10px">Remarks:</div>' +
    '<div style="border-bottom:1px solid #000;min-height:54px;font-family:\'Courier New\',monospace;font-size:10pt;color:#0b2a8a;white-space:pre-wrap">' + (e(remarks) || '&nbsp;') + '</div>' +
    '<p style="margin-top:12px">If the seller accepts the price and terms, a formal contract shall be signed on/about: ' + fill(v.contract_on_about, 90) +
    '. The deed shall be delivered on/or about: ' + fill(v.deed_on_about, 90) + '. This agreement may not change orally after acceptance by both parties. I have read the foregoing and agree with and accept its terms:</p>' +
    '<table>' +
    sig(v.purchaser_1, 'Purchaser', v.purchaser_attorney, 'Attorney for Purchaser') +
    sig('', 'Signature', v.purchaser_attorney_address, 'Address') +
    sig(v.purchaser_2, 'Purchaser', v.purchaser_attorney_phone, 'Phone #') +
    sig('', 'Signature', v.purchaser_attorney_email, 'Email Address') +
    '</table>' +
    '<h3 style="text-align:center;margin:14px 0 4px">Offer Acknowledgment</h3>' +
    '<div class="ack">In signing this form, sellers are not accepting or rejecting this offer. They are acknowledging that the offer was presented and explained to them with the knowledge of their listing Broker/Agent</div>' +
    '<table>' +
    sig(v.seller_1, 'Seller', v.seller_attorney, 'Attorney for Seller') +
    sig('', 'Signature', v.seller_attorney_address, 'Address') +
    sig('', 'Seller', v.seller_attorney_phone, 'Phone #') +
    sig('', 'Signature', v.seller_attorney_email, 'Email Address') +
    '</table>' +
    '<div style="margin-top:16px">Broker/Agent: ' + fill(v.broker_agent, 320) + '</div>' +
    '<div class="small" style="margin-top:16px">Rev 06/09/25</div>' +
    '</body></html>';
  var name = 'Purchase Offer Agreement - ' + (v.premises.split(',')[0] || 'offer') + '.pdf';
  return Utilities.newBlob(html, 'text/html', 'offer.html').getAs('application/pdf').setName(name);
}

// ---------------------------------------------------------------------------
// STAGE REQUIREMENTS + MLS LOOKUP
// ---------------------------------------------------------------------------

/** Highest stage the deal has reached: its status, or a checked milestone. */
function dealStage_(deal) {
  if (deal.status === 'Cancelled' || deal.status === 'TOM') return '';
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
  if (deal.status === 'Cancelled') return { ok: true, message: 'Cancelled: inventory left as is for Mac to review.' };
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
    },
    purchase_offer: d.side === 'Buyer' && d.offer_price ? offerValues_(d) : null
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
  var sent = 0, waiting = 0, errors = 0;
  try {
    var sheet = docsSheet_();
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return 'Nothing waiting.';
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
  var msgOut = 'Documents: ' + sent + ' sent to SkySlope, ' + waiting + ' still waiting for a SkySlope file' + (errors ? ', ' + errors + ' errors (see Documents tab)' : '') + '.';
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
  'Offer Status': 'offer_status', 'Offer Sent': 'offer_sent',
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

/** Coldwell Banker American Homes logo, taken from the brokerage's own offer form. */
var OFFER_LOGO_B64 = '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';


// ---------------------------------------------------------------------------
// THE PAGE AGENTS SEE (kept in this file so the whole app is one paste)
// ---------------------------------------------------------------------------
var INDEX_HTML = "<!DOCTYPE html>\n<html>\n<head>\n<base target=\"_top\">\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Agent Deal Tracker</title>\n<style>\n  :root {\n    --bg: #f4f5f7; --card: #ffffff; --ink: #111827; --muted: #6b7280; --line: #e5e7eb;\n    --brand: #1f2937; --accent: #2563eb; --accent-ink: #ffffff; --ok: #059669; --warn: #d97706; --bad: #dc2626;\n    --seller: #7c3aed; --buyer: #2563eb; --tenant: #0d9488; --landlord: #c2410c;\n    --radius: 12px;\n  }\n  * { box-sizing: border-box; }\n  body { margin: 0; font: 15px/1.45 -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--ink); }\n  header.top { background: var(--brand); color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }\n  header.top h1 { font-size: 17px; margin: 0; flex: 1; letter-spacing: .2px; }\n  header.top .who { font-size: 13px; opacity: .85; }\n  main { max-width: 980px; margin: 0 auto; padding: 16px; }\n  .hidden { display: none !important; }\n  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; }\n  .btn { appearance: none; border: 1px solid var(--line); background: #fff; color: var(--ink); padding: 9px 14px; border-radius: 9px; font: inherit; font-weight: 600; cursor: pointer; }\n  .btn:hover { background: #f9fafb; }\n  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }\n  .btn.primary:hover { filter: brightness(1.07); }\n  .btn.ghost { background: transparent; border-color: rgba(255,255,255,.35); color: #fff; }\n  .btn:disabled { opacity: .55; cursor: default; }\n  label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px; }\n  input, select, textarea { width: 100%; font: inherit; padding: 9px 10px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: var(--ink); }\n  input:focus, select:focus, textarea:focus { outline: 2px solid #bfdbfe; border-color: var(--accent); }\n  textarea { min-height: 90px; resize: vertical; }\n  .req::after { content: \" *\"; color: var(--bad); }\n  .muted { color: var(--muted); }\n  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }\n\n  /* Login */\n  #login { max-width: 380px; margin: 8vh auto 0; }\n  #login h2 { margin: 0 0 4px; }\n  #login .field { margin-top: 12px; }\n\n  /* Toolbar & list */\n  .toolbar { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin-bottom: 12px; }\n  .filters { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 8px; margin-bottom: 14px; }\n  .filters.admin { grid-template-columns: 2fr 1fr 1fr 1.3fr; }\n  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }\n  .stat { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }\n  .stat b { display: block; font-size: 20px; }\n  .stat span { font-size: 12px; color: var(--muted); }\n  .deal { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; padding: 14px 16px; margin-bottom: 10px; cursor: pointer; transition: border-color .15s; }\n  .deal:hover { border-color: #93c5fd; }\n  .deal .addr { font-weight: 700; }\n  .deal .meta { font-size: 13px; color: var(--muted); }\n  .badge { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; color: #fff; }\n  .b-Seller { background: var(--seller); } .b-Buyer { background: var(--buyer); } .b-Tenant { background: var(--tenant); } .b-Landlord { background: var(--landlord); }\n  .status { font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; white-space: nowrap; }\n  .s-Sold { background: #d1fae5; color: #065f46; } .s-Cancelled { background: #fee2e2; color: #991b1b; } .s-TOM { background: #fef3c7; color: #92400e; }\n  .s-Under, .s-Closing { background: #dbeafe; color: #1e40af; } .s-Accepted { background: #ede9fe; color: #5b21b6; } .s-Coming { background: #f3f4f6; color: #374151; }\n  .stage-banner { background: #fff7e6; border: 1px solid #f5c26b; color: #7a4b00; border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; font-size: 14px; }\n  .stage-banner.ok { background: #ecfdf5; border-color: #8fd9b6; color: #065f46; }\n  .need label, label.need { color: #b45309; }\n  .need input, .need select, .need textarea { border-color: #f5a524; background: #fffbeb; }\n  .mlsrow { display: flex; gap: 8px; } .mlsrow input { flex: 1; min-width: 0; } .mlsrow .btn { white-space: nowrap; padding: 9px 12px; }\n  .offer-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px; border: 1px dashed #93c5fd; border-radius: 10px; background: #eff6ff; }\n  .offer-actions .muted { font-size: 13px; flex: 1; min-width: 200px; }\n  .help { display: block; font-size: 12px; color: var(--muted); margin-top: 3px; }\n  .sky { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: #f3f4f6; color: #374151; white-space: nowrap; }\n  .sky.ok { background: #d1fae5; color: #065f46; } .sky.wait { background: #fef3c7; color: #92400e; } .sky.err { background: #fee2e2; color: #991b1b; }\n  .bar { height: 6px; background: #e5e7eb; border-radius: 99px; overflow: hidden; grid-column: 1 / -1; }\n  .bar > i { display: block; height: 100%; background: var(--ok); }\n  .empty { text-align: center; padding: 40px 16px; color: var(--muted); }\n\n  /* Side picker */\n  .sides { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 12px; }\n  .side-tile { border: 2px solid var(--line); border-radius: var(--radius); padding: 18px; background: #fff; cursor: pointer; text-align: left; font: inherit; }\n  .side-tile:hover { border-color: var(--accent); }\n  .side-tile b { display: block; font-size: 18px; margin-bottom: 4px; }\n  .side-tile span { font-size: 13px; color: var(--muted); }\n\n  /* Editor */\n  .ed-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }\n  .ed-head h2 { margin: 0; font-size: 20px; flex: 1; min-width: 200px; }\n  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 14px; overflow-x: auto; }\n  .tab { padding: 10px 14px; border: 0; background: none; font: inherit; font-weight: 600; color: var(--muted); border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; }\n  .tab.on { color: var(--accent); border-color: var(--accent); }\n  fieldset { border: 0; padding: 0; margin: 0 0 18px; }\n  legend { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin-bottom: 10px; }\n  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px 14px; }\n  .grid .wide { grid-column: 1 / -1; }\n  .ms { display: grid; grid-template-columns: 28px 1fr 150px; gap: 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); }\n  .ms:last-child { border-bottom: 0; }\n  .ms input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--ok); }\n  .ms .ml { font-weight: 600; }\n  .ms.done .ml { color: var(--ok); }\n  .ms .note { grid-column: 2 / -1; font-size: 13px; padding: 6px 8px; }\n  .savebar { position: sticky; bottom: 0; background: rgba(244,245,247,.95); backdrop-filter: blur(4px); padding: 12px 0; display: flex; gap: 10px; justify-content: flex-end; border-top: 1px solid var(--line); margin-top: 10px; }\n  .docs-upload { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: end; margin-bottom: 14px; }\n  .doc { display: flex; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 14px; }\n  .doc a { color: var(--accent); font-weight: 600; text-decoration: none; word-break: break-word; }\n\n  /* Toast */\n  #toast { position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); background: #111827; color: #fff; padding: 11px 16px; border-radius: 10px; font-size: 14px; max-width: calc(100% - 32px); z-index: 50; box-shadow: 0 8px 24px rgba(0,0,0,.2); }\n  #toast.err { background: var(--bad); }\n  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -2px; margin-right: 6px; }\n  @keyframes spin { to { transform: rotate(360deg); } }\n\n  @media (max-width: 640px) {\n    .grid, .filters, .filters.admin, .sides, .docs-upload { grid-template-columns: 1fr; }\n    .stats { grid-template-columns: repeat(2, 1fr); }\n    .ms { grid-template-columns: 28px 1fr; }\n    .ms input[type=date] { grid-column: 2; }\n    header.top .who { display: none; }\n  }\n</style>\n</head>\n<body>\n\n<header class=\"top\">\n  <h1 id=\"appTitle\">Agent Deal Tracker</h1>\n  <span class=\"who\" id=\"who\"></span>\n  <button class=\"btn ghost hidden\" id=\"logoutBtn\">Sign out</button>\n</header>\n\n<main>\n  <!-- LOGIN -->\n  <section id=\"login\" class=\"card hidden\">\n    <h2>Agent sign-in</h2>\n    <p class=\"muted\" style=\"margin:0\">Your email, and your MLS ID as your PIN.</p>\n    <form id=\"loginForm\">\n      <div class=\"field\"><label for=\"loginEmail\">Email</label><input id=\"loginEmail\" type=\"email\" autocomplete=\"email\" required></div>\n      <div class=\"field\"><label for=\"loginPin\">PIN (your MLS ID)</label><input id=\"loginPin\" type=\"password\" autocomplete=\"current-password\" required></div>\n      <div class=\"field\"><button class=\"btn primary\" style=\"width:100%\" type=\"submit\" id=\"loginBtn\">Sign in</button></div>\n    </form>\n  </section>\n\n  <!-- LIST -->\n  <section id=\"list\" class=\"hidden\">\n    <div class=\"toolbar\">\n      <h2 style=\"margin:0;align-self:center\" id=\"listTitle\">My deals</h2>\n      <button class=\"btn primary\" id=\"newDealBtn\">+ New deal</button>\n    </div>\n    <div class=\"stats\" id=\"stats\"></div>\n    <div class=\"filters\" id=\"filters\">\n      <input id=\"fSearch\" placeholder=\"Search address, client, deal ID\u2026\">\n      <select id=\"fSide\"><option value=\"\">All sides</option></select>\n      <select id=\"fStatus\"><option value=\"\">All statuses</option></select>\n      <select id=\"fAgent\" class=\"hidden\"><option value=\"\">All agents</option></select>\n    </div>\n    <div id=\"deals\"></div>\n  </section>\n\n  <!-- SIDE PICKER -->\n  <section id=\"picker\" class=\"hidden\">\n    <button class=\"btn\" data-go=\"list\">\u2190 Back</button>\n    <h2 style=\"margin:16px 0 0\">Who are you representing?</h2>\n    <div class=\"sides\">\n      <button class=\"side-tile\" data-side=\"Seller\"><b>Seller</b><span>Listing side of a sale</span></button>\n      <button class=\"side-tile\" data-side=\"Buyer\"><b>Buyer</b><span>Purchase side of a sale</span></button>\n      <button class=\"side-tile\" data-side=\"Tenant\"><b>Tenant</b><span>Helping someone lease a property</span></button>\n      <button class=\"side-tile\" data-side=\"Landlord\"><b>Landlord</b><span>Leasing out an owner's property</span></button>\n    </div>\n  </section>\n\n  <!-- EDITOR -->\n  <section id=\"editor\" class=\"hidden\">\n    <button class=\"btn\" data-go=\"list\">\u2190 All deals</button>\n    <div class=\"ed-head\" style=\"margin-top:14px\">\n      <span class=\"badge\" id=\"edSide\"></span>\n      <h2 id=\"edTitle\">New deal</h2>\n      <div style=\"min-width:170px\"><select id=\"edStatus\" aria-label=\"Deal status\"></select></div>\n    </div>\n    <p class=\"muted\" id=\"edMeta\" style=\"margin:-4px 0 10px;font-size:13px\"></p>\n    <div id=\"edAgentWrap\" class=\"card hidden\" style=\"margin-bottom:12px;padding:12px 16px\">\n      <label for=\"edAgent\" class=\"req\">Agent on this deal</label>\n      <select id=\"edAgent\"></select>\n      <span class=\"help\">The deal goes under this agent: their list, their office's inventory tab, and their name in SkySlope.</span>\n    </div>\n    <div id=\"stageBanner\" class=\"stage-banner hidden\" aria-live=\"polite\"></div>\n    <div class=\"tabs\">\n      <button class=\"tab on\" data-tab=\"details\">Deal details</button>\n      <button class=\"tab\" data-tab=\"milestones\">Milestones <span id=\"msCount\"></span></button>\n      <button class=\"tab\" data-tab=\"docs\">Documents</button>\n    </div>\n\n    <form id=\"dealForm\" novalidate>\n      <div data-pane=\"details\" class=\"card\" id=\"detailsPane\"></div>\n      <div data-pane=\"milestones\" class=\"card hidden\">\n        <p class=\"muted\" style=\"margin-top:0\">Check each milestone as it happens. Dates default to today; change them if needed. Saving sends the update to the office.</p>\n        <div class=\"bar\" style=\"margin-bottom:8px\"><i id=\"msBar\" style=\"width:0\"></i></div>\n        <div id=\"msList\"></div>\n      </div>\n      <div data-pane=\"docs\" class=\"card hidden\">\n        <div id=\"docsLocked\" class=\"muted\">Save the deal first, then upload documents here.</div>\n        <p class=\"muted\" id=\"docsHelp\" style=\"margin-top:0;font-size:13px\"></p>\n        <div id=\"docsArea\" class=\"hidden\">\n          <div class=\"docs-upload\">\n            <div><label for=\"docCat\">Document type</label>\n              <select id=\"docCat\">\n                <option>Contract / Purchase Agreement</option><option>Listing Agreement</option><option>Buyer Agreement</option>\n                <option>Lease</option><option>Rental Application</option><option>Addendum / Amendment</option>\n                <option>Disclosure</option><option>Inspection Report</option><option>Earnest Money Receipt</option>\n                <option>Closing Disclosure / Settlement</option><option>Commission Disbursement</option><option>Other</option>\n              </select></div>\n            <div><label for=\"docFile\">File (max 20 MB)</label><input id=\"docFile\" type=\"file\" multiple></div>\n            <button class=\"btn primary\" type=\"button\" id=\"uploadBtn\">Upload</button>\n          </div>\n          <div id=\"docList\"></div>\n        </div>\n      </div>\n\n      <div class=\"savebar\">\n        <button class=\"btn\" type=\"button\" data-go=\"list\">Cancel</button>\n        <button class=\"btn primary\" type=\"submit\" id=\"saveBtn\">Save deal</button>\n      </div>\n    </form>\n  </section>\n</main>\n\n<div id=\"toast\" class=\"hidden\"></div>\n\n<script>\n(function () {\n  'use strict';\n\n  // ---------- server bridge ----------\n  function call(fn) {\n    var args = Array.prototype.slice.call(arguments, 1);\n    return new Promise(function (resolve, reject) {\n      google.script.run\n        .withSuccessHandler(resolve)\n        .withFailureHandler(function (err) {\n          var msg = (err && err.message) || String(err);\n          if (msg.indexOf('SESSION_EXPIRED') >= 0) { clearToken(); show('login'); msg = 'Your session expired. Please sign in again.'; }\n          reject(new Error(msg));\n        })[fn].apply(null, args);\n    });\n  }\n\n  // ---------- state ----------\n  var CFG = null, TOKEN = null, USER = null, DEALS = [], CURRENT = null;\n  var $ = function (id) { return document.getElementById(id); };\n  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }\n  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }\n  function clearToken() { TOKEN = null; store('dt_token', null); store('dt_user', null); }\n  function esc(s) { return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]; }); }\n\n  function toast(msg, isErr) {\n    var t = $('toast'); t.textContent = msg; t.className = isErr ? 'err' : '';\n    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = 'hidden'; }, isErr ? 6000 : 3500);\n  }\n  function busy(btn, on, text) {\n    if (on) { btn._txt = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class=\"spinner\"></span>' + (text || 'Working\u2026'); }\n    else { btn.disabled = false; if (btn._txt) btn.innerHTML = btn._txt; }\n  }\n  function show(view) {\n    ['login', 'list', 'picker', 'editor'].forEach(function (v) { $(v).classList.toggle('hidden', v !== view); });\n    $('logoutBtn').classList.toggle('hidden', view === 'login' || !TOKEN);\n    window.scrollTo(0, 0);\n  }\n\n  // ---------- boot ----------\n  call('getAppConfig').then(function (cfg) {\n    CFG = cfg;\n    $('appTitle').textContent = cfg.appName;\n    cfg.sides.forEach(function (s) { $('fSide').insertAdjacentHTML('beforeend', '<option>' + s + '</option>'); });\n    cfg.statuses.forEach(function (s) {\n      $('fStatus').insertAdjacentHTML('beforeend', '<option>' + s + '</option>');\n      $('edStatus').insertAdjacentHTML('beforeend', '<option>' + s + '</option>');\n    });\n    document.body.insertAdjacentHTML('beforeend', '<datalist id=\"rosterList\">' + (cfg.roster || []).map(function (n) { return '<option value=\"' + esc(n) + '\">'; }).join('') + '</datalist>');\n    TOKEN = load('dt_token');\n    try { USER = JSON.parse(load('dt_user') || 'null'); } catch (e) { USER = null; }\n    if (TOKEN && USER) return enterApp();\n    return call('tryAutoLogin').then(function (s) { if (s) { setSession(s); enterApp(); } else show('login'); });\n  }).catch(function (e) { show('login'); toast(e.message, true); });\n\n  function setSession(s) { TOKEN = s.token; USER = s.user; store('dt_token', TOKEN); store('dt_user', JSON.stringify(USER)); }\n\n  $('loginForm').addEventListener('submit', function (ev) {\n    ev.preventDefault();\n    var btn = $('loginBtn'); busy(btn, true, 'Signing in\u2026');\n    call('login', $('loginEmail').value, $('loginPin').value)\n      .then(function (s) { setSession(s); $('loginPin').value = ''; enterApp(); })\n      .catch(function (e) { toast(e.message, true); })\n      .then(function () { busy(btn, false); });\n  });\n\n  $('logoutBtn').addEventListener('click', function () { call('logout', TOKEN).catch(function () {}); clearToken(); USER = null; $('who').textContent = ''; show('login'); });\n\n  function enterApp() {\n    $('who').textContent = USER.name ? USER.name + (USER.isAdmin ? ' \u00b7 Admin' : '') : USER.email;\n    $('listTitle').textContent = USER.isAdmin ? 'All deals' : 'My deals';\n    $('fAgent').classList.toggle('hidden', !USER.isAdmin);\n    $('filters').classList.toggle('admin', !!USER.isAdmin);\n    if (USER.isAdmin) call('listAgentsForAdmin', TOKEN).then(function (a) { AGENTS = a || []; }).catch(function () {});\n    show('list');\n    return refreshList();\n  }\n\n  var AGENTS = [];\n  function fillAgentPicker(deal) {\n    var wrap = $('edAgentWrap');\n    wrap.classList.toggle('hidden', !USER.isAdmin);\n    if (!USER.isAdmin) return;\n    var cur = deal.agent_email || '';\n    var list = AGENTS.slice();\n    if (cur && !list.some(function (a) { return a.email === cur; })) list.unshift({ name: deal.agent_name || cur, email: cur, office: '' });\n    $('edAgent').innerHTML = '<option value=\"\">\u2014 Choose the agent \u2014</option>' + list.map(function (a) {\n      var label = a.name + (a.office ? ' \u00b7 ' + a.office : '') + (a.isAdmin ? ' (admin)' : '') + (a.email ? '' : ' (no email in Agents tab yet)');\n      return '<option value=\"' + esc(a.email) + '\"' + (a.email ? '' : ' disabled') + (a.email === cur ? ' selected' : '') + '>' + esc(label) + '</option>';\n    }).join('');\n  }\n  $('edAgent').addEventListener('change', function () {\n    var a = AGENTS.filter(function (x) { return x.email === $('edAgent').value; })[0];\n    if (a && a.office && $('f_office')) $('f_office').value = a.office;\n  });\n\n  // ---------- list ----------\n  function refreshList() {\n    $('deals').innerHTML = '<div class=\"empty\"><span class=\"spinner\"></span>Loading deals\u2026</div>';\n    return call('listDeals', TOKEN).then(function (deals) {\n      DEALS = deals || [];\n      if (USER.isAdmin) {\n        var agents = {}; DEALS.forEach(function (d) { agents[d.agent_email] = d.agent_name || d.agent_email; });\n        var cur = $('fAgent').value;\n        $('fAgent').innerHTML = '<option value=\"\">All agents</option>' + Object.keys(agents).sort().map(function (e) { return '<option value=\"' + esc(e) + '\">' + esc(agents[e]) + '</option>'; }).join('');\n        $('fAgent').value = cur;\n      }\n      renderList();\n    }).catch(function (e) { $('deals').innerHTML = '<div class=\"empty\">' + esc(e.message) + '</div>'; });\n  }\n\n  ['fSearch', 'fSide', 'fStatus', 'fAgent'].forEach(function (id) { $(id).addEventListener('input', renderList); });\n\n  function renderList() {\n    var q = $('fSearch').value.trim().toLowerCase(), side = $('fSide').value, st = $('fStatus').value, ag = $('fAgent').value;\n    var rows = DEALS.filter(function (d) {\n      if (side && d.side !== side) return false;\n      if (st && d.status !== st) return false;\n      if (ag && d.agent_email !== ag) return false;\n      if (q && [d.address, d.city, d.client_name, d.deal_id, d.agent_name].join(' ').toLowerCase().indexOf(q) < 0) return false;\n      return true;\n    });\n    var c = { active: 0, pending: 0, sold: 0 };\n    DEALS.forEach(function (d) {\n      if (d.status === 'Active' || d.status === 'Coming Soon') c.active++;\n      else if (['Accepted Offer', 'Under Contract', 'Closing Set'].indexOf(d.status) >= 0) c.pending++;\n      else if (d.status === 'Sold') c.sold++;\n    });\n    $('stats').innerHTML = [['Total', DEALS.length], ['Active / coming soon', c.active], ['Accepted / in contract', c.pending], ['Sold / leased', c.sold]]\n      .map(function (s) { return '<div class=\"stat\"><b>' + s[1] + '</b><span>' + s[0] + '</span></div>'; }).join('');\n\n    if (!rows.length) {\n      $('deals').innerHTML = '<div class=\"empty card\">' + (DEALS.length ? 'No deals match those filters.' : 'No deals yet. Tap <b>+ New deal</b> to add your first one.') + '</div>';\n      return;\n    }\n    $('deals').innerHTML = rows.map(function (d) {\n      var done = parseInt(String(d.milestones_done || '0'), 10) || 0, total = d.milestones_total || 1;\n      return '<div class=\"card deal\" data-id=\"' + esc(d.deal_id) + '\" tabindex=\"0\">' +\n        '<div><span class=\"badge b-' + esc(d.side) + '\">' + esc(d.side) + '</span> <span class=\"addr\">' + esc(d.address) + '</span>' +\n        '<div class=\"meta\">' + esc(d.client_name) + (d.city ? ' \u00b7 ' + esc(d.city) : '') + (USER.isAdmin ? ' \u00b7 ' + esc(d.agent_name || d.agent_email) : '') + ' \u00b7 ' + esc(d.deal_id) + '</div></div>' +\n        '<div style=\"text-align:right\"><span class=\"status s-' + esc(String(d.status).split(' ')[0]) + '\">' + esc(d.status) + '</span><div style=\"margin-top:6px\">' + skyChip(d.skyslope_status) + '</div></div>' +\n        '<div class=\"meta\" style=\"grid-column:1/-1\">Next: <b style=\"color:#374151\">' + esc(d.next_milestone || '') + '</b>' +\n        (d.current_milestone_date ? ' \u00b7 Last update ' + esc(d.current_milestone_date) : '') + (d.closing_date ? ' \u00b7 Closing ' + esc(d.closing_date) : '') + '</div>' +\n        '<div class=\"bar\"><i style=\"width:' + Math.round(done / total * 100) + '%\"></i></div></div>';\n    }).join('');\n  }\n\n  $('deals').addEventListener('click', function (ev) { var el = ev.target.closest('.deal'); if (el) openDeal(el.getAttribute('data-id')); });\n  $('deals').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { var el = ev.target.closest('.deal'); if (el) openDeal(el.getAttribute('data-id')); } });\n\n  document.addEventListener('click', function (ev) {\n    var go = ev.target.closest('[data-go]');\n    if (go) { ev.preventDefault(); show(go.getAttribute('data-go')); if (go.getAttribute('data-go') === 'list') renderList(); }\n  });\n  $('newDealBtn').addEventListener('click', function () { show('picker'); });\n  Array.prototype.forEach.call(document.querySelectorAll('.side-tile'), function (b) {\n    b.addEventListener('click', function () { openEditor({ side: b.getAttribute('data-side'), status: 'Active', milestones: {}, office: USER.office }); });\n  });\n\n  // ---------- editor ----------\n  function openDeal(id) {\n    toast('Opening deal\u2026');\n    call('getDeal', TOKEN, id).then(openEditor).catch(function (e) { toast(e.message, true); });\n  }\n\n  function labelFor(f, side) { return (f.labels && f.labels[side]) || f.label; }\n  function optionsFor(f, side) { return f.optionsBySide ? (f.optionsBySide[side] || []) : (f.options || []); }\n  function isReq(f, side) { return f.req === true || (Array.isArray(f.req) && f.req.indexOf(side) >= 0); }\n  function skyChip(st) {\n    if (!st) return '';\n    var cls = /created|complete/i.test(st) ? 'ok' : /error|review/i.test(st) ? 'err' : 'wait';\n    return '<span class=\"sky ' + cls + '\">SkySlope: ' + esc(st) + '</span>';\n  }\n  function addrOf(d) { return [d.street_number, d.direction, d.street_name].filter(Boolean).join(' ') + (d.unit ? ' #' + d.unit : ''); }\n\n  function openEditor(deal) {\n    CURRENT = deal;\n    var side = deal.side;\n    $('edSide').textContent = side; $('edSide').className = 'badge b-' + side;\n    $('edTitle').textContent = deal.deal_id ? (addrOf(deal) || ([deal.client_first, deal.client_last].filter(Boolean).join(' ') + ' (no property yet)')) : 'New ' + side.toLowerCase() + ' deal';\n    $('edStatus').value = deal.status || 'Active';\n    fillAgentPicker(deal);\n    $('edMeta').innerHTML = deal.deal_id\n      ? esc(deal.deal_id + ' \u00b7 ' + (deal.agent_name || deal.agent_email) + ' \u00b7 last updated ' + (deal.updated_at || '').replace('T', ' ')) + ' &nbsp;' + skyChip(deal.skyslope_status) +\n        (deal.offer_status ? ' <span class=\"sky ' + (/filled/i.test(deal.offer_status) ? 'ok' : 'wait') + '\">Offer: ' + esc(deal.offer_status) + '</span>' : '') +\n        (deal.skyslope_file ? ' <a href=\"' + esc(deal.skyslope_file) + '\" target=\"_blank\" rel=\"noopener\">Open in SkySlope</a>' : '')\n      : 'Fields marked * are required. Fill in whatever else you have now and add the rest as the deal moves along.';\n    $('saveBtn').textContent = deal.deal_id ? 'Save changes' : 'Submit deal';\n\n    // Details\n    var sections = [];\n    CFG.fields.forEach(function (f) {\n      if (f.sides.indexOf(side) < 0) return;\n      var sec = sections.filter(function (s) { return s.name === f.section; })[0];\n      if (!sec) { sec = { name: f.section, fields: [] }; sections.push(sec); }\n      sec.fields.push(f);\n    });\n    $('detailsPane').innerHTML = sections.map(function (s) {\n      var extra = s.name === 'Purchase offer'\n        ? '<div class=\"offer-actions\"><button type=\"button\" class=\"btn primary\" id=\"offerBtn\">Save &amp; email offer PDF</button>' +\n          '<span class=\"muted\">Emails the filled-in Purchase Offer Agreement to ' + esc(deal.agent_name || (USER.isAdmin ? 'the agent on this deal' : 'you')) +\n          ' and fills the same form in the buyer\\'s SkySlope file.' + (deal.offer_sent ? ' Last sent: ' + esc(deal.offer_sent.replace('T', ' ')) + '.' : '') + '</span></div>'\n        : '';\n      return '<fieldset><legend>' + esc(s.name) + '</legend><div class=\"grid\">' + s.fields.map(function (f) { return fieldHtml(f, side, deal[f.key], !deal.deal_id); }).join('') + extra + '</div></fieldset>';\n    }).join('');\n    if ($('f_offer_date') && !$('f_offer_date').value) $('f_offer_date').value = todayStr();\n    if ($('f_offer_cash_on_deed') && $('f_offer_cash_on_deed').value) $('f_offer_cash_on_deed').setAttribute('data-manual', '1');\n\n    // Milestones\n    var list = CFG.milestones[side] || [];\n    var ms = deal.milestones || {};\n    $('msList').innerHTML = list.map(function (m) {\n      var s = ms[m.key] || {};\n      return '<div class=\"ms' + (s.done ? ' done' : '') + '\" data-ms=\"' + m.key + '\">' +\n        '<input type=\"checkbox\" id=\"ms_' + m.key + '\"' + (s.done ? ' checked' : '') + '>' +\n        '<label for=\"ms_' + m.key + '\" class=\"ml\" style=\"margin:0\">' + esc(m.label) + '</label>' +\n        '<input type=\"date\" aria-label=\"' + esc(m.label) + ' date\" value=\"' + esc(s.date || '') + '\">' +\n        '<input class=\"note\" placeholder=\"Note (optional)\" value=\"' + esc(s.note || '') + '\"></div>';\n    }).join('');\n    updateMsProgress();\n\n    // Docs\n    $('docsLocked').classList.toggle('hidden', !!deal.deal_id);\n    $('docsArea').classList.toggle('hidden', !deal.deal_id);\n    renderDocs(deal.documents || []);\n\n    setTab('details');\n    show('editor');\n    updateStageMarks();\n  }\n\n  function fieldHtml(f, side, val, isNew) {\n    var id = 'f_' + f.key, v = val == null ? '' : val, required = isReq(f, side), req = required ? ' required' : '';\n    if (isNew && v === '') v = f.default || (f.optionsBySide ? '' : '');\n    var wide = f.type === 'textarea' || f.key === 'checklist_type' || f.key === 'represent_both' ? ' wide' : '';\n    var lab = '<label for=\"' + id + '\" class=\"' + (required ? 'req' : '') + '\">' + esc(labelFor(f, side)) + '</label>';\n    var helpText = (f.helpBySide && f.helpBySide[side]) || f.help;\n    var help = helpText ? '<span class=\"help\">' + esc(helpText) + '</span>' : '';\n    var input;\n    if (f.type === 'select') {\n      var opts = optionsFor(f, side);\n      input = '<select id=\"' + id + '\" name=\"' + f.key + '\"' + req + '><option value=\"\">\u2014</option>' +\n        opts.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';\n    } else if (f.type === 'roster') {\n      input = '<input id=\"' + id + '\" name=\"' + f.key + '\" list=\"rosterList\" autocomplete=\"off\" placeholder=\"Start typing a name\" value=\"' + esc(v) + '\">';\n    } else if (f.type === 'textarea') {\n      input = '<textarea id=\"' + id + '\" name=\"' + f.key + '\"' + req + '>' + esc(v) + '</textarea>';\n    } else {\n      var type = { money: 'text', number: 'text', date: 'date', email: 'email', tel: 'tel' }[f.type] || 'text';\n      var mode = f.type === 'money' || f.type === 'number' ? ' inputmode=\"decimal\"' : '';\n      var ph = f.type === 'money' ? ' placeholder=\"$\"' : '';\n      input = '<input id=\"' + id + '\" name=\"' + f.key + '\" type=\"' + type + '\"' + mode + ph + req + ' value=\"' + esc(v) + '\">';\n      if (f.key === 'mls_number') input = '<div class=\"mlsrow\">' + input + '<button type=\"button\" class=\"btn\" id=\"mlsFind\">Find address</button></div>';\n    }\n    return '<div class=\"' + wide.trim() + '\">' + lab + input + help + '</div>';\n  }\n\n  $('msList').addEventListener('change', function (ev) {\n    var row = ev.target.closest('.ms'); if (!row) return;\n    var cb = row.querySelector('input[type=checkbox]'), date = row.querySelector('input[type=date]');\n    if (ev.target === cb && cb.checked && !date.value) date.value = todayStr();\n    if (ev.target === date && date.value && !cb.checked) cb.checked = true;\n    row.classList.toggle('done', cb.checked);\n    // Checking \"Accepted offer\" / \"Contract fully signed\" (or the lease versions) fills that date on Deal details\n    var m = (CFG.milestones[CURRENT.side] || []).filter(function (x) { return x.key === row.getAttribute('data-ms'); })[0];\n    var target = m && { 'Accepted Offer': 'f_acceptance_date', 'Under Contract': 'f_contract_date' }[m.status];\n    if (cb.checked && target && $(target) && !$(target).value && date.value) $(target).value = date.value;\n    updateMsProgress();\n    updateStageMarks();\n  });\n\n  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }\n\n  // ---------- stage requirements (rules come from the server) ----------\n  function fieldVal(k) { var el = $('f_' + k); return el ? el.value.trim() : ''; }\n  function filledKey(k) { var p = k.split('='); var v = fieldVal(p[0]); return p.length > 1 ? v === p[1] : v !== ''; }\n  function commissionGroups(side) {\n    var listing = ['listing_comm_pct', 'listing_comm_amt'], buying = ['sale_comm_pct', 'sale_comm_amt'];\n    if (fieldVal('represent_both') === 'Yes') return [listing, buying];\n    return (side === 'Seller' || side === 'Landlord') ? [listing] : [buying];\n  }\n  function stageCheck() {\n    if (!CURRENT) return { stage: '', missing: [], keys: [] };\n    var side = CURRENT.side, st = $('edStatus').value, R = CFG.statusRank || {};\n    if (st === 'Cancelled' || st === 'TOM') return { stage: '', missing: [], keys: [] };\n    var rank = R[st] || 0;\n    (CFG.milestones[side] || []).forEach(function (m) {\n      var cb = $('ms_' + m.key);\n      if (m.status && cb && cb.checked) rank = Math.max(rank, R[m.status] || 0);\n    });\n    var stage = '', missing = [], keys = [];\n    Object.keys(CFG.stageRules || {}).forEach(function (name) {\n      if (!rank || rank < R[name]) return;\n      stage = name;\n      CFG.stageRules[name].forEach(function (rule) {\n        var groups = rule.commission ? commissionGroups(side) : rule.anyOf;\n        var ok = rule.commission\n          ? groups.every(function (alts) { return alts.some(filledKey); })\n          : groups.some(function (g) { return g.every(filledKey); });\n        if (!ok) {\n          if (missing.indexOf(rule.label) < 0) missing.push(rule.label);\n          groups.forEach(function (g) { g.forEach(function (k) { keys.push(k.split('=')[0]); }); });\n        }\n      });\n    });\n    return { stage: stage, missing: missing, keys: keys };\n  }\n  function updateStageMarks() {\n    var r = stageCheck(), b = $('stageBanner');\n    Array.prototype.forEach.call(document.querySelectorAll('#detailsPane .need'), function (el) { el.classList.remove('need'); });\n    r.keys.forEach(function (k) { var el = $('f_' + k); if (el) el.closest('#detailsPane > fieldset > .grid > div').classList.add('need'); });\n    if (!r.stage) { b.classList.add('hidden'); return r; }\n    b.classList.remove('hidden');\n    b.classList.toggle('ok', !r.missing.length);\n    b.innerHTML = r.missing.length\n      ? '<b>' + esc(r.stage) + '</b>: still needed before you can save: ' + esc(r.missing.join(' \u00b7 ')) + '. Those fields are highlighted on Deal details.'\n      : '<b>' + esc(r.stage) + '</b>: everything this stage needs is filled in.';\n    return r;\n  }\n  $('edStatus').addEventListener('change', updateStageMarks);\n  $('detailsPane').addEventListener('input', updateStageMarks);\n  $('detailsPane').addEventListener('change', updateStageMarks);\n  $('detailsPane').addEventListener('click', function (ev) {\n    if (ev.target.id !== 'mlsFind') return;\n    var mls = fieldVal('mls_number');\n    if (!mls) { toast('Type the MLS # first.', true); return; }\n    var btn = ev.target; busy(btn, true, 'Looking\u2026');\n    call('lookupMls', TOKEN, mls).then(function (f) {\n      if (!f) { toast('MLS # ' + mls + ' isn\\'t on the office inventory yet. Type the address, or save with just the MLS #: the SkySlope file will import the address from the MLS.', true); return; }\n      var filled = [];\n      [['street_number', 'street_number'], ['street_name', 'street_name'], ['city', 'city'], ['list_price', 'list_price']].forEach(function (p) {\n        var el = $('f_' + p[0]); if (el && !el.value.trim() && f[p[1]]) { el.value = f[p[1]]; filled.push(p[0].replace('_', ' ')); }\n      });\n      toast(filled.length ? 'Filled ' + filled.join(', ') + ' from ' + f.source + '.' : 'Found on ' + f.source + '; your address fields were already filled.');\n      updateStageMarks();\n    }).catch(function (e) { toast(e.message, true); }).then(function () { busy(btn, false); });\n  });\n\n  function updateMsProgress() {\n    var rows = document.querySelectorAll('#msList .ms'), done = document.querySelectorAll('#msList .ms.done').length;\n    $('msBar').style.width = rows.length ? Math.round(done / rows.length * 100) + '%' : '0';\n    $('msCount').textContent = '(' + done + '/' + rows.length + ')';\n  }\n\n  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {\n    t.addEventListener('click', function () { setTab(t.getAttribute('data-tab')); });\n  });\n  function setTab(name) {\n    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.classList.toggle('on', t.getAttribute('data-tab') === name); });\n    Array.prototype.forEach.call(document.querySelectorAll('[data-pane]'), function (p) { p.classList.toggle('hidden', p.getAttribute('data-pane') !== name); });\n  }\n\n  /** Reads the form; returns the save input, or null after showing what's missing. */\n  function collectInput() {\n    var side = CURRENT.side, fields = {}, missing = [];\n    CFG.fields.forEach(function (f) {\n      if (f.sides.indexOf(side) < 0) return;\n      var el = $('f_' + f.key); var v = el ? el.value.trim() : '';\n      fields[f.key] = v;\n      if (el) el.style.borderColor = '';\n      if (isReq(f, side) && !v) { missing.push(labelFor(f, side)); if (el) el.style.borderColor = 'var(--bad)'; }\n    });\n    if (USER.isAdmin && !$('edAgent').value) missing.unshift('Agent on this deal');\n    var sc = updateStageMarks();\n    if (!missing.length && sc.missing.length) { setTab('details'); toast(sc.stage + ': please fill in ' + sc.missing.join(', '), true); return null; }\n    if (missing.length) { setTab('details'); toast('Please fill in: ' + missing.join(', '), true); return null; }\n\n    var milestones = {};\n    Array.prototype.forEach.call(document.querySelectorAll('#msList .ms'), function (row) {\n      milestones[row.getAttribute('data-ms')] = {\n        done: row.querySelector('input[type=checkbox]').checked,\n        date: row.querySelector('input[type=date]').value,\n        note: row.querySelector('.note').value\n      };\n    });\n\n    return { deal_id: CURRENT.deal_id || '', side: side, status: $('edStatus').value, fields: fields, milestones: milestones, agent_email: USER.isAdmin ? $('edAgent').value : '' };\n  }\n\n  function reopenAfterSave(res) {\n    return call('getDeal', TOKEN, res.deal_id).then(function (d) {\n      var tab = document.querySelector('.tab.on').getAttribute('data-tab');\n      var y = window.scrollY;\n      openEditor(d); setTab(tab); refreshListQuiet(); window.scrollTo(0, y);\n    });\n  }\n\n  $('dealForm').addEventListener('submit', function (ev) {\n    ev.preventDefault();\n    var input = collectInput();\n    if (!input) return;\n    var btn = $('saveBtn'); busy(btn, true, 'Saving\u2026');\n    call('saveDeal', TOKEN, input)\n      .then(function (res) {\n        var msg = res.isNew ? 'Deal submitted (' + res.deal_id + '). Queued for SkySlope.' : 'Changes saved.';\n        if (res.status && res.status !== $('edStatus').value) msg += ' Status moved to ' + res.status + '.';\n        if (res.inventory && !res.inventory.ok) toast(msg + ' Office inventory note: ' + res.inventory.message, true); else toast(msg);\n        return call('getDeal', TOKEN, res.deal_id).then(function (d) {\n          var tab = document.querySelector('.tab.on').getAttribute('data-tab');\n          openEditor(d); setTab(tab); refreshListQuiet();\n        });\n      })\n      .catch(function (e) { toast(e.message, true); })\n      .then(function () { busy(btn, false); btn.textContent = CURRENT && CURRENT.deal_id ? 'Save changes' : 'Submit deal'; });\n  });\n\n  // ---------- purchase offer (buyer deals) ----------\n  var OFFER_NEEDS = { offer_date: 1, offer_price: 1, street_number: 1, street_name: 1, city: 1, sale_comm_pct: 1, offer_comp_from_proceeds: 1 };\n  $('detailsPane').addEventListener('click', function (ev) {\n    if (ev.target.id !== 'offerBtn') return;\n    var gaps = Object.keys(OFFER_NEEDS).filter(function (k) { return !fieldVal(k); });\n    gaps.forEach(function (k) { var el = $('f_' + k); if (el) el.style.borderColor = 'var(--bad)'; });\n    if (gaps.length) {\n      var names = gaps.map(function (k) { var f = CFG.fields.filter(function (x) { return x.key === k; })[0]; return f ? labelFor(f, 'Buyer') : k; });\n      toast('To create the offer, fill in: ' + names.join(', '), true); return;\n    }\n    var input = collectInput();\n    if (!input) return;\n    var btn = ev.target; busy(btn, true, 'Creating offer\u2026');\n    call('sendPurchaseOffer', TOKEN, input)\n      .then(function (res) {\n        toast('Offer PDF emailed to ' + res.emailed_to + '. It\\'s queued to be filled in on the buyer\\'s SkySlope file.');\n        return reopenAfterSave(res);\n      })\n      .catch(function (e) { toast(e.message, true); })\n      .then(function () { busy(btn, false); });\n  });\n  function num(k) { return Number(String(fieldVal(k)).replace(/[$,\\s]/g, '')) || 0; }\n  $('detailsPane').addEventListener('input', function (ev) {\n    var id = ev.target.id;\n    if (id === 'f_offer_cash_on_deed') { ev.target.setAttribute('data-manual', ev.target.value ? '1' : ''); return; }\n    if (['f_offer_price', 'f_offer_cash_on_signing', 'f_offer_mortgage'].indexOf(id) < 0) return;\n    var deed = $('f_offer_cash_on_deed');\n    if (!deed || deed.getAttribute('data-manual') === '1' || !num('offer_price')) return;\n    deed.value = String(num('offer_price') - num('offer_cash_on_signing') - num('offer_mortgage'));\n  });\n\n  function refreshListQuiet() { call('listDeals', TOKEN).then(function (d) { DEALS = d || []; }).catch(function () {}); }\n\n  // ---------- documents ----------\n  function renderDocs(docs) {\n    $('docList').innerHTML = docs.length ? docs.map(function (d) {\n      var sentOk = d.status === 'Sent to SkySlope';\n      var chip = '<span class=\"sky ' + (sentOk ? 'ok' : d.status === 'Error' ? 'err' : 'wait') + '\">' + esc(sentOk ? 'In SkySlope' : d.status === 'Error' ? 'Error: Mac has been told' : 'Waiting for SkySlope file') + '</span>';\n      return '<div class=\"doc\"><div><b>' + esc(d.name) + '</b><div class=\"muted\" style=\"font-size:12px\">' + esc(d.category) + '</div></div>' +\n        '<div style=\"text-align:right\"><div>' + chip + '</div><div class=\"muted\" style=\"font-size:12px;white-space:nowrap;margin-top:4px\">' + esc(String(d.sent_at || d.uploaded || '').slice(0, 10)) + '</div></div></div>';\n    }).join('') : '<p class=\"muted\">No documents uploaded yet.</p>';\n    var hasFile = CURRENT && /@skyslope\\.com$/i.test(String(CURRENT.skyslope_email || ''));\n    $('docsHelp').textContent = hasFile\n      ? 'Uploads go straight into this deal\\'s SkySlope file (Documents tab).'\n      : 'Uploads go straight into this deal\\'s SkySlope file. The file is being opened now; anything you upload before then is sent automatically as soon as it is.';\n  }\n\n  $('uploadBtn').addEventListener('click', function () {\n    var files = Array.prototype.slice.call($('docFile').files || []);\n    if (!files.length) { toast('Choose a file first.', true); return; }\n    var big = files.filter(function (f) { return f.size > CFG.maxUploadBytes; });\n    if (big.length) { toast(big[0].name + ' is over 20 MB.', true); return; }\n    var btn = $('uploadBtn'); busy(btn, true, 'Uploading\u2026');\n    var cat = $('docCat').value;\n    files.reduce(function (p, file) {\n      return p.then(function () {\n        return readB64(file).then(function (data) {\n          return call('uploadDocument', TOKEN, CURRENT.deal_id, { name: file.name, mimeType: file.type, data: data, category: cat });\n        }).then(renderDocs);\n      });\n    }, Promise.resolve())\n      .then(function () { $('docFile').value = ''; toast(files.length + ' file' + (files.length > 1 ? 's' : '') + (/@skyslope\\.com$/i.test(String(CURRENT.skyslope_email || '')) ? ' sent to SkySlope.' : ' queued for SkySlope.')); })\n      .catch(function (e) { toast(e.message, true); })\n      .then(function () { busy(btn, false); });\n  });\n\n  function readB64(file) {\n    return new Promise(function (resolve, reject) {\n      var r = new FileReader();\n      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };\n      r.onerror = function () { reject(new Error('Could not read ' + file.name)); };\n      r.readAsDataURL(file);\n    });\n  }\n})();\n</script>\n</body>\n</html>\n";
