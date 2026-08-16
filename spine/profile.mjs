// Data spine — step 2: adresse -> merged ejendomsprofil (real registry data)
//
// Usage:  node spine/profile.mjs "Boulevarden 5, 4760 Vordingborg"
//
// Chains: DAWA (adresse->BFE) -> BBR bygninger + ejendomsrelation -> Matriklen SFE
//         -> EBR beliggenhed. EJF (owner names) requires certificate auth — see README.
// Credentials: spine/.env (git-ignored) with DAF_USER / DAF_PASS.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { resolveAddress } from "./resolve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, ".env"), "utf8")
    .split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const DAF = "https://services.datafordeler.dk";

// BBR kodelister (subset)
const ANVENDELSE = { 110: "Stuehus til landbrug", 120: "Fritliggende enfamilieshus", 121: "Sammenbygget enfamiliehus", 130: "Række-/kædehus", 140: "Etagebolig-bygning", 190: "Anden helårsbeboelse", 910: "Garage", 920: "Carport", 930: "Udhus" };
const EJERFORHOLD = { 10: "Privatpersoner", 20: "Alment boligselskab", 30: "Aktie-/anpartsselskab", 40: "Forening/legat/selvejende institution", 41: "Privat andelsboligforening", 50: "Staten", 60: "Region", 70: "Kommune", 80: "Andet", 90: "Ikke fastlagt" };
const EJENDOMSTYPE = { 1: "Samlet fast ejendom", 2: "Ejerlejlighed", 3: "Bygning på fremmed grund" };

async function daf(path, params) {
  const u = new URL(`${DAF}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("username", env.DAF_USER);
  u.searchParams.set("password", env.DAF_PASS);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${r.status} on ${path}`);
  return r.json();
}

export async function buildProfile(query) {
  const base = await resolveAddress(query);
  if (!base.bfe) throw new Error("Kunne ikke finde BFE for adressen");

  const [bygninger, relation, sfe, ebr] = await Promise.all([
    daf("BBR/BBRPublic/1/rest/bygning", { husnummer: base.darId }),
    daf("BBR/BBRPublic/1/rest/ejendomsrelation", { bfeNummer: base.bfe }),
    daf("Matriklen2/Matrikel/2.0.0/rest/SamletFastEjendom", { SFEBFEnr: base.bfe }),
    daf("EBR/Ejendomsbeliggenhed/1/rest/Ejendomsbeliggenhed", { BFEnr: base.bfe }),
  ]);

  const aktiveBygninger = bygninger
    .filter((b) => b.status === "6") // 6 = opført/gældende
    .map((b) => ({
      nr: b.byg007Bygningsnummer,
      anvendelse: ANVENDELSE[b.byg021BygningensAnvendelse] || b.byg021BygningensAnvendelse,
      opført: b.byg026Opførelsesår,
      bebyggetArealM2: b.byg041BebyggetAreal ?? null,
      samletBygningsarealM2: b.byg038SamletBygningsareal ?? null,
      boligarealM2: b.byg039BygningensSamledeBoligAreal ?? null,
      kælderM2:
        (b.etageList || []).find((e) => e.etage?.eta006BygningensEtagebetegnelse === "kl")
          ?.etage?.eta020SamletArealAfEtage ?? null,
      tagetageM2:
        (b.etageList || [])
          .map((e) => e.etage?.eta021ArealAfUdnyttetDelAfTagetage)
          .find((v) => v != null) ?? null,
    }))
    .sort((a, b) => (a.nr ?? 99) - (b.nr ?? 99));

  const rel = Array.isArray(relation) ? relation[0] : relation;
  const sfeProps = sfe?.features?.[0]?.properties ?? null;

  return {
    adresse: base.adresse,
    bfe: base.bfe,
    kommune: base.kommune,
    koordinater: base.koordinater,
    matrikel: { ...base.matrikel, grundarealM2: base.grundarealM2 },
    ejendomstype: rel ? (EJENDOMSTYPE[rel.ejendomstype] || rel.ejendomstype) : null,
    ejerforhold: rel ? (EJERFORHOLD[rel.ejendommensEjerforholdskode] || rel.ejendommensEjerforholdskode) : null,
    kommunaltEjendomsnummer: rel?.ejendomsnummer ?? null,
    sfeBekræftet: sfeProps?.BFEnummer === base.bfe,
    bygninger: aktiveBygninger,
    boligarealIAltM2: aktiveBygninger.reduce((s, b) => s + (b.boligarealM2 || 0), 0),
    ejer: null, // navne kræver EJF certifikat-adgang — se spine/README.md
    kilder: ["DAWA", "BBR", "Matriklen2", "EBR"],
    hentet: new Date().toISOString(),
  };
}

const query = process.argv.slice(2).join(" ");
if (query) {
  buildProfile(query)
    .then((p) => console.log(JSON.stringify(p, null, 2)))
    .catch((e) => { console.error("FEJL:", e.message); process.exit(1); });
}
