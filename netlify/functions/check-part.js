// Netlify Function: check-part  (v4)
// Consulta TRÊS fontes independentes e cruza os resultados:
//   1. Mouser (distribuidor autorizado)
//   2. Farnell/element14/Newark (distribuidor autorizado)
//   3. TrustedParts.com / ECIA (agregador SÓ de canal autorizado, 2000+ fabricantes)
//
// Melhorias de confiabilidade nesta versão:
//   - Score de confiança PONDERADO por tipo e número de fontes que concordam.
//   - Casamento rigoroso por PN + fabricante (quando o fabricante é informado).
//   - Captura de dados acionáveis extras: lead time, e sinal de risco de lifecycle.
//   - Degradação graciosa: qualquer fonte pode falhar sem derrubar as outras.
//
// Chaves (env vars no Netlify): MOUSER_API_KEY, FARNELL_API_KEY (opcional),
// TRUSTEDPARTS_API_KEY (opcional). Se só a Mouser estiver configurada, funciona.

const MOUSER_URL = "https://api.mouser.com/api/v1/search/partnumber";
const FARNELL_URL = "https://api.element14.com/catalog/products";
const TRUSTEDPARTS_URL = "https://api.trustedparts.com/v2/search";

// Peso de cada tipo de fonte para o cálculo de confiança.
// Distribuidor autorizado e canal-autorizado valem mais que agregador genérico.
const SOURCE_WEIGHT = {
  Mouser: 2,
  "Farnell/element14": 2,
  TrustedParts: 2,
};

function normalizeStatus(raw) {
  if (!raw) return "unknown";
  const s = String(raw).toLowerCase();
  if (
    s.includes("obsolet") ||
    s.includes("eol") ||
    s.includes("end of life") ||
    s.includes("discontinu") ||
    s.includes("last time buy") ||
    s.includes("no longer manufactured") ||
    s.includes("inactive")
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

// Verifica se o fabricante retornado casa com o que o usuário pediu (se pediu).
function manufacturerMatches(candidateMfr, requestedMfr) {
  if (!requestedMfr || !requestedMfr.trim()) return true; // sem filtro
  if (!candidateMfr) return false;
  const a = candidateMfr.toLowerCase();
  const b = requestedMfr.trim().toLowerCase();
  return a.includes(b) || b.includes(a);
}

// ---- Fonte 1: Mouser ----
async function queryMouser(pn, mfr) {
  const apiKey = process.env.MOUSER_API_KEY;
  if (!apiKey) return { result: null, debug: "não configurada" };

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
    if (Array.isArray(errors) && errors.length) {
      return { result: null, debug: `erro: ${errors.map((e) => e.Message).join(", ")}` };
    }

    const parts = (data.SearchResults && data.SearchResults.Parts) || [];
    let exactMatches = parts.filter(
      (p) => p.ManufacturerPartNumber && p.ManufacturerPartNumber.toLowerCase() === pn.toLowerCase()
    );
    // Casamento por fabricante, se informado.
    if (mfr && mfr.trim()) {
      const filtered = exactMatches.filter((p) => manufacturerMatches(p.Manufacturer, mfr));
      if (filtered.length) exactMatches = filtered;
    }
    if (!exactMatches.length) exactMatches = parts.slice(0, 1);
    if (!exactMatches.length) return { result: null, debug: "componente não encontrado" };

    const withStatus = exactMatches.find((p) => p.LifecycleStatus && p.LifecycleStatus.trim());
    const match = withStatus || exactMatches[0];

    const rawStatus = match.LifecycleStatus || "";
    const status = normalizeStatus(rawStatus);
    if (status === "unknown" && !rawStatus) {
      return { result: null, debug: "encontrado, mas sem campo de lifecycle preenchido" };
    }

    return {
      result: {
        source: "Mouser",
        status,
        rawStatus,
        manufacturer: match.Manufacturer || "",
        substitute: match.SuggestedReplacement || "",
        url: match.ProductDetailUrl || "",
        datasheetUrl: match.DataSheetUrl || "",
        leadTime: match.LeadTime || "",
      },
      debug: "ok",
    };
  } catch (e) {
    return { result: null, debug: `erro: ${e.message}` };
  }
}

// ---- Fonte 2: Farnell / element14 / Newark ----
async function queryFarnell(pn, mfr) {
  const apiKey = process.env.FARNELL_API_KEY;
  if (!apiKey) return { result: null, debug: "não configurada" };

  try {
    const params = new URLSearchParams({
      term: `manuPartNum:${pn}`,
      "storeInfo.id": "www.newark.com",
      "resultsSettings.offset": "0",
      "resultsSettings.numberOfResults": "5",
      "resultsSettings.responseGroup": "large",
      "callInfo.responseDataFormat": "JSON",
      "callInfo.apiKey": apiKey,
    });

    const res = await fetchWithRetry(`${FARNELL_URL}?${params.toString()}`, { method: "GET" }, 2);
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      const text = await res.text();
      return {
        result: null,
        debug: `resposta não-JSON (HTTP ${res.status}): ${text.slice(0, 120).replace(/\s+/g, " ")}`,
      };
    }
    const data = await res.json();

    const root =
      data.manufacturerPartNumberSearchReturn ||
      data.keywordSearchReturn ||
      data.premierFarnellPartNumberReturn ||
      null;
    if (!root) {
      return { result: null, debug: `formato inesperado: ${Object.keys(data).join(",") || "vazio"}` };
    }
    if (!Array.isArray(root.products) || !root.products.length) {
      return { result: null, debug: "componente não encontrado" };
    }

    let products = root.products;
    if (mfr && mfr.trim()) {
      const filtered = products.filter((p) =>
        manufacturerMatches(p.vendorName || p.brandName, mfr)
      );
      if (filtered.length) products = filtered;
    }

    const match =
      products.find(
        (p) =>
          (p.translatedManufacturerPartNumber || p.manufacturerPartNumber || "").toLowerCase() === pn.toLowerCase()
      ) || products[0];
    if (!match) return { result: null, debug: "componente não encontrado" };

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
    if (status === "unknown") {
      return { result: null, debug: "encontrado, mas sem status reconhecível" };
    }

    const datasheetUrl =
      (Array.isArray(match.datasheets) && match.datasheets[0] && match.datasheets[0].url) || "";

    return {
      result: {
        source: "Farnell/element14",
        status,
        rawStatus,
        manufacturer: match.vendorName || match.brandName || "",
        substitute: "",
        url: match.productURL || match.translatedURL || "",
        datasheetUrl,
        leadTime: match.leadTime || "",
      },
      debug: "ok",
    };
  } catch (e) {
    return { result: null, debug: `erro: ${e.message}` };
  }
}

