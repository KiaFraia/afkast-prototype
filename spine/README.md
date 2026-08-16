# Data spine — real Danish property data

Turns an input (adresse, later navn/CVR) into a merged **ejendomsprofil** using the
public registries, joined on the **BFE number**:

```
adresse ──(DAWA, open)──> DAR id + matrikel + BFE
BFE ──(Datafordeler, service user)──> Matriklen (SFE, areal)
                                      BBR (grund, bygninger, enheder)
                                      EJF (ejere)          <- may need approval
merged ──> ejendomsprofil JSON
```

**Ground-truth test property:** Boulevarden 5, 4760 Vordingborg — BFE **5393320**
(from the partner's Resights screenshots; our output must match those numbers).

## Status

**PHASE 1 PROVEN (16-08-2026): 11/11 fields match the Resights ground truth.**
`node spine/profile.mjs "Boulevarden 5, 4760 Vordingborg"` returns the merged
profile — BFE, matrikel, grundareal 413, bygningsareal 104, boligareal 168,
opført 1924, kælder 102, tagetage 64, garage 2007/18 m², ejerforhold
Privatpersoner — all identical to the partner's Resights screenshot.

| Step | Source | Auth | Status |
|---|---|---|---|
| adresse → DAR id, matrikel, BFE, grundareal | DAWA (api.dataforsyningen.dk) | none — fully open | ✅ |
| adresse-detaljer | DAR via Datafordeler | none — fully open | ✅ |
| BFE → bygninger (incl. etager) + ejendomsrelation | BBR (`/BBR/BBRPublic/1/rest/…`) | tjenestebruger (adgangskode) | ✅ |
| BFE → SFE | Matriklen2 (`/Matriklen2/Matrikel/2.0.0/rest/SamletFastEjendom?SFEBFEnr=`) | tjenestebruger | ✅ |
| BFE → beliggenhed | EBR (`/EBR/Ejendomsbeliggenhed/1/rest/Ejendomsbeliggenhed?BFEnr=`) | tjenestebruger | ✅ |
| BFE → **ejernavne** | EJF — `s5-certservices.datafordeler.dk` | **OCES virksomhedscertifikat + IP** ("Certifikat og IP"); adgang styres af Geodatastyrelsen | ⏳ next step — needs company certificate |

Empirical notes: a *webbruger* login gives 500 on the services; a proper
*tjenestebruger* (adgangskode type) opens BBR/MAT/EBR directly — no per-service
grant needed. EJF (owner names) is the only certificate-gated source; until then
the profile carries `ejerforhold` (e.g. "Privatpersoner") without names.
Datafordeler REST is phased out end-2026 → plan a GraphQL migration later.

Known wrinkle: for **ejerlejligheder** DAWA gives the *parent* property's BFE; the
unit's own BFE comes from the credentialed BBR/EBR lookup (phase 1).

## Getting Datafordeler access (one-time, ~30 min)

1. Go to **selvbetjening.datafordeler.dk** → create/log in as **webbruger**
   (MitID may be required for an organisation account).
2. Under **Brugere**, create a **tjenestebruger** (service user) of type
   *adgangskode* (username + password). Note both down.
3. That's enough for BBR/Matriklen/DAR/EBR. If **EJF** (owner names) refuses,
   file its access request from the same portal — this is the only source with
   an approval step, so start it early.
4. Store the credentials as secrets in the data-spine Worker (never in the app).

## Next (phase 1)

With credentials: extend `resolve.mjs` to fetch Matriklen + BBR + EJF for BFE
5393320, merge, and diff against the Resights screenshot values (grundareal 413 m²,
bygningsareal 104 m², opført 1924, ejer, handel 31-03-2006 / 1.065.000 kr).
