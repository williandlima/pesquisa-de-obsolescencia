// Netlify Function: check-part
// Recebe { pn } e consulta a API Nexar/Octopart (dados oficiais de lifecycle).
// As credenciais (NEXAR_CLIENT_ID / NEXAR_CLIENT_SECRET) ficam em variáveis de
// ambiente no Netlify — NUNCA no navegador. O usuário final não precisa de chave.

const IDENTITY_URL = "https://identity.nexar.com/connect/token";
const API_URL = "https://api.nexar.com/graphql/";

// Cache do token em memória (dura enquanto a função estiver "quente").
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getToken() {
  const now = Date.now();
  // reaproveita token se ainda válido (com margem de 60s)
  if (cachedToken && now < cachedTokenExpiry - 60000) {
    return cachedToken;
  }

  const clientId = process.env.NEXAR_CLIENT_ID;
  const clientSecret = process.env.NEXAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Credenciais Nexar não configuradas no servidor (NEXAR_CLIENT_ID / NEXAR_CLIENT_SECRET).");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "supply.domain",
  });

  const res = await fetch(IDENTITY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Falha ao obter token Nexar (${res.status}): ${txt}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = now + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

// Normaliza os diversos rótulos de lifecycle da indústria para nosso padrão.
function normalizeStatus(raw) {
  if (!raw) return "unknown";
  const s = String(raw).toLowerCase();
  if (s.includes("obsolet") || s.includes("eol") || s.includes("end of life") || s.includes("discontinu") || s.includes("last time buy")) {
    return "obsolete";
  }
  if (s.includes("nrnd") || s.includes("not recommended")) {
    return "nrnd";
  }
  if (s.includes("active") || s.includes("production") || s.includes("new")) {
    return "active";
  }
  return "unknown";
}

const QUERY = `
query LifecycleByMpn($q: String!) {
  supSearchMpn(q: $q, limit: 3) {
    results {
      part {
        mpn
        manufacturer { name }
        octopartUrl
        bestDatasheet { url }
        specs {
          attribute { shortname }
          displayValue
        }
        sellers {
          company { name }
        }
      }
    }
  }
}`;

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Método não permitido" }) };
  }

  let pn;
  try {
    ({ pn } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Corpo inválido" }) };
  }
  if (!pn || !pn.trim()) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Part number ausente" }) };
  }

  try {
    const token = await getToken();
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: QUERY, variables: { q: pn.trim() } }),
    });

    const data = await res.json();
    if (data.errors) {
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ error: "Erro na API Nexar", details: data.errors }),
      };
    }

    const results = (data.data && data.data.supSearchMpn && data.data.supSearchMpn.results) || [];

    // Procura a melhor correspondência: MPN exato tem prioridade.
    let match = results.find(r => r.part && r.part.mpn && r.part.mpn.toLowerCase() === pn.trim().toLowerCase());
    if (!match) match = results[0];

    if (!match || !match.part) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          status: "unknown",
          confidence: "low",
          substitute: "",
          manufacturer: "",
          notes: "Componente não encontrado na base Octopart. Verificação manual necessária.",
          sources: [],
        }),
      };
    }

    const part = match.part;
    const specs = part.specs || [];
    const findSpec = (shortname) => {
      const s = specs.find(x => x.attribute && x.attribute.shortname === shortname);
      return s ? s.displayValue : null;
    };

    const mfrLifecycle = findSpec("manufacturerlifecyclestatus");
    const homogenized = findSpec("lifecyclestatus");
    const rawStatus = mfrLifecycle || homogenized;
    const status = normalizeStatus(rawStatus);

    // Confiança: alta se veio do fabricante, média se homogeneizado, baixa se nada.
    let confidence = "low";
    if (mfrLifecycle) confidence = "high";
    else if (homogenized) confidence = "medium";

    if (status === "unknown") confidence = "low";

    const sources = [];
    if (part.octopartUrl) {
      sources.push({ name: "Octopart", url: part.octopartUrl });
    }
    if (part.bestDatasheet && part.bestDatasheet.url) {
      sources.push({ name: "Datasheet do fabricante", url: part.bestDatasheet.url });
    }

    const notes = rawStatus
      ? `Lifecycle informado: "${rawStatus}"${part.manufacturer ? " — " + part.manufacturer.name : ""}.`
      : "Componente encontrado, mas sem campo de lifecycle na base. Verificação manual recomendada.";

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        status,
        confidence: status === "unknown" ? "low" : confidence,
        substitute: "",
        manufacturer: part.manufacturer ? part.manufacturer.name : "",
        matchedMpn: part.mpn,
        notes,
        sources,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message || "Erro interno" }),
    };
  }
};
