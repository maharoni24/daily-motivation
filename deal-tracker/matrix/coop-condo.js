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
