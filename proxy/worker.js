// Afkast assistant proxy — Cloudflare Worker
// Keeps the Groq API key server-side so every visitor uses the real model
// without a key in their browser. It ONLY accepts a short text string and
// wraps it in a fixed prompt/model — it is not an open pass-through, so your
// key can't be used for arbitrary requests.
//
// Deploy: see proxy/README.md. Set a secret named GROQ_API_KEY.

const ALLOWED_ORIGIN = "https://kiafraia.github.io"; // the app's origin
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.1-8b-instant";
const SYS = 'Du er assistent i en dansk ejendomsinvesteringsapp. Oversæt brugerens beskrivelse af ønskede off-market leads til søgefiltre. Svar KUN med JSON på formen {"filters":{"region":"","ownerType":"","minAge":0,"lives":"","minProps":1,"minTenure":0,"maxPrice":0,"type":"","minUnits":1,"minArea":0},"reply":""}. region: Hovedstaden|Midtjylland|Syddanmark|Nordjylland eller tom. ownerType: Privatperson|Selskab eller tom. minAge: ejerens minimumsalder (0=ingen). lives: ja=bor på adressen, nej=fraværende ejer, tom=ligegyldigt. minProps: min antal ejendomme ejeren ejer (1=ingen). minTenure: min ejertid i år (0=ingen). maxPrice: maks seneste handelspris i kroner (0=ingen). type: Enfamiliehus|Flerfamiliehus|Ejerlejlighed eller tom. minUnits: min boligenheder (1=ingen). minArea: min m² (0=ingen). Kriterier der ikke nævnes sættes til 0 eller tom streng. reply: én kort dansk sætning.';

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors(), "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!env.GROQ_API_KEY) return json({ error: "server missing GROQ_API_KEY" }, 500);

    let text = "";
    try {
      const body = await request.json();
      text = ((body && body.text) || "").toString().slice(0, 500); // cap input
    } catch (e) {}
    if (!text.trim()) return json({ filters: {}, reply: "" });

    let groqResp;
    try {
      groqResp = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + env.GROQ_API_KEY,
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          max_tokens: 400,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYS },
            { role: "user", content: text },
          ],
        }),
      });
    } catch (e) {
      return json({ error: "upstream fetch failed" }, 502);
    }

    if (!groqResp.ok) {
      const t = await groqResp.text();
      return json({ error: t.slice(0, 200) }, 502);
    }

    const data = await groqResp.json();
    let out = { filters: {}, reply: "" };
    try {
      out = JSON.parse((((data.choices || [])[0] || {}).message || {}).content || "{}");
    } catch (e) {}
    return json(out);
  },
};
