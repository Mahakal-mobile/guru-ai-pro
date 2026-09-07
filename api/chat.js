const DEFAULT_MODELS = [
  process.env.GEMINI_MODEL || "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-2.5-flash"
];

const API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models/";

const TIMEOUT_MS = 55000;
const MAX_RETRIES = 2;

const SYSTEM_PROMPT = `
You are Guru AI, a practical bilingual Hindi/English AI assistant.

Answer naturally in the user's language.

You are especially useful for:
- Mobile phone repair
- Electronics troubleshooting
- Circuit and motherboard analysis
- Software and Android problems
- Camera/image inspection
- PDF and document analysis
- General questions
- Current information using web search when available

When an image, PDF, or document is supplied, inspect it carefully before answering.

For current or changing information, use Google Search grounding when available.

Never invent measurements, component values, sources, or diagnoses.

For repair questions:
1. Tell the likely problem.
2. Explain why.
3. Give safe testing steps.
4. Mention what should be checked next.
5. Clearly separate confirmed observations from guesses.

Keep answers useful, clear and reasonably concise.
`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(status) {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function buildContents(messages) {
  return (messages || []).map(message => {
    const parts = [];

    if (message.text) {
      parts.push({
        text: String(message.text)
      });
    }

    for (const attachment of message.attachments || []) {
      if (
        !attachment ||
        !attachment.data ||
        !attachment.mimeType
      ) {
        continue;
      }

      parts.push({
        inline_data: {
          mime_type: attachment.mimeType,
          data: String(attachment.data).replace(
            /^data:[^;]+;base64,/,
            ""
          )
        }
      });
    }

    return {
      role: message.role === "assistant" ? "model" : "user",
      parts: parts.length ? parts : [{ text: "" }]
    };
  });
}

async function callModel(model, body, apiKey) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const url =
      API_BASE +
      encodeURIComponent(model) +
      ":generateContent?key=" +
      encodeURIComponent(apiKey);

    const response = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify(body),

      signal: controller.signal
    });

    const raw = await response.text();

    let data = {};

    try {
      data = JSON.parse(raw);
    } catch (_) {}

    if (!response.ok) {
      const error = new Error(
        data?.error?.message ||
          `Gemini HTTP ${response.status}`
      );

      error.status = response.status;

      throw error;
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error:
        "GEMINI_API_KEY is missing in Vercel Environment Variables."
    });
  }

  const messages = req.body?.messages || [];

  const enableSearch =
    req.body?.enableSearch !== false;

  if (!messages.length) {
    return res.status(400).json({
      error: "No messages supplied."
    });
  }

  const body = {
    system_instruction: {
      parts: [
        {
          text: SYSTEM_PROMPT
        }
      ]
    },

    contents: buildContents(messages),

    generationConfig: {
      maxOutputTokens: 1800
    }
  };

  // Google Search grounding
  if (enableSearch) {
    body.tools = [
      {
        google_search: {}
      }
    ];
  }

  let lastError = null;

  // 3.8 → 3.6 → 2.5 automatic fallback
  for (const model of DEFAULT_MODELS) {
    for (
      let attempt = 0;
      attempt <= MAX_RETRIES;
      attempt++
    ) {
      try {
        const data = await callModel(
          model,
          body,
          apiKey
        );

        const text = (data?.candidates || [])
          .flatMap(
            candidate =>
              candidate?.content?.parts || []
          )
          .map(part => part?.text || "")
          .join("")
          .trim();

        const grounding =
          data?.candidates?.[0]
            ?.groundingMetadata;

        const sources = [];

        for (
          const chunk of
          grounding?.groundingChunks || []
        ) {
          const web = chunk?.web;

          if (web?.uri) {
            sources.push({
              title: web.title || web.uri,
              uri: web.uri
            });
          }
        }

        return res.status(200).json({
          text:
            text ||
            "मुझे इस बार उत्तर नहीं मिला। कृपया फिर से भेजें।",

          model,

          sources
        });
      } catch (error) {
        lastError = error;

        // Rate limit / temporary server error
        if (
          isRetryable(error.status) &&
          attempt < MAX_RETRIES
        ) {
          await sleep(
            700 * Math.pow(2, attempt)
          );

          continue;
        }

        // Try next model
        if (isRetryable(error.status)) {
          break;
        }

        // Model unavailable / bad request
        if (
          error.status === 400 ||
          error.status === 404
        ) {
          break;
        }

        return res.status(500).json({
          error:
            error.message ||
            "Gemini request failed."
        });
      }
    }
  }

  const status =
    lastError?.status === 429
      ? 429
      : 503;

  return res.status(status).json({
    error:
      "अभी Gemini की API limit या availability पूरी हो गई है। Guru AI ने automatic retry और fallback models चलाए, लेकिन अभी सभी उपलब्ध रास्ते व्यस्त हैं। थोड़ी देर बाद फिर कोशिश करें।",

    detail:
      lastError?.message ||
      "No model available"
  });
}
