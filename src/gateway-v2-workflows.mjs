const textInput = { type: "string", minLength: 1, maxLength: 500 };

/** Extend discovery with fixed recipes using the shared quote and approval flow. */
export function addWorkflowDiscovery(discover) {
  discover.properties.workflow = {
    type: "object",
    description: "Start a fixed workflow instead of a free-text question. Use only identifiers supplied by the user or a source. Pre-KYB Screening checks a business before full KYB; missing or unsupported checks remain explicit. Company dossier: NL, GB, FR, BE, FI, NO, LV, EE, SE, DK, SK. Tender counterparty dossier: NL, FR. Dossiers include registered identity, screening of the registry-returned name and available filings; tender adds bounded notice links. Purchases use the gateway's existing quote and approval rules.",
    oneOf: [
      {
        type: "object", additionalProperties: false, required: ["slug", "input"],
        properties: {
          slug: { type: "string", enum: ["european-company-dossier", "tender-company-dossier"] },
          input: { type: "object", additionalProperties: false, required: ["name", "country", "registration"], properties: {
            name: textInput,
            country: { type: "string", enum: ["NL", "GB", "FR", "BE", "FI", "NO", "LV", "EE", "SE", "DK", "SK"] },
            registration: textInput,
          } },
        },
      },
      {
        type: "object", additionalProperties: false, required: ["slug", "input"],
        properties: {
          slug: { type: "string", const: "pre-kyb-screening" },
          input: {
            type: "object", additionalProperties: false, required: ["name", "country", "screening_level"],
            properties: {
              name: textInput,
              country: { type: "string", enum: ["NL", "GB", "FR"] },
              registration: { ...textInput, description: "National company registration number, if known. Avoids a paid name search. Never invent one." },
              domain: { ...textInput, description: "Company website domain, such as example.com. Checks domain registration; Enhanced also checks mail DNS." },
              vat_country: { type: "string", enum: ["NL", "BE", "DE", "FR", "IE", "ES", "IT", "AT", "DK", "SE", "FI", "PL", "PT", "LU", "EL", "XI"], description: "VAT country code. Supply together with vat_number or omit both." },
              vat_number: { ...textInput, description: "VAT number without its country prefix." },
              iban: { ...textInput, description: "Optional at either screening level. Validates the IBAN and available bank details, not account ownership." },
              screening_level: { type: "string", enum: ["Standard", "Enhanced"], description: "Use Standard unless Enhanced is requested. Standard checks registered identity and company sanctions, plus supplied domain, VAT and IBAN. Enhanced adds available country-specific records (UK officers, controllers and insolvency; Dutch accounts; French financials and alerts) and mail DNS." },
            },
            dependencies: { vat_country: ["vat_number"], vat_number: ["vat_country"] },
          },
        },
      },
    ],
  };
  delete discover.required;
  discover.oneOf = [{ required: ["question"], not: { required: ["workflow"] } }, { required: ["workflow"], not: { anyOf: [{ required: ["question"] }, { required: ["state"] }, { required: ["context_delta"] }] } }];
}
