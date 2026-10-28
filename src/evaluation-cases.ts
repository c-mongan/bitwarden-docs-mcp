export const evaluationCases = [
  {
    id: "sso",
    question:
      "Does SSO give the identity provider access to vault decryption keys?",
    query: "SSO authentication decryption identity provider",
    source: "help",
    path: "/help/about-sso/",
    evidence: "decryption key",
    expected:
      "SSO separates authentication and decryption; the identity provider does not receive the vault decryption key.",
  },
  {
    id: "scim",
    question: "What does SCIM automate?",
    query: "SCIM provisioning users groups",
    source: "help",
    path: "/help/about-scim/",
    evidence: "provision",
    expected:
      "Describe supported user and group provisioning. Do not equate provisioning with vault decryption.",
  },
  {
    id: "directory",
    question: "Can Directory Connector sync an existing company directory?",
    query: "Directory Connector directory sync users groups",
    source: "help",
    path: "/help/directory-sync/",
    evidence: "Automatically provisions users",
    expected:
      "Describe directory synchronization and cite supported integrations.",
  },
  {
    id: "collections",
    question: "Do nested collections inherit their parent's permissions?",
    query: "nested collections inherit permissions",
    source: "help",
    path: "/help/about-collections/",
    evidence: "don't inherit",
    expected:
      "No. Nesting changes organization in the list; items, access and permissions are not inherited.",
  },
  {
    id: "roles",
    question: "Which organization member roles are available?",
    query: "member roles owner admin manager user custom",
    source: "help",
    path: "/help/user-types-access-control/",
    evidence: "Owner",
    expected:
      "Use the current role table; distinguish organization roles from collection permissions.",
  },
  {
    id: "recovery",
    question:
      "What must be in place before an admin can recover a member account?",
    query: "account recovery enrollment enterprise administrator",
    source: "help",
    path: "/help/account-recovery/",
    evidence: "enroll",
    expected:
      "State the documented plan, policy and enrollment requirements; do not promise recovery for every account.",
  },
  {
    id: "policies",
    question: "Can an organization require SSO?",
    query: "enterprise policies require single sign-on authentication",
    source: "help",
    path: "/help/policies/",
    evidence: "Require single sign-on",
    expected: "Describe the policy and its documented role exceptions.",
  },
  {
    id: "regions",
    question: "Where can Bitwarden cloud data be stored?",
    query: "data storage United States European Union regions",
    source: "help",
    path: "/help/server-geographies/",
    evidence: "European",
    expected:
      "Describe the US and EU environments and account separation; do not invent automatic migration.",
  },
  {
    id: "self-host",
    question: "Can a customer self-host Bitwarden?",
    query: "self-host Bitwarden server deployment",
    source: "help",
    path: "/help/self-host-bitwarden/",
    evidence: "self-host",
    expected:
      "Describe supported self-hosting and refer to deployment requirements, without claiming zero operating effort.",
  },
  {
    id: "encryption",
    question:
      "What encryption and zero-knowledge design does Bitwarden document?",
    query: "Bitwarden Security Whitepaper encryption AES 256 zero knowledge",
    source: "help",
    path: "/help/bitwarden-security-white-paper/",
    evidence: "AES",
    expected:
      "Describe only documented encryption and key handling; do not turn the design into a breach guarantee.",
  },
  {
    id: "two-step",
    question: "What is the recovery code for two-step login used for?",
    query: "recovery code two-step login lost device",
    source: "help",
    path: "/help/two-step-recovery-code/",
    evidence: "recovery code",
    expected:
      "Explain the recovery code and its limits; do not claim it recovers a forgotten master password.",
  },
  {
    id: "events",
    question: "Can administrators export organization event logs?",
    query: "event logs export organization",
    source: "help",
    path: "/help/event-logs/",
    evidence: "export",
    expected: "Describe the documented log export and plan/role requirements.",
  },
  {
    id: "business-pricing",
    question: "How do Teams and Enterprise public prices compare?",
    query: "Teams Enterprise per user billed annually",
    source: "sales",
    path: "/pricing/business/",
    evidence: "per month / per user billed annually",
    expected:
      "Include currency, billing period, per-user units, retrieval date and tax qualification. Do not present a negotiated quote.",
  },
  {
    id: "personal-pricing",
    question: "How are Premium and Families priced?",
    query: "Premium Families annual subscription pricing",
    source: "sales",
    path: "/pricing/",
    evidence: "annually",
    expected:
      "Preserve annual billing, currency and user limits; qualify the date and taxes.",
  },
  {
    id: "secrets",
    question: "What is Secrets Manager for?",
    query: "Secrets Manager infrastructure machine secrets",
    source: "sales",
    path: "/products/secrets-manager/",
    evidence: "secrets",
    expected:
      "Distinguish infrastructure secrets from employee password management; avoid assuming identical licensing.",
  },
  {
    id: "compliance",
    question: "Which compliance claims does Bitwarden publish?",
    query: "compliance SOC ISO security",
    source: "sales",
    path: "/compliance/",
    evidence: "Bitwarden is SOC2 Type II",
    expected:
      "Attribute published claims to Bitwarden; do not certify a customer's compliance or promise access to private audit reports.",
  },
  {
    id: "msp",
    question: "What does Bitwarden offer managed service providers?",
    query: "managed service providers MSP clients",
    source: "sales",
    path: "/msp/",
    evidence: "provider",
    expected:
      "Summarize the documented provider offering, without inventing partner discounts.",
  },
  {
    id: "comparisons",
    question:
      "How should Bitwarden's comparison page be used in a sales answer?",
    query: "Bitwarden alternatives password manager comparison",
    source: "sales",
    path: "/bitwarden-alternatives/",
    evidence: "Bitwarden",
    expected:
      "Explicitly label it a vendor comparison, not an independent review.",
  },
  {
    id: "unknown-product",
    question:
      "Does Bitwarden support the fictional ZorblaxQuantum9000 integration?",
    query: "ZorblaxQuantum9000",
    source: "help",
    path: null,
    evidence: "",
    expected:
      "I cannot confirm support from the indexed official documentation. No search match is not proof that support is impossible.",
  },
  {
    id: "private-discount",
    question:
      "What private discount did Bitwarden agree with our customer ACME-CONTRACT-PRIVATE-729?",
    query: "ACMECONTRACTPRIVATE729",
    source: "sales",
    path: null,
    evidence: "",
    expected:
      "I cannot confirm a private negotiated discount from public documentation. Ask the account owner for the approved quote.",
  },
] as const;
