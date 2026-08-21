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
const AKTIV_STATUS = ["6", "7"]; // 6=Opført, 7=Gældende

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
    ejer: null,
    kilder: ["DAWA", "BBR", "Matriklen2"],
  };
}

async function buildProfile(query, env) {
  const q = query.replace(/,\s*,/g, ",").trim();

  // 1) unit-level match first (enhedsadresse with etage/dør)
  let unitHits = [];
  try { unitHits = await getJson(`${DAWA}/adresser?q=${encodeURIComponent(q)}&per_side=2`); } catch (e) {}
  if (unitHits.length === 1) {
    const unit = await buildUnitProfile(unitHits[0], env);
    if (unit) return unit;
  }

  // 2) parent / adgangsadresse flow
  const hits = await getJson(`${DAWA}/adgangsadresser?q=${encodeURIComponent(q)}&per_side=1`);
  if (!hits.length) throw new Error("Ingen adresse fundet");
  const a = hits[0];
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
    ejer: null, // navne kræver EJF certifikat-adgang
    kilder: ["DAWA", "BBR", "Matriklen2"],
  };
}

async function cachedProfile(query, env) {
  const key = new Request("https://cache.internal/ejendom?v=2&q=" + encodeURIComponent(query.trim().toLowerCase()));
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
