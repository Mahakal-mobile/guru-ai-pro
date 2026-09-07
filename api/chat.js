const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_BODY = 60 * 1024 * 1024;

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function cleanBase64(data) {
  if (!data) return "";
  const s = String(data);
  const comma = s.indexOf(",");
  return s.startsWith("data:") && comma >= 0 ? s.slice(comma + 1) : s;
}

function languageInstruction(language) {
  if (language === "hi") return "Reply in natural, simple Hindi. Keep technical component names, IC names and measurements in English where that is clearer.";
  if (language === "es") return "Reply in natural Spanish.";
  if (language === "auto") return "Reply in the same language as the user's message.";
  return "Reply in clear natural English.";
}

function systemPrompt(language, hasAttachment) {
  return `You are Guru AI, a premium practical AI assistant.
Never introduce yourself, never mention the developer or API key, and do not add unnecessary greetings.
${languageInstruction(language)}
Be helpful, direct, accurate and conversational, like a knowledgeable human assistant.
If the user asks about mobile-phone repair, electronics, motherboard faults, ICs, charging, short circuits, diagnostics or repair tools, give structured step-by-step guidance. For board images, distinguish visible observations from hypotheses and recommend safe measurements before claiming a fault.
If the user asks for current news, prices, events, specifications, laws, product availability or anything time-sensitive, use Google Search grounding when enabled.
Do not invent citations or sources.
For electrical repair, include concise safety guidance where relevant.
${hasAttachment ? "A file/image/PDF is attached. Inspect it carefully and base the answer on its contents; if the evidence is insufficient, say what cannot be confirmed." : ""}`;
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || "").join("").trim();
}

function extractSources(data) {
  const out = [];
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks
    || data?.candidates?.[0]?.groundingMetadata?.groundingChunks
    || data?.groundingMetadata?.groundingChunks || [];
  for (const c of chunks) {
    const w = c?.web;
    if (w?.uri && !out.some(x => x.uri === w.uri)) {
      out.push({title: w.title || w.uri, uri: w.uri});
    }
  }
  return out;
}

function friendlyError(status, msg) {
  const m = String(msg || "");
  if (/models\/.*not found|not found|not supported/i.test(m)) {
    return `Gemini model "${MODEL}" is not available for this API project. In Vercel Environment Variables, set GEMINI_MODEL to a model enabled for your project (for example gemini-3.6-flash), then redeploy.`;
  }
  if (/api key|permission|unauthenticated|authentication|forbidden|invalid.*key/i.test(m)) {
    return "Gemini API key is missing, invalid, or does not have permission for this model. Check Vercel → Settings → Environment Variables → GEMINI_API_KEY, then redeploy.";
  }
  if (status === 429) return "Gemini rate limit reached. Please wait a moment and try again.";
  if (status >= 500) return "Gemini service is temporarily unavailable. Please try again in a moment.";
  return m || `Gemini request failed (HTTP ${status}).`;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (req.method !== "POST") return json(res, 405, {error: "Method not allowed"});
  if (!process.env.GEMINI_API_KEY) return json(res, 500, {error: "GEMINI_API_KEY is not configured in Vercel."});

  try {
    const raw = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const message = String(raw.message || "").trim();
    const language = ["en","hi","es","auto"].includes(raw.language) ? raw.language : "en";
    const liveSearch = raw.liveSearch !== false;
    const attachment = raw.attachment || null;

    if (!message && !attachment) return json(res, 400, {error: "Message or attachment is required."});

    const parts = [{text: systemPrompt(language, !!attachment)}];
    if (message) parts.push({text: message});

    if (attachment) {
      const mimeType = String(attachment.mimeType || "application/octet-stream").toLowerCase();
      const data = cleanBase64(attachment.data);
      if (!data) return json(res, 400, {error: "Attachment data is empty."});

      const allowed = [
        "image/jpeg","image/png","image/webp","image/gif",
        "application/pdf","text/plain","text/markdown","text/csv","application/json"
      ];
      if (!allowed.includes(mimeType)) {
        return json(res, 415, {error: `Unsupported attachment type: ${mimeType}`});
      }
      if (Buffer.byteLength(data, "base64") > 50 * 1024 * 1024) {
        return json(res, 413, {error: "Attachment is too large. Keep PDFs under 50 MB and images smaller."});
      }
      parts.push({inline_data:{mime_type:mimeType,data}});
    }

    const body = {
      contents: [{role:"user", parts}],
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 1800
      }
    };

    // Correct Gemini REST tool syntax. This is intentionally server-side.
    // Search is enabled for text and multimodal questions alike.
    if (liveSearch) body.tools = [{google_search:{}}];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    let response;
    try {
      response = await fetch(`${API_URL}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(body),
        signal:controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const rawText = await response.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch { return json(res, 502, {error:"Gemini returned an invalid response."}); }

    if (!response.ok) {
      return json(res, response.status, {error:friendlyError(response.status, data?.error?.message)});
    }

    const text = extractText(data);
    if (!text) {
      const block = data?.candidates?.[0]?.finishReason || "unknown";
      return json(res, 502, {error:`Gemini returned no text (finish reason: ${block}).`});
    }

    return json(res, 200, {
      text,
      sources: extractSources(data),
      grounded: liveSearch && extractSources(data).length > 0,
      model: MODEL
    });
  } catch (err) {
    if (err?.name === "AbortError") return json(res, 504, {error:"Gemini request timed out. Please try again."});
    console.error("Guru AI API error:", err);
    return json(res, 500, {error:"Server error while contacting Gemini."});
  }
}
