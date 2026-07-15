# Assistant proxy (Cloudflare Worker)

Keeps your Groq API key server-side so every visitor to the app uses the real model —
no key in anyone's browser. Free tier is plenty (100k requests/day).

## Deploy (~5 min, no CLI)

1. Go to **dash.cloudflare.com** and sign up / sign in (free).
2. Left menu: **Workers & Pages** → **Create** → **Create Worker**. Give it a name
   (e.g. `afkast-proxy`) → **Deploy**.
3. Click **Edit code**. Delete the sample, paste the full contents of
   [`worker.js`](worker.js), then **Deploy**.
4. Back on the Worker page: **Settings** → **Variables and Secrets** → **Add** →
   type **Secret**, name **`GROQ_API_KEY`**, value = your `gsk_…` key → **Deploy**.
5. Copy the Worker URL at the top — it looks like
   `https://afkast-proxy.<your-subdomain>.workers.dev`.
6. Send that URL to Claude — it gets pasted into the app (`PROXY_URL` in `index.html`),
   and then the assistant works for everyone with no key.

## Notes

- The Worker only accepts a short text string and wraps it in a fixed prompt + model, and
  only allows requests from the app's origin — so your key can't be used for arbitrary
  Groq calls.
- To change the model, edit `MODEL` in `worker.js` and re-deploy.
- Same idea works on Vercel / Netlify functions if you prefer — the request shape is
  identical (`POST { "text": "..." }` → `{ "filters": {...}, "reply": "..." }`).
