# Product Vision — Universal POS System

## What we are building
A modular, multi-tenant POS and business-operations platform. One shared core
(POS, catalog, inventory, payments, users, reporting) plus optional
industry presets. Starts with a realistic MVP, grows incrementally.

## Commercial goal
Smallest credible product that lets a real shop run daily operations,
then expand based on actual demand — not the biggest possible POS.

## Key design choice (Phase 1 decision)
Onboarding shows a business-type selector (Retail, Grocery, Fruit&Veg,
Bakery/Butcher, Restaurant/Café, Salon). The choice applies a **preset**
(currency, VAT default, receipt template, toggles) on top of the same core.
Only the General Retail preset is fully functional in MVP; others boot into
the core with explicit Included / Coming-soon labels. No fake suitability claims.
