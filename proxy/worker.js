// Ejendomsinvestoren backend — Cloudflare Worker
//
// Routes:
//   POST /                     {text} -> AI assistant: natural language -> search filters (Groq)
//   GET  /ejendom?adresse=...  -> merged ejendomsprofil from the public registries
//                                 (DAWA -> BFE -> BBR + Matriklen + EBR via Datafordeleren)
//
// Secrets (Settings -> Variables and Secrets, type Secret):
//   GROQ_API_KEY  - Groq API key (assistant)
//   DAF_USER      - Datafordeler tjenestebruger username
//   DAF_PASS      - Datafordeler tjenestebruger password
//
// Only fixed, narrow operations are exposed — no open pass-through of any key.

const ALLOWED_ORIGIN = "https://kiafraia.github.io";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.1-8b-instant";
const SYS = 'Du er assistent i en dansk ejendomsinvesteringsapp. Oversæt brugerens beskrivelse af ønskede off-market leads til søgefiltre. Svar KUN med JSON på formen {"filters":{"region":"","ownerType":"","minAge":0,"lives":"","minProps":1,"minTenure":0,"maxPrice":0,"type":"","minUnits":1,"minArea":0},"reply":""}. region: Hovedstaden|Midtjylland|Syddanmark|Nordjylland eller tom. ownerType: Privatperson|Selskab eller tom. minAge: ejerens minimumsalder (0=ingen). lives: ja=bor på adressen, nej=fraværende ejer, tom=ligegyldigt. minProps: min antal ejendomme ejeren ejer (1=ingen). minTenure: min ejertid i år (0=ingen). maxPrice: maks seneste handelspris i kroner (0=ingen). type: Enfamiliehus|Flerfamiliehus|Ejerlejlighed eller tom. minUnits: min boligenheder (1=ingen). minArea: min m² (0=ingen). Kriterier der ikke nævnes sættes til 0 eller tom streng. reply: én kort dansk sætning.';

const DAWA = "https://api.dataforsyningen.dk";
const DAF = "https://services.datafordeler.dk";
const ANVENDELSE = { 110: "Stuehus til landbrug", 120: "Fritliggende enfamilieshus", 121: "Sammenbygget enfamiliehus", 130: "Række-/kædehus", 140: "Etagebolig-bygning", 190: "Anden helårsbeboelse", 910: "Garage", 920: "Carport", 930: "Udhus" };
const EJERFORHOLD = { 10: "Privatpersoner", 20: "Alment boligselskab", 30: "Aktie-/anpartsselskab", 40: "Forening/legat/selvejende institution", 41: "Privat andelsboligforening", 50: "Staten", 60: "Region", 70: "Kommune", 80: "Andet", 90: "Ikke fastlagt" };
const EJENDOMSTYPE = { 1: "Samlet fast ejendom", 2: "Ejerlejlighed", 3: "Bygning på fremmed grund" };

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors(), "Content-Type": "application/json" },
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

async function buildProfile(query, env) {
  const hits = await getJson(`${DAWA}/adgangsadresser?q=${encodeURIComponent(query)}&per_side=1`);
  if (!hits.length) throw new Error("Ingen adresse fundet");
  const a = hits[0];
  const js = a.jordstykke
    ? await getJson(`${DAWA}/jordstykker/${a.jordstykke.ejerlav.kode}/${encodeURIComponent(a.jordstykke.matrikelnr)}`)
    : null;
  const bfe = js?.bfenummer ?? js?.sfeejendomsnr ?? null;
  if (!bfe) throw new Error("Kunne ikke finde BFE for adressen");

  const [bygninger, relation, sfe] = await Promise.all([
    getJson(dafUrl("BBR/BBRPublic/1/rest/bygning", { husnummer: a.id }, env)),
    getJson(dafUrl("BBR/BBRPublic/1/rest/ejendomsrelation", { bfeNummer: bfe }, env)),
    getJson(dafUrl("Matriklen2/Matrikel/2.0.0/rest/SamletFastEjendom", { SFEBFEnr: bfe }, env)).catch(() => null),
  ]);

  const aktive = (bygninger || [])
    .filter((b) => b.status === "6")
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
  return {
    adresse: a.adressebetegnelse,
    bfe,
    kommune: { kode: a.kommune?.kode, navn: a.kommune?.navn },
    koordinater: a.adgangspunkt?.koordinater ?? null,
    matrikel: js ? { ejerlavKode: js.ejerlav.kode, ejerlavNavn: js.ejerlav.navn, matrikelnr: js.matrikelnr, grundarealM2: js.registreretareal ?? null } : null,
    ejendomstype: rel ? EJENDOMSTYPE[rel.ejendomstype] || rel.ejendomstype : null,
    ejerforhold: rel ? EJERFORHOLD[rel.ejendommensEjerforholdskode] || rel.ejendommensEjerforholdskode : null,
    sfeBekræftet: sfe?.features?.[0]?.properties?.BFEnummer === bfe,
    bygninger: aktive,
    boligarealIAltM2: aktive.reduce((s, b) => s + (b.boligarealM2 || 0), 0),
    ejer: null, // navne kræver EJF certifikat-adgang
    kilder: ["DAWA", "BBR", "Matriklen2"],
  };
}

async function cachedProfile(query, env) {
  const key = new Request("https://cache.internal/ejendom?q=" + encodeURIComponent(query.trim().toLowerCase()));
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
  if (!env.GROQ_API_KEY) return json({ error: "server missing GROQ_API_KEY" }, 500);
  let text = "";
  try {
    const body = await request.json();
    text = ((body && body.text) || "").toString().slice(0, 500);
  } catch (e) {}
  if (!text.trim()) return json({ filters: {}, reply: "" });

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
    return json({ error: "upstream fetch failed" }, 502);
  }
  if (!groqResp.ok) return json({ error: (await groqResp.text()).slice(0, 200) }, 502);
  const data = await groqResp.json();
  let out = { filters: {}, reply: "" };
  try {
    out = JSON.parse((((data.choices || [])[0] || {}).message || {}).content || "{}");
  } catch (e) {}
  return json(out);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/ejendom") {
      if (!env.DAF_USER || !env.DAF_PASS) return json({ error: "server missing DAF_USER/DAF_PASS" }, 500);
      const adresse = (url.searchParams.get("adresse") || "").slice(0, 200);
      if (!adresse.trim()) return json({ error: "adresse mangler" }, 400);
      try {
        return json(await cachedProfile(adresse, env));
      } catch (e) {
        return json({ error: (e && e.message) || "opslag fejlede" }, 502);
      }
    }

    if (request.method === "POST" && url.pathname === "/") return assistant(request, env);
    return json({ error: "method not allowed" }, 405);
  },
};
