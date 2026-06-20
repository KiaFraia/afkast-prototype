# Afkast (arbejdstitel)

A focused, low-cost alternative to Resights.dk aimed at the segment Resights prices out:
private and small-scale Danish real estate investors. v1 wedge = an **investment-case
calculator**: type an address → property facts auto-fill → see yield, cash-flow and
return on equity.

## Status: prototype (concept validation)

`index.html` is a self-contained, deployable prototype. The **flow and math are real**;
the property data is illustrative (4 hardcoded example addresses). No build step.

- Open locally: double-click `index.html`, or `open index.html`.
- Deploy: drop the folder on Vercel / Netlify / GitHub Pages for a shareable URL.

## What's real vs. mock

| Real | Mock (for now) |
| --- | --- |
| Calculator logic (afkast, likviditet, egenkapitalforrentning, break-even) | Property facts (4 example addresses) |
| UI / flow / Danish wording | Live registry data |
| Waitlist form (UI) | Form backend — see TODO in `index.html` |

## Next steps

1. **Validate**: deploy, share with Danish investors, wire the waitlist form to a real
   endpoint (Formspree / Tally / own API) and measure sign-ups.
2. **Phase 1 — data spine**: register Datafordeler API access; apply early for the gated
   sources (VUR/Vurderingsstyrelsen, Energimærke/Energistyrelsen). Build address (DAWA) →
   BFE → BBR + EJF + VUR + energy + Plandata resolver.
3. **Rebuild as a real app** (Next.js + Postgres/PostGIS + Stripe) once the concept holds.

## Data sources (Phase 1, all free/open)

DAWA (addresses) · BBR (building facts) · EJF (owner + last sale) · VUR (valuation +
ground tax) · Energimærke · Plandata (zoning). Tinglysning (title/mortgage) deferred to a
later phase. No personal owner data in v1 → avoids GDPR controller burden initially.
