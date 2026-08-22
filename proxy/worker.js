// Ejendomsinvestoren backend — Cloudflare Worker
//
// Routes:
//   POST /                     {text} -> AI assistant: natural language -> search filters (Groq)
//   GET  /ejendom?adresse=...  -> merged ejendomsprofil from the public registries
//       - enhedsadresse (med etage/dør)  -> EJERLEJLIGHEDS-profil (lejlighedens egen BFE)
//       - adgangsadresse/hus             -> moderejendom + evt. liste af ejerlejligheder
//
// Secrets: GROQ_API_KEY, DAF_USER, DAF_PASS

// Sider der må kalde denne worker. Begge GitHub Pages-adresser står her, så
// prototypen virker uanset hvilken konto den er udgivet fra.
const ALLOWED_ORIGINS = [
  "https://kiafraia.github.io",
  "https://ejendoms.github.io",
];
const ALLOWED_ORIGIN = ALLOWED_ORIGINS[0]; // svar-default når origin ikke genkendes
// Lokal udvikling: en side på localhost må også kalde, ellers blokerer browseren
// alle opslag når man kører index.html fra sin egen maskine.
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function tilladtOrigin(request) {
  const o = request && request.headers.get("Origin");
  return o && (ALLOWED_ORIGINS.includes(o) || LOCAL_ORIGIN.test(o)) ? o : ALLOWED_ORIGIN;
}
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.1-8b-instant";
const SYS = 'Du er assistent i en dansk ejendomsinvesteringsapp. Oversæt brugerens beskrivelse af ønskede off-market leads til søgefiltre. Svar KUN med JSON på formen {"filters":{"region":"","ownerType":"","minAge":0,"lives":"","minProps":1,"minTenure":0,"maxPrice":0,"type":"","minUnits":1,"minArea":0},"reply":""}. region: Hovedstaden|Midtjylland|Syddanmark|Nordjylland eller tom. ownerType: Privatperson|Selskab eller tom. minAge: ejerens minimumsalder (0=ingen). lives: ja=bor på adressen, nej=fraværende ejer, tom=ligegyldigt. minProps: min antal ejendomme ejeren ejer (1=ingen). minTenure: min ejertid i år (0=ingen). maxPrice: maks seneste handelspris i kroner (0=ingen). type: Enfamiliehus|Flerfamiliehus|Ejerlejlighed eller tom. minUnits: min boligenheder (1=ingen). minArea: min m² (0=ingen). Kriterier der ikke nævnes sættes til 0 eller tom streng. reply: én kort dansk sætning.';

const DAWA = "https://api.dataforsyningen.dk";
const DAF = "https://services.datafordeler.dk";
const ANVENDELSE = { 110: "Stuehus til landbrug", 120: "Fritliggende enfamilieshus", 121: "Sammenbygget enfamiliehus", 130: "Række-/kædehus", 131: "Række-/kædehus", 132: "Dobbelthus", 140: "Etagebolig", 190: "Anden helårsbeboelse", 320: "Erhverv (kontor/handel)", 321: "Kontor", 322: "Detailhandel", 330: "Restaurant/hotel", 910: "Garage", 920: "Carport", 930: "Udhus" };
const EJERFORHOLD = { 10: "Privatpersoner", 20: "Alment boligselskab", 30: "Aktie-/anpartsselskab", 40: "Forening/legat/selvejende institution", 41: "Privat andelsboligforening", 50: "Staten", 60: "Region", 70: "Kommune", 80: "Andet", 90: "Ikke fastlagt", 99: "Ukendt" };
const EJENDOMSTYPE = { 1: "Samlet fast ejendom", 2: "Bygning på fremmed grund", 3: "Ejerlejlighed" };
const YDERVAEG = { 1: "Mursten", 2: "Letbetonsten", 3: "Fibercement herunder asbest", 4: "Bindingsværk", 5: "Træ", 6: "Betonelementer", 8: "Metal", 10: "Fibercement uden asbest", 11: "Plastmaterialer", 12: "Glas", 80: "Ingen", 90: "Andet materiale" };
const TAGDAEKNING = { 1: "Tagpap med lille hældning", 2: "Tagpap med stor hældning", 3: "Fibercement herunder asbest", 4: "Betontagsten", 5: "Tegl", 6: "Metal", 7: "Stråtag", 10: "Fibercement uden asbest", 11: "Plastmaterialer", 12: "Glas", 20: "Levende tage", 80: "Ingen", 90: "Andet materiale" };
const VARME = { 1: "Fjernvarme/blokvarme", 2: "Centralvarme med én fyringsenhed", 3: "Ovn til fast og flydende brændsel", 5: "Varmepumpe", 6: "Centralvarme med to fyringsenheder", 7: "Elvarme", 8: "Gasradiator", 9: "Ingen varmeinstallation", 99: "Registreret på enheder" };
const SUPPLVARME = { 0: "Ikke oplyst", 1: "Varmepumpe", 2: "Brændeovn med skorsten", 3: "Biopejs uden skorsten", 4: "Solvarmeanlæg", 5: "Pejs", 6: "Gasradiator", 7: "Elvarme", 10: "Biogasanlæg", 80: "Andet", 90: "Ingen" };
const AKTIV_STATUS = ["6", "7"]; // 6=Opført, 7=Gældende
// Cloudflare tillader 50 udgaaende kald pr. request paa gratis-planen, og vi
// bruger ét pr. BFE. Over grænsen droppes resten lydloest, saa loftet ligger
// bevidst under. Appen deler store forespoergsler op i flere kald.
const EJERE_MAKS = 45;

