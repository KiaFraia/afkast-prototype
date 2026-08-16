// Data spine — step 1: adresse -> BFE (credential-free, via open DAWA API)
//
// Usage:  node spine/resolve.mjs "Boulevarden 5, 4760 Vordingborg"
//
// Resolves a Danish address to the identifiers every other registry keys on:
//   - DAR adgangsadresse id (used by BBR queries)
//   - ejerlav + matrikelnr (Matriklen)
//   - BFE number (THE join key: Matriklen, BBR ejendomsrelation, EJF, Tinglysning)
// Plus the free extras DAWA carries: grundareal (registreretareal) and coordinates.
//
// Phase 1 (needs Datafordeler service user): use the BFE to fetch
// Matriklen (SFE), BBR (grund/bygning/enhed) and EJF (ejere), merge into
// one ejendomsprofil. See spine/README.md.

const DAWA = "https://api.dataforsyningen.dk";

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

export async function resolveAddress(query) {
  // 1. Address -> DAR adgangsadresse (id + vejnavn/husnr + koordinater)
  const hits = await getJson(
    `${DAWA}/adgangsadresser?q=${encodeURIComponent(query)}&per_side=1`
  );
  if (!hits.length) throw new Error(`Ingen adresse fundet for: ${query}`);
  const a = hits[0];

  // 2. Jordstykke -> BFE + registreret areal
  const js = a.jordstykke
    ? await getJson(
        `${DAWA}/jordstykker/${a.jordstykke.ejerlav.kode}/${encodeURIComponent(a.jordstykke.matrikelnr)}`
      )
    : null;

  return {
    adresse: a.adressebetegnelse,
    darId: a.id, // adgangsadresse/husnummer id -> BBR queries
    kommune: { kode: a.kommune?.kode, navn: a.kommune?.navn },
    koordinater: a.adgangspunkt?.koordinater ?? null, // [lon, lat]
    matrikel: js
      ? { ejerlavKode: js.ejerlav.kode, ejerlavNavn: js.ejerlav.navn, matrikelnr: js.matrikelnr }
      : null,
    // The join key for everything else. DAWA sometimes leaves bfenummer empty
    // but carries the same number as sfeejendomsnr (samlet fast ejendom).
    // NOTE: for ejerlejligheder this is the PARENT property's BFE — the unit's
    // own BFE requires the credentialed BBR/EBR lookup (phase 1).
    bfe: js?.bfenummer ?? js?.sfeejendomsnr ?? null,
    grundarealM2: js?.registreretareal ?? null,
  };
}

// CLI entry
const query = process.argv.slice(2).join(" ");
if (query) {
  resolveAddress(query)
    .then((p) => console.log(JSON.stringify(p, null, 2)))
    .catch((e) => {
      console.error("FEJL:", e.message);
      process.exit(1);
    });
}
