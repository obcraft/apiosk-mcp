/** Extend discovery with fixed, approval-gated company dossier recipes. */
export function addDossierDiscovery(discover) {
  discover.properties.workflow = {
    type: "object", additionalProperties: false, required: ["slug", "input"],
    description: "Start a fixed dossier instead of a free-text question. Use only identifiers supplied by the user or a source. Company dossier: NL, GB, FR, BE, FI, NO, LV, EE, SE, DK, SK. Tender counterparty dossier: NL, FR. Both include registered identity, screening of the registry-returned name and available filings; tender adds bounded notice links. No purchase until approval.",
    properties: {
      slug: { type: "string", enum: ["european-company-dossier", "tender-company-dossier"] },
      input: { type: "object", additionalProperties: false, required: ["name", "country", "registration"], properties: {
        name: { type: "string", minLength: 1, maxLength: 500 },
        country: { type: "string", enum: ["NL", "GB", "FR", "BE", "FI", "NO", "LV", "EE", "SE", "DK", "SK"] },
        registration: { type: "string", minLength: 1, maxLength: 500 },
      } },
    },
  };
  delete discover.required;
  discover.oneOf = [{ required: ["question"], not: { required: ["workflow"] } }, { required: ["workflow"], not: { anyOf: [{ required: ["question"] }, { required: ["state"] }, { required: ["context_delta"] }] } }];
}
