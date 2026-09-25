# Anonymous financial reference

The file `examples/financial-institution.reference.json` is an anonymous reference configuration that demonstrates how a regulated financial use case fits the generic platform.

It intentionally contains no real customer names, endpoints, credentials, legal text, phone numbers or commercial values.

## Patterns demonstrated

- versioned personal-data consent;
- identity collection and customer resolution;
- institution-owned OTP sent to the authoritative registered destination;
- identity-bound verification;
- active-product discovery;
- one-vs-many product selection;
- deterministic balance, credit and movement rendering;
- quote before a side effect;
- explicit confirmation;
- idempotent document generation;
- WhatsApp document delivery;
- institution-owned email delivery.

The same primitives can model insurance claims, healthcare appointments, retail orders, customer onboarding and many other processes.

## Identity-bound authorization

The verification step can bind a successful challenge to the resolved customer:

```json
{
  "type": "verification",
  "subjectFrom": "customer.customerId"
}
```

A sensitive tool then declares:

```json
{
  "requiresVerification": "otp",
  "verificationSubjectFrom": "customerId"
}
```

A valid verification for one customer cannot authorize a tool call for another customer.

## Provider agnosticism

The workflow does not know how OTP is implemented. It calls configured start/verify tools. Those tools may wrap an institution API, Cognito, Twilio, the built-in SNS/SES adapter or a future native provider.

Likewise, balances, documents and email are ordinary tools. Customer-specific contracts remain at the integration/configuration boundary.

## Confidentiality rule

Do not commit customer RFCs or derived customer-specific details to a public repository. Production tenant configuration should live in an approved private control plane or deployment repository.
