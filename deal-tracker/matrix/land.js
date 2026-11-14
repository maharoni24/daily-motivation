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