// ---- Fonte 3: TrustedParts.com (ECIA — só canal autorizado) ----
async function queryTrustedParts(pn, mfr) {
  const apiKey = process.env.TRUSTEDPARTS_API_KEY;
  if (!apiKey) return { result: null, debug: "não configurada" };

  try {
    const body = {
      PartNumber: pn,
      SearchOptions: { PartNumberSearchMode: "Exact" },
    };
    if (mfr && mfr.trim()) body.Manufacturers = [mfr.trim()];

    const res = await fetchWithRetry(
      TRUSTEDPARTS_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      2
    );

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      const text = await res.text();
      return {
        result: null,
        debug: `resposta não-JSON (HTTP ${res.status}): ${text.slice(0, 120).replace(/\s+/g, " ")}`,
      };
    }
    const data = await res.json();

    // A estrutura pode variar; tenta os caminhos conhecidos da v2.
    const products = data.Products || data.products || (data.Results && data.Results.Products) || [];
    if (!Array.isArray(products) || !products.length) {
      return { result: null, debug: "componente não encontrado no canal autorizado" };
    }

    let candidates = products;
    if (mfr && mfr.trim()) {
      const filtered = products.filter((p) => manufacturerMatches(p.Manufacturer || p.manufacturer, mfr));
      if (filtered.length) candidates = filtered;
    }

    const match = candidates[0];
    const rawLifecycle =
      match.LifecycleStatus || match.lifecycleStatus ||
      (match.LifecycleRisk && (match.LifecycleRisk.Status || match.LifecycleRisk.status)) || "";
    const status = normalizeStatus(rawLifecycle);

    // TrustedParts é valioso mesmo sem status explícito: confirma que o PN
    // ainda tem distribuidor AUTORIZADO com estoque (sinal indireto de "vivo").
    const hasAuthorizedStock =
      (Array.isArray(match.Distributors) && match.Distributors.length > 0) ||
      (match.TotalAvailability && Number(match.TotalAvailability) > 0);

    if (status === "unknown" && !hasAuthorizedStock) {
      return { result: null, debug: "encontrado, mas sem status nem estoque autorizado" };
    }

    return {
      result: {
        source: "TrustedParts",
        status,
        rawStatus: rawLifecycle || (hasAuthorizedStock ? "com estoque em canal autorizado" : ""),
        manufacturer: match.Manufacturer || match.manufacturer || "",
        substitute: "",
        url: match.ProductUrl || match.productUrl || "",
        datasheetUrl: match.DatasheetUrl || match.datasheetUrl || "",
        leadTime: "",
        authorizedStock: !!hasAuthorizedStock,
      },
      debug: "ok",
    };
  } catch (e) {
    return { result: null, debug: `erro: ${e.message}` };
  }
}

