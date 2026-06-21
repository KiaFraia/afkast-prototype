# Afkast (arbejdstitel)

A focused, low-cost alternative to Resights.dk for **private and small-scale Danish real
estate investors** — the segment Resights prices out (~16k kr/user/year).

## Concept (after first user feedback)

Initial idea was a standalone yield calculator. Feedback: a calculator is a *feature, not a
product* (Excel replaces it), and it doesn't monetize. The real, payable pain is the
**scattered data across public registries**, and the money is in **deal-flow**.

So v1 pivoted to: **find, analyse and track property deals in one place.**

- **Find deals** — screen the market, surface properties by yield/area/type/price.
- **Overblik** — all essential data per property on one page (BBR, valuation, energy,
  zoning, last sale) + the investment calculator as one section.
- **Min pipeline** — a lightweight CRM: save deals, set status, take notes.

Owner-outreach / lead-gen (find owner → contact them) is **deferred** — it needs personal
contact data + a GDPR controller setup. Add once traction is proven.

## Status: prototype (concept validation)

`index.html` is a self-contained, deployable prototype. **Flow, math and the pipeline are
real** (pipeline persists in localStorage); property data is illustrative (12 example
properties). No build step.

- Live: https://kiafraia.github.io/afkast-prototype/
- Local: `open index.html`
- Deploy updates: push to `main` → GitHub Pages rebuilds (~1 min).

## Next steps

1. **Validate**: re-share the live URL; wire the waitlist form to a real endpoint
   (Formspree / Tally / own API) to capture sign-ups.
2. **Phase 1 — data spine**: register Datafordeler API access; apply early for gated
   sources (VUR/Vurderingsstyrelsen, Energimærke/Energistyrelsen). Build address (DAWA) →
   BFE → BBR + EJF + VUR + energy + Plandata resolver. For "find deals" (search), this
   needs a nationwide mirror (PostGIS), not just fetch-on-demand.
3. **Rebuild as a real app** (Next.js + Postgres/PostGIS + Stripe) once the concept holds.

## Data sources (Phase 1, all free/open)

DAWA (addresses) · BBR (building facts) · EJF (owner + last sale) · VUR (valuation +
ground tax) · Energimærke · Plandata (zoning). Tinglysning (title/mortgage) and owner
contact data deferred to a later phase.
