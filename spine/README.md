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

| Step | Source | Auth | Status |
|---|---|---|---|
| adresse → DAR id, matrikel, BFE, grundareal, koordinater | DAWA (api.dataforsyningen.dk) | none | ✅ works — `node spine/resolve.mjs "<adresse>"` verified BFE 5393320 + 413 m² |
| adresse-detaljer | DAR via Datafordeler | tjenestebruger | ✅ works with our tjenestebruger (creds in git-ignored `spine/.env`) |
| BFE → bygninger/enheder | BBR (`/BBR/BBRPublic/1/rest/…`) | tjenestebruger **+ tjenesteadgang** | ⏳ 500 until the service is added to the tjenestebruger in selvbetjening |
| BFE → SFE/jordstykker | Matriklen2 (`/Matriklen2/Matrikel/…/rest/…`) | tjenestebruger **+ tjenesteadgang** | ⏳ same — add service |
| BFE ↔ beliggenhedsadresse | EBR (`/EBR/Ejendomsbeliggenhed/1/rest/…`) | tjenestebruger **+ tjenesteadgang** | ⏳ same — add service |
| BFE → ejere | EJF — hosted on `s5-certservices.datafordeler.dk` | **formal access request** (fortrolig tjeneste, certificate) | ⏳ file "anmodning om adgang" — the slow one |

Learned empirically (16-08-2026): credentials alone open DAR; every other service
returns a blanket `500` until *tjenesteadgang* is granted per service in
selvbetjening. EJF's full owner data is a "fortrolig" service behind a formal
request + certificate host. Datafordeler REST is being phased out end-2026 →
plan a GraphQL migration later.

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
