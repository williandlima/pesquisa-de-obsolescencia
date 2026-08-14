// Netlify Function: check-part
// Consulta DUAS fontes independentes de distribuidor autorizado — Mouser e
// Farnell/element14 — e cruza os resultados. Quando as duas concordam, a
// confiança sobe para "high" de verdade (não é só uma fonte dizendo).
// Se uma das fontes falhar ou não tiver o dado, o app degrada graciosamente
// e usa só a outra, em vez de quebrar.
//
// Chaves em variáveis de ambiente no Netlify: MOUSER_API_KEY, FARNELL_API_KEY.
// FARNELL_API_KEY é opcional — se ausente, o app funciona só com Mouser.

const MOUSER_URL = "https://api.mouser.com/api/v1/search/partnumber";
const FARNELL_URL = "https://api.element14.com/catalog/products";

function normalizeStatus(raw) {
  if (!raw) return "unknown";
  const s = String(raw).toLowerCase();
  if (
    s.includes("obsolet") ||
    s.includes("eol") ||
    s.includes("end of life") ||
    s.includes("discontinu") ||
    s.includes("last time buy") ||
    s.includes("no longer manufactured")
  ) {
    return "obsolete";
  }
  if (
    s.includes("nrnd") ||
    s.includes("not recommended") ||
    s.includes("not for new") ||
    s.includes("to be discontinued")
  ) {
    return "nrnd";
  }
  if (
    s.includes("active") ||
    s.includes("new product") ||
    s.includes("production") ||
    s.includes("extending the range") ||
    s.includes("direct ship")
  ) {
    return "active";
  }
  return "unknown";
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, maxRetries = 2) {
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
  throw lastErr || new Error("Falha de rede após múltiplas tentativas.");
}

