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