// origin gives eksplicit med hver gang — en modulvariabel ville kunne blive
// overskrevet af et samtidigt kald og sende den forkerte origin-header retur.
function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || ALLOWED_ORIGIN,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} fra ${url.split("?")[0]}`);
  return r.json();
}
function dafUrl(path, params, env) {
  const u = new URL(`${DAF}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("username", env.DAF_USER);
  u.searchParams.set("password", env.DAF_PASS);
  return u.toString();
}

// BBR-anvendelseskoder 110-190 er beboelse; alt andet på en enhed regnes som erhverv.
function erBoligEnhed(e) {
  const k = Number(e.enh020EnhedensAnvendelse);
  return k >= 110 && k <= 190;
}
function sumFelt(liste, felt) {
  const tal = liste.map((e) => e[felt]).filter((v) => v != null);
  return tal.length ? tal.reduce((a, b) => a + b, 0) : null;
}
function opgørEnheder(liste) {
  if (!liste || !liste.length) return null;
  return {
    bolig: liste.filter(erBoligEnhed).length,
    erhverv: liste.filter((e) => !erBoligEnhed(e)).length,
    boligArealM2: sumFelt(liste, "enh027ArealTilBeboelse"),
    erhvervArealM2: sumFelt(liste, "enh028ArealTilErhverv"),
  };
}

// Ejeroplysninger fra Geodatastyrelsens eget endpoint bag matriklen.dk.
// Tinglyste ejere er offentlige i Danmark og vises der uden login.
//
// ADVARSEL: Cache-Control-headeren er ikke valgfri. Deres CDN cacher svaret på
// stien alene og ser bort fra bfe-parameteren, så et almindeligt kald returnerer
// den ejendom nogen sidst slog op — altså en FORKERT ejer. Verificeret: samme
// bfe gav to forskellige svar alt efter om headeren var med.
// Headeren kan ikke sendes fra en browser (preflight svarer uden CORS-headere),
// så opslaget skal blive her på serveren.
async function hentEjere(bfe) {
  if (!bfe) return null;
  // Gem svaret hos os i en uge. Uden det rammer hvert kortudsnit matriklen.dk
  // med ét kald pr. ejendom hver gang, og de begynder at afvise os. Ejerskifte
  // sker sjældent nok til at en uge er rigeligt.
  const nøgle = new Request(`https://cache.internal/ejer?v=1&bfe=${encodeURIComponent(bfe)}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(nøgle);
    if (hit) return hit.json();
  }
  try {
    const r = await fetch(`https://api.matriklen.dk/api/v3.2/BfeEjer?bfe=${encodeURIComponent(bfe)}`, {
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const raa = Array.isArray(d.ejere) ? d.ejere : [];
    // type "Fiktiv" er ikke en ejer, men en note som "Opdelt i ejerlejligheder"
    const rigtige = raa.filter((e) => e.type !== "Fiktiv");
    if (!rigtige.length) {
      const note = raa[0] && raa[0].navn;
      return note ? { note } : null;
    }
    const ud = {
      antal: rigtige.length,
      liste: rigtige.map((e) => ({
        navn: e.navn ?? null,
        type: e.type ?? null,
        ejerforhold: EJERFORHOLD[e.ejerforholdskode] || e.ejerforholdskode || null,
        andel: e.faktiskEjerandel ? `${e.faktiskEjerandel.tæller}/${e.faktiskEjerandel.nævner}` : null,
        overtagelsesdato: e.overtagelsesdato ?? null,
        tinglysningsdato: e.tinglysningsdato ?? null,
      })),
    };
    if (cache) {
      await cache.put(nøgle, new Response(JSON.stringify(ud), {
        headers: { "Cache-Control": "max-age=604800", "Content-Type": "application/json" },
      }));
    }
    return ud;
  } catch (e) {
    return null;
  }
}

