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
