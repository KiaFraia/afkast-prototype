# Backend (Cloudflare Worker)

One Worker (`purple-tree-3fd5`) serves two routes:

| Route | What it does | Secrets used |
|---|---|---|
| `POST /` with `{"text": "..."}` | AI assistant: natural language → search filters (Groq/Llama) | `GROQ_API_KEY` |
| `GET /ejendom?adresse=...` | Live ejendomsprofil: DAWA → BFE → BBR + Matriklen (+ EBR) via Datafordeleren, cached 24h | `DAF_USER`, `DAF_PASS` |

Both are narrow, fixed operations locked to the app's origin — no open pass-through
of any credential.

## Deploy / update (~3 min, dashboard)

1. dash.cloudflare.com → **Compute** → open Worker **purple-tree-3fd5**.
2. **Edit code** → replace everything with the current [`worker.js`](worker.js) → **Deploy**.
3. **Settings → Variables and Secrets** → ensure these three **Secrets** exist:
   - `GROQ_API_KEY` (already set)
   - `DAF_USER` — Datafordeler tjenestebruger username
   - `DAF_PASS` — Datafordeler tjenestebruger password
4. Test: open
   `https://purple-tree-3fd5.kiakafaei.workers.dev/ejendom?adresse=Boulevarden 5, 4760 Vordingborg`
   — should return JSON with `"bfe": 5393320`.

To change the assistant model, edit `MODEL` in `worker.js` and redeploy.
