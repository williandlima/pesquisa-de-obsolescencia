// Netlify Function: check-part
// Recebe { pn } e consulta a Mouser Search API (dados oficiais de lifecycle,
// vindos do fabricante/distribuidor autorizado). A chave (MOUSER_API_KEY) fica
// em variável de ambiente no Netlify — NUNCA no navegador.
//
// Por que Mouser em vez de Nexar/Anthropic:
// - Uma única API key, sem fluxo OAuth2 de token.
// - Sem sistema de "part limit 0" por aplicação nova — a key já vem utilizável.
// - Dado direto do distribuidor autorizado (LifecycleStatus, SuggestedReplacement).

const SEARCH_URL = "https://api.mouser.com/api/v1/search/partnumber";

function normalizeStatus(raw) {
  if (!raw) return "unknown";
  const s = String(raw).toLowerCase();
  if (
    s.includes("obsolet") ||
    s.includes("eol") ||
    s.includes("end of life") ||
    s.includes("discontinu") ||
    s.includes("last time buy")
  ) {
    return "obsolete";
  }
  if (
    s.includes("nrnd") ||
    s.includes("not recommended") ||
    s.includes("not for new")
  ) {
    return "nrnd";
  }
  if (s.includes("active") || s.includes("new product") || s.includes("production")) {
    return "active";
  }
  return "unknown";
}

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

  const apiKey = process.env.MOUSER_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "MOUSER_API_KEY não configurada no servidor." }),
    };
  }

  try {
    const res = await fetch(`${SEARCH_URL}?apiKey=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        SearchByPartRequest: {
          mouserPartNumber: pn.trim(),
          partSearchOptions: "None",
        },
      }),
    });

    const data = await res.json();

    const apiErrors = data.Errors || (data.SearchResults && data.SearchResults.Errors) || [];
    if (Array.isArray(apiErrors) && apiErrors.length) {
      const messages = apiErrors.map((e) => e.Message || e.message).filter(Boolean).join(" | ");
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ error: `Erro na API Mouser: ${messages || "erro desconhecido"}` }),
      };
    }

    const parts = (data.SearchResults && data.SearchResults.Parts) || [];

    // Prioriza correspondência exata de MPN.
    let match = parts.find(
      (p) => p.ManufacturerPartNumber && p.ManufacturerPartNumber.toLowerCase() === pn.trim().toLowerCase()
    );
    if (!match) match = parts[0];

    if (!match) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          status: "unknown",
          confidence: "low",
          substitute: "",
          manufacturer: "",
          notes: "Componente não encontrado na base Mouser. Verificação manual necessária.",
          sources: [],
        }),
      };
    }

    const rawStatus = match.LifecycleStatus || "";
    const status = normalizeStatus(rawStatus);

    // Confiança alta: dado vem direto de distribuidor autorizado.
    const confidence = status === "unknown" ? "low" : "high";

    const substitute = match.SuggestedReplacement || "";

    const sources = [];
    if (match.ProductDetailUrl) {
      sources.push({ name: "Mouser", url: match.ProductDetailUrl });
    }
    if (match.DataSheetUrl) {
      sources.push({ name: "Datasheet do fabricante", url: match.DataSheetUrl });
    }

    const notes = rawStatus
      ? `Lifecycle informado pela Mouser: "${rawStatus}"${match.Manufacturer ? " — " + match.Manufacturer : ""}.`
      : "Componente encontrado, mas sem status de lifecycle cadastrado. Verificação manual recomendada.";

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        status,
        confidence,
        substitute,
        manufacturer: match.Manufacturer || "",
        matchedMpn: match.ManufacturerPartNumber || "",
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
