// Netlify Function: check-part
// Recebe { pn, mfr } e consulta a Mouser Search API (dados oficiais de lifecycle).
// A chave (MOUSER_API_KEY) fica em variável de ambiente no Netlify.
//
// Melhorias de confiabilidade:
// 1) Detecta quando o MPN é fabricado por mais de uma empresa e os status
//    divergem entre elas — nesse caso não escolhe uma resposta arbitrária,
//    marca como ambíguo e lista os fabricantes/status encontrados.
// 2) Retry automático (até 2 tentativas extras) em falhas de rede/5xx.

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
  if (s.includes("nrnd") || s.includes("not recommended") || s.includes("not for new")) {
    return "nrnd";
  }
  if (s.includes("active") || s.includes("new product") || s.includes("production")) {
    return "active";
  }
  return "unknown";
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Chama a Mouser com retry automático em falhas transitórias (rede, 5xx).
async function fetchMouserWithRetry(url, options, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 && attempt < maxRetries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr || new Error("Falha de rede ao consultar a Mouser após múltiplas tentativas.");
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

  let pn, mfr;
  try {
    ({ pn, mfr } = JSON.parse(event.body || "{}"));
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
    const res = await fetchMouserWithRetry(
      `${SEARCH_URL}?apiKey=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          SearchByPartRequest: {
            mouserPartNumber: pn.trim(),
            partSearchOptions: "None",
          },
        }),
      },
      2
    );

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

    // Todas as correspondências exatas de MPN (pode haver mais de um fabricante).
    let exactMatches = parts.filter(
      (p) => p.ManufacturerPartNumber && p.ManufacturerPartNumber.toLowerCase() === pn.trim().toLowerCase()
    );
    if (!exactMatches.length) exactMatches = parts.slice(0, 1);

    if (!exactMatches.length) {
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

    // Se o usuário informou o fabricante, filtra por ele.
    let candidates = exactMatches;
    if (mfr && mfr.trim()) {
      const mfrFiltered = exactMatches.filter(
        (p) => p.Manufacturer && p.Manufacturer.toLowerCase().includes(mfr.trim().toLowerCase())
      );
      if (mfrFiltered.length) candidates = mfrFiltered;
    }

    // Agrupa por fabricante único e verifica se os status concordam.
    const byManufacturer = {};
    candidates.forEach((p) => {
      const key = p.Manufacturer || "Desconhecido";
      if (!byManufacturer[key]) byManufacturer[key] = p;
    });
    const manufacturers = Object.keys(byManufacturer);
    const statusesFound = manufacturers.map((m) => normalizeStatus(byManufacturer[m].LifecycleStatus));
    const distinctStatuses = [...new Set(statusesFound)];

    // AMBÍGUO: mais de um fabricante, com status diferentes, sem filtro que resolva.
    if (manufacturers.length > 1 && distinctStatuses.length > 1) {
      const breakdown = manufacturers
        .map((m) => `${m}: ${byManufacturer[m].LifecycleStatus || "sem status"}`)
        .join("; ");
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          status: "unknown",
          confidence: "low",
          substitute: "",
          manufacturer: manufacturers.join(", "),
          notes: `Ambíguo: ${manufacturers.length} fabricantes com status diferentes (${breakdown}). Especifique o fabricante para um resultado preciso.`,
          sources: candidates
            .filter((p) => p.ProductDetailUrl)
            .slice(0, 3)
            .map((p) => ({ name: `Mouser (${p.Manufacturer})`, url: p.ProductDetailUrl })),
          ambiguous: true,
        }),
      };
    }

    // Único fabricante (ou todos concordam) — segue fluxo normal.
    const match = candidates[0];
    const rawStatus = match.LifecycleStatus || "";
    const status = normalizeStatus(rawStatus);
    const confidence = status === "unknown" ? "low" : "high";
    const substitute = match.SuggestedReplacement || "";

    const sources = [];
    if (match.ProductDetailUrl) sources.push({ name: "Mouser", url: match.ProductDetailUrl });
    if (match.DataSheetUrl) sources.push({ name: "Datasheet do fabricante", url: match.DataSheetUrl });

    const agreementNote =
      manufacturers.length > 1 ? ` (${manufacturers.length} fabricantes concordam)` : "";
    const notes = rawStatus
      ? `Lifecycle informado pela Mouser: "${rawStatus}"${match.Manufacturer ? " — " + match.Manufacturer : ""}${agreementNote}.`
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