// Slår ejere op for flere BFE-numre i ét kald, så kortet kan farve matrikler
// efter ejerforhold uden at fyre hundredvis af requests af fra browseren.
async function ejereBatch(bfeListe) {
  const kø = bfeListe.slice(0, EJERE_MAKS);
  const ud = {};
  let i = 0;
  async function arbejd() {
    while (i < kø.length) {
      const b = kø[i++];
      const e = await hentEjere(b);
      if (e && e.liste && e.liste.length) {
        ud[b] = {
          navn: e.liste.map((x) => x.navn).filter(Boolean).join(", "),
          antal: e.antal,
          ejerforhold: e.liste[0].ejerforhold,
          type: e.liste[0].type,
          overtagelsesdato: e.liste[0].overtagelsesdato,
        };
      }
    }
  }
  // Tre ad gangen: matriklen.dk afviser bursts, og vi vil ikke belaste dem unoedigt.
  await Promise.all(Array.from({ length: Math.min(3, kø.length) }, arbejd));
  return ud;
}


// BBR-oplysninger pr. jordstykke, batchet ligesom ejerne. Datafordeleren er et
// licenseret API vi har adgang til, saa volumen er i orden her — modsat
// matriklen.dk, der er en intern backend uden aftale om programmatisk brug.
async function bbrForJordstykke(featureid, bfe, env) {
  const nøgle = new Request(`https://cache.internal/bbr?v=3&js=${encodeURIComponent(featureid)}&b=${encodeURIComponent(bfe || "")}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(nøgle);
    if (hit) return hit.json();
  }
  try {
    // Ejerforholdskoden staar i BBR's ejendomsrelation. Den giver privatperson
    // kontra selskab uden at spoerge matriklen.dk — kun ejerens navn kraever EJF.
    const [byg, relation] = await Promise.all([
      getJson(dafUrl("BBR/BBRPublic/1/rest/bygning", { jordstykke: featureid }, env)).catch(() => null),
      bfe ? getJson(dafUrl("BBR/BBRPublic/1/rest/ejendomsrelation", { bfeNummer: bfe }, env)).catch(() => null) : null,
    ]);
    const rel = Array.isArray(relation) ? relation[0] : relation;
    const ejerforhold = rel ? (EJERFORHOLD[rel.ejendommensEjerforholdskode] || null) : null;
    const ejendomstype = rel ? (EJENDOMSTYPE[rel.ejendomstype] || null) : null;
    const aktive = (byg || []).filter((b) => AKTIV_STATUS.includes(b.status));
    if (!aktive.length && !rel) return null;
    const anv = aktive.map((b) => ANVENDELSE[b.byg021BygningensAnvendelse] || String(b.byg021BygningensAnvendelse || ""));
    const ud = {
      ejerforhold,
      ejendomstype,
      anvendelser: anv,
      kategori: boligKategori(anv),
      // Hovedbygningens aar, ikke garagens. Sorteret numerisk — .sort() uden
      // komparator sorterer som tekst. Aarstal under 1700 er BBR-stoej.
      opført: (() => {
        const gyldige = aktive.filter((b) => b.byg026Opførelsesår >= 1700);
        if (!gyldige.length) return null;
        const medBolig = gyldige.filter((b) => b.byg039BygningensSamledeBoligAreal > 0);
        const kilde = medBolig.length ? medBolig : gyldige;
        return kilde.sort((a, b) =>
          (b.byg039BygningensSamledeBoligAreal || 0) - (a.byg039BygningensSamledeBoligAreal || 0)
          || a.byg026Opførelsesår - b.byg026Opførelsesår
        )[0].byg026Opførelsesår;
      })(),
      boligArealM2: sumFelt(aktive, "byg039BygningensSamledeBoligAreal"),
      bygningsArealM2: sumFelt(aktive, "byg038SamletBygningsareal"),
      antalBygninger: aktive.length,
    };
    if (cache) {
      await cache.put(nøgle, new Response(JSON.stringify(ud), {
        headers: { "Cache-Control": "max-age=604800", "Content-Type": "application/json" },
      }));
    }
    return ud;
  } catch (e) {
    return null;
  }
}

// Samme kategorier som appen viser i badgen, så filter og visning er enige.
function boligKategori(anv) {
  if (anv.some((a) => /etagebolig|flerfamilie/i.test(a))) return "Flerfamiliehus";
  if (anv.some((a) => /række|kæde|dobbelthus/i.test(a))) return "Række-/dobbelthus";
  if (anv.some((a) => /enfamilie|stuehus/i.test(a))) return "Enfamiliehus";
  const navne = anv.filter((a) => a && !/^\d+$/.test(a));
  return navne.length ? navne[0] : null;
}

async function bbrBatch(par, env) {
  // to udgaaende kald pr. ejendom, saa loftet er det halve af ejernes
  const kø = par.slice(0, Math.floor(EJERE_MAKS / 2));
  const ud = {};
  let i = 0;
  async function arbejd() {
    while (i < kø.length) {
      const { js, bfe } = kø[i++];
      const r = await bbrForJordstykke(js, bfe, env);
      if (r) ud[js] = r;
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, kø.length) }, arbejd));
  return ud;
}

async function jordstykkeInfo(js) {
  if (!js) return null;
  const j = await getJson(`${DAWA}/jordstykker/${js.ejerlav.kode}/${encodeURIComponent(js.matrikelnr)}`);
  return {
    ejerlavKode: j.ejerlav.kode, ejerlavNavn: j.ejerlav.navn, matrikelnr: j.matrikelnr,
    grundarealM2: j.registreretareal ?? null, featureid: j.featureid ?? null,
    bfe: j.bfenummer ?? j.sfeejendomsnr ?? null,
  };
}

// Ejerlejlighed: unit address -> the apartment's OWN BFE via BBR enhed
async function buildUnitProfile(a, env) {
  const ag = a.adgangsadresse;
  const enhListe = await getJson(dafUrl("BBR/BBRPublic/1/rest/enhed", { adresseIdentificerer: a.id }, env)).catch(() => []);
  const enh = (enhListe || []).filter((e) => AKTIV_STATUS.includes(e.status))[0];
  const rel = enh && enh.ejerlejlighedList && enh.ejerlejlighedList[0] && enh.ejerlejlighedList[0].ejerlejlighed;
  if (!rel || !rel.bfeNummer) return null; // not an ejerlejlighed -> caller falls back to parent flow

  const mat = await jordstykkeInfo(ag.jordstykke).catch(() => null);
  let matEjl = null;
  if (mat?.bfe) {
    try {
      const r = await getJson(dafUrl("Matriklen2/Matrikel/2.0.0/rest/Ejerlejlighed", { SFEBFEnr: mat.bfe }, env));
      matEjl = (r.features || []).map((f) => f.properties).find((p) => p.BFEnummer === rel.bfeNummer) || null;
    } catch (e) {}
  }

  const parentAdresse = ag.vejstykke && ag.postnummer
    ? `${ag.vejstykke.navn} ${ag.husnr}, ${ag.postnummer.nr} ${ag.postnummer.navn}` : null;

  return {
    adresse: a.adressebetegnelse,
    bfe: rel.bfeNummer,
    kommune: { kode: ag.kommune?.kode, navn: ag.kommune?.navn },
    koordinater: ag.adgangspunkt?.koordinater ?? null,
    matrikel: mat ? { ejerlavKode: mat.ejerlavKode, ejerlavNavn: mat.ejerlavNavn, matrikelnr: mat.matrikelnr, grundarealM2: mat.grundarealM2 } : null,
    ejendomstype: "Ejerlejlighed",
    ejerforhold: EJERFORHOLD[rel.ejendommensEjerforholdskode] || rel.ejendommensEjerforholdskode || null,
    bygninger: [],
    boligarealIAltM2: enh.enh026EnhedensSamledeAreal ?? null,
    // Lejligheden er én enhed — arealopdelingen står på enheden vi allerede har hentet
    enheder: opgørEnheder([enh]),
    ejerlejlighed: {
      nummer: matEjl?.ejerlejlighedsnummer ?? rel.ejerlejlighedsnummer ?? null,
      enhedArealM2: enh.enh026EnhedensSamledeAreal ?? null,
      tinglystArealM2: matEjl?.samletAreal ?? null,
      værelser: enh.enh031AntalVærelser ?? null,
      anvendelse: ANVENDELSE[enh.enh020EnhedensAnvendelse] || enh.enh020EnhedensAnvendelse || null,
      fordelingstal: matEjl && matEjl.fordelingstalTaeller != null ? `${matEjl.fordelingstalTaeller}/${matEjl.fordelingstalNaevner}` : null,
      parentBfe: mat?.bfe ?? null,
      parentAdresse,
    },
    ejerforening: null,
    ejer: await hentEjere(rel.bfeNummer),
    kilder: ["DAWA", "BBR", "Matriklen2", "Matriklen.dk (ejere)"],
  };
}

async function buildProfile(query, env) {
  const q = query.replace(/,\s*,/g, ",").trim();

  // 1) unit-level match first (enhedsadresse with etage/dør)
  let unitHits = [];
  try { unitHits = await getJson(`${DAWA}/adresser?q=${encodeURIComponent(q)}&per_side=8`); } catch (e) {}

  // DAWA's fritekstsøgning er upræcis på numeriske dørbetegnelser: "23C, 1. 1"
  // giver også træf på "1. 2" og "1. 3". Krav om præcis ét træf faldt derfor
  // igennem til en adgangsadresse-søgning der aldrig kan lykkes med etage og dør.
  const ens = (x) => (x || "").toLowerCase().replace(/\s+/g, " ").trim();
  const valgt = unitHits.length === 1
    ? unitHits[0]
    : unitHits.find((h) => ens(h.adressebetegnelse) === ens(q)) || null;

  let a = null;
  if (valgt) {
    const unit = await buildUnitProfile(valgt, env);
    if (unit) return unit;
    // Enheden findes, men er ikke en ejerlejlighed — fx en lejebolig. Brug dens
    // egen adgangsadresse. En tekstsøgning med etage og dør giver aldrig træf i
    // adgangsadresser, og gav derfor "Ingen adresse fundet" for hele ejendomme.
    a = valgt.adgangsadresse || null;
  }

  // 2) parent / adgangsadresse flow
  if (!a) {
    const hits = await getJson(`${DAWA}/adgangsadresser?q=${encodeURIComponent(q)}&per_side=1`);
    if (!hits.length) throw new Error("Ingen adresse fundet");
    a = hits[0];
  }
  const mat = await jordstykkeInfo(a.jordstykke).catch(() => null);
  const bfe = mat?.bfe ?? null;
  if (!bfe) throw new Error("Kunne ikke finde BFE for adressen");

  const bygQuery = mat?.featureid ? { jordstykke: mat.featureid } : { husnummer: a.id };
  const [bygninger, relation, sfe] = await Promise.all([
    getJson(dafUrl("BBR/BBRPublic/1/rest/bygning", bygQuery, env)),
    getJson(dafUrl("BBR/BBRPublic/1/rest/ejendomsrelation", { bfeNummer: bfe }, env)),
    getJson(dafUrl("Matriklen2/Matrikel/2.0.0/rest/SamletFastEjendom", { SFEBFEnr: bfe }, env)).catch(() => null),
  ]);

  const aktiveBygninger = (bygninger || []).filter((b) => AKTIV_STATUS.includes(b.status));

  // Enheder pr. bygning -> antal og areal fordelt på bolig og erhverv.
  // Parameternavnet Bygning og felterne enh027/enh028 er fra Datafordelerens BBR-dokumentation.
  const enhedsSvar = await Promise.all(
    aktiveBygninger.map((b) =>
      b.id_lokalId
        ? getJson(dafUrl("BBR/BBRPublic/1/rest/enhed", { Bygning: b.id_lokalId }, env)).catch(() => null)
        : Promise.resolve(null)
    )
  );
  const alleEnheder = enhedsSvar
    .filter(Boolean)
    .flat()
    .filter((e) => e && AKTIV_STATUS.includes(e.status));

  const aktive = aktiveBygninger
    .map((b) => ({
      nr: b.byg007Bygningsnummer,
      anvendelse: ANVENDELSE[b.byg021BygningensAnvendelse] || b.byg021BygningensAnvendelse,
      opført: b.byg026Opførelsesår,
      bebyggetArealM2: b.byg041BebyggetAreal ?? null,
      samletBygningsarealM2: b.byg038SamletBygningsareal ?? null,
      boligarealM2: b.byg039BygningensSamledeBoligAreal ?? null,
      kælderM2: (b.etageList || []).find((e) => e.etage?.eta006BygningensEtagebetegnelse === "kl")?.etage?.eta020SamletArealAfEtage ?? null,
      tagetageM2: (b.etageList || []).map((e) => e.etage?.eta021ArealAfUdnyttetDelAfTagetage).find((v) => v != null) ?? null,
      etager: b.byg054AntalEtager ?? null,
      ydervæg: YDERVAEG[b.byg032YdervæggensMateriale] || null,
      tag: TAGDAEKNING[b.byg033Tagdækningsmateriale] || null,
      varme: VARME[b.byg056Varmeinstallation] || null,
      supplVarme: SUPPLVARME[b.byg058SupplerendeVarme] || null,
    }))
    .sort((x, y) => (x.nr ?? 99) - (y.nr ?? 99));

  const rel = Array.isArray(relation) ? relation[0] : relation;
  const sfeProps = sfe?.features?.[0]?.properties ?? null;
  const ejlListe = sfeProps?.ejerlejlighed || [];
  const opdelt = sfeProps?.hovedejendomOpdeltIEjerlejligheder === true || ejlListe.length > 0;

  // Ejerforening: list the individual unit addresses on the parcel (clickable in app)
  let ejerforening = null;
  if (opdelt && mat) {
    try {
      const units = await getJson(`${DAWA}/adresser?ejerlavkode=${mat.ejerlavKode}&matrikelnr=${encodeURIComponent(mat.matrikelnr)}&struktur=mini&per_side=200`);
      ejerforening = {
        antalEjerlejligheder: ejlListe.length || units.length,
        lejligheder: units.map((u) => u.betegnelse).sort(),
      };
    } catch (e) {
      ejerforening = { antalEjerlejligheder: ejlListe.length, lejligheder: [] };
    }
  }

  return {
    adresse: a.adressebetegnelse,
    bfe,
    kommune: { kode: a.kommune?.kode, navn: a.kommune?.navn },
    koordinater: a.adgangspunkt?.koordinater ?? null,
    matrikel: mat ? { ejerlavKode: mat.ejerlavKode, ejerlavNavn: mat.ejerlavNavn, matrikelnr: mat.matrikelnr, grundarealM2: mat.grundarealM2 } : null,
    ejendomstype: rel ? EJENDOMSTYPE[rel.ejendomstype] || rel.ejendomstype : null,
    ejerforhold: rel ? EJERFORHOLD[rel.ejendommensEjerforholdskode] || rel.ejendommensEjerforholdskode : null,
    sfeBekræftet: sfeProps?.BFEnummer === bfe,
    bygninger: aktive,
    boligarealIAltM2: aktive.reduce((s, b) => s + (b.boligarealM2 || 0), 0),
    enheder: opgørEnheder(alleEnheder),
    // Én række pr. enhed. adresseId er DAR-adressens uuid, som appen joiner med
    // DAWA-adresselisten — så vi slipper for et opslag pr. enhed.
    enhedsliste: alleEnheder.map((e) => ({
      adresseId: e.adresseIdentificerer ?? null,
      boligArealM2: e.enh027ArealTilBeboelse ?? null,
      erhvervArealM2: e.enh028ArealTilErhverv ?? null,
      samletArealM2: e.enh026EnhedensSamledeAreal ?? null,
      værelser: e.enh031AntalVærelser ?? null,
      anvendelse: ANVENDELSE[e.enh020EnhedensAnvendelse] || e.enh020EnhedensAnvendelse || null,
    })),
    ejerlejlighed: null,
    ejerforening,
    ejer: await hentEjere(bfe),
    kilder: ["DAWA", "BBR", "Matriklen2", "Matriklen.dk (ejere)"],
  };
}

async function cachedProfile(query, env) {
  // v tælles op når profilens felter ændres, ellers serveres gamle svar i 24 timer
  const key = new Request("https://cache.internal/ejendom?v=3&q=" + encodeURIComponent(query.trim().toLowerCase()));
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  const p = await buildProfile(query, env);
  if (cache) {
    await cache.put(key, new Response(JSON.stringify(p), {
      headers: { "Cache-Control": "max-age=86400", "Content-Type": "application/json" },
    }));
  }
  return p;
}

async function assistant(request, env) {
  const o = tilladtOrigin(request);
  if (!env.GROQ_API_KEY) return json({ error: "server missing GROQ_API_KEY" }, 500, o);
  let text = "";
  try {
    const body = await request.json();
    text = ((body && body.text) || "").toString().slice(0, 500);
  } catch (e) {}
  if (!text.trim()) return json({ filters: {}, reply: "" }, 200, o);

  let groqResp;
  try {
    groqResp = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.GROQ_API_KEY },
      body: JSON.stringify({
        model: MODEL, temperature: 0, max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: SYS }, { role: "user", content: text }],
      }),
    });
  } catch (e) {
    return json({ error: "upstream fetch failed" }, 502, o);
  }
  if (!groqResp.ok) return json({ error: (await groqResp.text()).slice(0, 200) }, 502, o);
  const data = await groqResp.json();
  let out = { filters: {}, reply: "" };
  try {
    out = JSON.parse((((data.choices || [])[0] || {}).message || {}).content || "{}");
  } catch (e) {}
  return json(out, 200, o);
}

export default {
  async fetch(request, env) {
    const o = tilladtOrigin(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(o) });
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/bbr") {
      if (!env.DAF_USER || !env.DAF_PASS) return json({ error: "server missing DAF_USER/DAF_PASS" }, 500, o);
      const par = (url.searchParams.get("js") || "")
        .split(",").map((x) => x.trim()).filter(Boolean)
        .map((x) => { const [js, bfe] = x.split(":"); return { js, bfe: bfe || null }; })
        .filter((x) => /^\d+$/.test(x.js));
      if (!par.length) return json({}, 200, o);
      try {
        return json(await bbrBatch(par, env), 200, o);
      } catch (e) {
        return json({ error: (e && e.message) || "bbr-opslag fejlede" }, 502, o);
      }
    }

    if (request.method === "GET" && url.pathname === "/ejere") {
      const bfe = (url.searchParams.get("bfe") || "")
        .split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
      if (!bfe.length) return json({}, 200, o);
      try {
        return json(await ejereBatch(bfe), 200, o);
      } catch (e) {
        return json({ error: (e && e.message) || "ejeropslag fejlede" }, 502, o);
      }
    }

    if (request.method === "GET" && url.pathname === "/ejendom") {
      if (!env.DAF_USER || !env.DAF_PASS) return json({ error: "server missing DAF_USER/DAF_PASS" }, 500, o);
      const adresse = (url.searchParams.get("adresse") || "").slice(0, 200);
      if (!adresse.trim()) return json({ error: "adresse mangler" }, 400, o);
      try {
        return json(await cachedProfile(adresse, env), 200, o);
      } catch (e) {
        return json({ error: (e && e.message) || "opslag fejlede" }, 502, o);
      }
    }

    if (request.method === "POST" && url.pathname === "/") return assistant(request, env);
    return json({ error: "method not allowed" }, 405, o);
  },
};