// Calcula status final + confiança ponderada a partir das fontes que responderam.
function combine(results) {
  // Considera só as que têm status conclusivo para votar.
  const conclusive = results.filter((r) => r.status !== "unknown");

  if (!conclusive.length) {
    // Nenhuma deu status, mas pode haver sinal de "vivo" (estoque autorizado).
    const aliveSignal = results.find((r) => r.authorizedStock);
    if (aliveSignal) {
      return {
        status: "unknown",
        confidence: "low",
        note: "Sem status explícito, mas há estoque em canal autorizado (TrustedParts). Verificação manual recomendada.",
      };
    }
    return { status: "unknown", confidence: "low", note: "Nenhuma fonte retornou status conclusivo." };
  }

  // Agrupa votos por status, ponderando pelo peso da fonte.
  const votes = {};
  conclusive.forEach((r) => {
    const w = SOURCE_WEIGHT[r.source] || 1;
    votes[r.status] = (votes[r.status] || 0) + w;
  });
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const [topStatus, topWeight] = ranked[0];
  const distinct = ranked.length;

  // Divergência real entre fontes conclusivas => não conclusivo (força manual).
  if (distinct > 1) {
    return {
      status: "unknown",
      confidence: "low",
      note: "Fontes conclusivas divergem entre si — verificação manual necessária.",
      diverge: true,
    };
  }

  // Todas concordam. Confiança pelo nº de fontes independentes concordando.
  const agreeing = conclusive.filter((r) => r.status === topStatus).length;
  let confidence;
  if (agreeing >= 3) confidence = "high";
  else if (agreeing === 2) confidence = "high";
  else confidence = "medium"; // fonte única
  return { status: topStatus, confidence, agreeing };
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

  let pn, mfr;
  try {
    ({ pn, mfr } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Corpo inválido" }) };
  }
  if (!pn || !pn.trim())
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Part number ausente" }) };

  const trimmedPn = pn.trim();

  if (!process.env.MOUSER_API_KEY && !process.env.FARNELL_API_KEY && !process.env.TRUSTEDPARTS_API_KEY) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "Nenhuma fonte configurada no servidor." }),
    };
  }

  try {
    const [mouserOut, farnellOut, tpOut] = await Promise.all([
      queryMouser(trimmedPn, mfr),
      queryFarnell(trimmedPn, mfr),
      queryTrustedParts(trimmedPn, mfr),
    ]);

    const outs = [mouserOut, farnellOut, tpOut];
    const results = outs.map((o) => o.result).filter(Boolean);

    const diagnostics = [];
    if (!mouserOut.result) diagnostics.push(`Mouser: ${mouserOut.debug}`);
    if (!farnellOut.result) diagnostics.push(`Farnell: ${farnellOut.debug}`);
    if (!tpOut.result) diagnostics.push(`TrustedParts: ${tpOut.debug}`);
    const diagSuffix = diagnostics.length ? ` [${diagnostics.join(" | ")}]` : "";

    // Fontes (links) e datasheets, deduplicados.
    const sources = [];
    const seen = new Set();
    results.forEach((r) => {
      if (r.url && !seen.has(r.url)) {
        seen.add(r.url);
        sources.push({ name: r.source, url: r.url });
      }
    });
    results.forEach((r) => {
      if (r.datasheetUrl && !seen.has(r.datasheetUrl)) {
        seen.add(r.datasheetUrl);
        sources.push({ name: `Datasheet (${r.source})`, url: r.datasheetUrl });
      }
    });

    if (!results.length) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          status: "unknown",
          confidence: "low",
          substitute: "",
          manufacturer: "",
          notes: `Componente não encontrado nas bases consultadas. Verificação manual necessária.${diagSuffix}`,
          sources: [],
        }),
      };
    }

    const combined = combine(results);
    const substitute = results.find((r) => r.substitute)?.substitute || "";
    const manufacturer = results.find((r) => r.manufacturer)?.manufacturer || "";
    const leadTime = results.find((r) => r.leadTime)?.leadTime || "";

    // Monta a nota final detalhada.
    const perSource = results
      .map((r) => `${r.source}: ${r.rawStatus || r.status}`)
      .join("; ");

    let notes;
    if (combined.status === "unknown") {
      notes = `${combined.note || "Não conclusivo."} Fontes: ${perSource}.${leadTime ? " Lead time: " + leadTime + "." : ""}${diagSuffix}`;
    } else {
      const agree =
        combined.agreeing > 1
          ? ` — ${combined.agreeing} fontes independentes concordam`
          : ` — fonte única`;
      notes = `Lifecycle: "${combined.status}"${manufacturer ? " — " + manufacturer : ""}${agree} (${perSource}).${leadTime ? " Lead time: " + leadTime + "." : ""}${diagSuffix}`;
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        status: combined.status,
        confidence: combined.confidence,
        substitute,
        manufacturer,
        notes,
        sources: sources.slice(0, 5),
        ambiguous: !!combined.diverge,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message || "Erro interno" }) };
  }
};