// ---- Fonte 1: Mouser ----
async function queryMouser(pn) {
  const apiKey = process.env.MOUSER_API_KEY;
  if (!apiKey) return null; // fonte não configurada, não é erro fatal

  try {
    const res = await fetchWithRetry(
      `${MOUSER_URL}?apiKey=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          SearchByPartRequest: { mouserPartNumber: pn, partSearchOptions: "None" },
        }),
      },
      2
    );
    const data = await res.json();
    const errors = data.Errors || (data.SearchResults && data.SearchResults.Errors) || [];
    if (Array.isArray(errors) && errors.length) return null;

    const parts = (data.SearchResults && data.SearchResults.Parts) || [];
    const match =
      parts.find((p) => p.ManufacturerPartNumber && p.ManufacturerPartNumber.toLowerCase() === pn.toLowerCase()) ||
      parts[0];
    if (!match) return null;

    const rawStatus = match.LifecycleStatus || "";
    return {
      source: "Mouser",
      status: normalizeStatus(rawStatus),
      rawStatus,
      manufacturer: match.Manufacturer || "",
      substitute: match.SuggestedReplacement || "",
      url: match.ProductDetailUrl || "",
      datasheetUrl: match.DataSheetUrl || "",
    };
  } catch (e) {
    return null; // degrada graciosamente
  }
}

// ---- Fonte 2: Farnell / element14 / Newark ----
async function queryFarnell(pn) {
  const apiKey = process.env.FARNELL_API_KEY;
  if (!apiKey) return null; // fonte opcional, não configurada

  try {
    const params = new URLSearchParams({
      term: `manuPartNum:${pn}`,
      "storeInfo.id": "us.farnell.com",
      "resultsSettings.offset": "0",
      "resultsSettings.numberOfResults": "3",
      "resultsSettings.responseGroup": "large",
      "callInfo.responseDataFormat": "JSON",
      "callInfo.apiKey": apiKey,
    });

    const res = await fetchWithRetry(`${FARNELL_URL}?${params.toString()}`, { method: "GET" }, 2);
    const data = await res.json();

    // A Farnell varia o nome da raiz dependendo do tipo de busca — tenta as conhecidas.
    const root =
      data.manufacturerPartNumberSearchReturn ||
      data.keywordSearchReturn ||
      data.premierFarnellPartNumberReturn ||
      null;
    if (!root || !Array.isArray(root.products) || !root.products.length) return null;

    const products = root.products;
    const match =
      products.find(
        (p) =>
          (p.translatedManufacturerPartNumber || p.manufacturerPartNumber || "")
            .toLowerCase() === pn.toLowerCase()
      ) || products[0];
    if (!match) return null;

    // releaseStatusCode: 4=Active, 6=To be Discontinued, 7=Discontinued
    // productStatus: STOCKED/NO_LONGER_MANUFACTURED/etc — usado como reforço.
    const codeMap = { "4": "active", "6": "nrnd", "7": "obsolete" };
    let status = "unknown";
    let rawStatus = "";
    if (match.releaseStatusCode !== undefined && codeMap[String(match.releaseStatusCode)]) {
      status = codeMap[String(match.releaseStatusCode)];
      rawStatus = `releaseStatusCode ${match.releaseStatusCode}`;
    } else if (match.productStatus) {
      rawStatus = match.productStatus;
      status = normalizeStatus(match.productStatus);
    }
    if (status === "unknown") return null;

    const datasheetUrl =
      (Array.isArray(match.datasheets) && match.datasheets[0] && match.datasheets[0].url) || "";

    return {
      source: "Farnell/element14",
      status,
      rawStatus,
      manufacturer: match.vendorName || match.brandName || "",
      substitute: "",
      url: match.productURL || match.translatedURL || "",
      datasheetUrl,
    };
  } catch (e) {
    return null; // degrada graciosamente — Farnell é fonte complementar, não crítica
  }
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Método não permitido" }) };

  let pn;
  try {
    ({ pn } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Corpo inválido" }) };
  }
  if (!pn || !pn.trim())
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Part number ausente" }) };

  const trimmedPn = pn.trim();

  if (!process.env.MOUSER_API_KEY && !process.env.FARNELL_API_KEY) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "Nenhuma fonte configurada (MOUSER_API_KEY / FARNELL_API_KEY) no servidor." }),
    };
  }

  try {
    // Consulta as duas fontes em paralelo — uma falhar não derruba a outra.
    const [mouser, farnell] = await Promise.all([queryMouser(trimmedPn), queryFarnell(trimmedPn)]);
    const results = [mouser, farnell].filter(Boolean);

    if (!results.length) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          status: "unknown",
          confidence: "low",
          substitute: "",
          manufacturer: "",
          notes: "Componente não encontrado nas bases consultadas (Mouser/Farnell). Verificação manual necessária.",
          sources: [],
        }),
      };
    }

    const distinctStatuses = [...new Set(results.map((r) => r.status))];
    const sources = results
      .filter((r) => r.url)
      .map((r) => ({ name: r.source, url: r.url }));
    results.forEach((r) => {
      if (r.datasheetUrl) sources.push({ name: `Datasheet (${r.source})`, url: r.datasheetUrl });
    });

    // Duas fontes, resultados diferentes => ambíguo, não escolhe arbitrariamente.
    if (results.length > 1 && distinctStatuses.length > 1) {
      const breakdown = results.map((r) => `${r.source}: ${r.rawStatus || r.status}`).join("; ");
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          status: "unknown",
          confidence: "low",
          substitute: results.find((r) => r.substitute)?.substitute || "",
          manufacturer: results[0].manufacturer,
          notes: `Fontes divergem: ${breakdown}. Verificação manual recomendada.`,
          sources: sources.slice(0, 4),
          ambiguous: true,
        }),
      };
    }

    // Concordância (ou fonte única) — confiança alta se 2 fontes bateram.
    const status = results[0].status;
    const confidence = results.length > 1 ? "high" : "medium";
    const substitute = results.find((r) => r.substitute)?.substitute || "";
    const manufacturer = results.find((r) => r.manufacturer)?.manufacturer || "";

    const agreementNote =
      results.length > 1 ? ` (${results.length} fontes independentes concordam: ${results.map((r) => r.source).join(", ")})` : ` (fonte: ${results[0].source})`;
    const notes = `Lifecycle: "${results[0].rawStatus || status}"${manufacturer ? " — " + manufacturer : ""}${agreementNote}.`;

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        status,
        confidence,
        substitute,
        manufacturer,
        notes,
        sources: sources.slice(0, 4),
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message || "Erro interno" }) };
  }
};
