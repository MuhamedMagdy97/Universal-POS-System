# MVP Scope

## In
See requirements.md (MVP list). Plus: onboarding selector with Included /
Coming-soon labels, Egypt + Saudi/Gulf presets (EGP/SAR, VAT 14%/15%),
bilingual EN/AR strings, online-only checkout, manual payments.

## Out (explicit)
Full industry modules, payment-provider integration, offline checkout,
native mobile/desktop, microservices/K8s/broker, e-commerce, full accounting,
e-invoicing certification, legacy migrations.

## Assumptions to confirm
- Manual cash + card + wallet (payment question was unanswered — default taken).
- RTL-ready CSS in MVP, full RTL QA in Next.
- Walk-in customers only (no Customer entity in MVP).
- Negative stock blocked by default; voids same-shift by default.
