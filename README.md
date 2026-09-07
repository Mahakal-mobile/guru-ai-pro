# Guru AI — Vercel Ready

## Deploy
1. Upload this folder to GitHub.
2. Import the repository into Vercel.
3. In Vercel → Project → Settings → Environment Variables add:
   - `GEMINI_API_KEY` = your Gemini API key
   - `GEMINI_MODEL` = `gemini-3.6-flash` (optional; the code defaults to this)
4. Redeploy after saving the environment variable.
5. Open the Vercel URL.

The browser never receives `GEMINI_API_KEY`.

## Files
- `public/index.html` — premium dark/gold bilingual UI, settings, camera, gallery, PDF/files and voice.
- `api/chat.js` — secure Vercel serverless Gemini proxy with Google Search grounding and multimodal input.
- `vercel.json` — Vercel function configuration.

## Important
Do not put the Gemini key in `index.html`, localStorage, GitHub, or client-side JavaScript.
