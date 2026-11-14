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
