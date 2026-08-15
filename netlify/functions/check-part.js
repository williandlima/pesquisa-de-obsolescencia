// Netlify Function: check-part  (v5)
// Consulta QUATRO fontes independentes e cruza os resultados:
//   1. Mouser (distribuidor autorizado)
//   2. Farnell/element14/Newark (distribuidor autorizado)
//   3. TrustedParts.com / ECIA (agregador SÓ de canal autorizado, 2000+ fabricantes)
//   4. Digi-Key (maior catálogo)
//
// Confiabilidade:
//   - Score de confiança ponderado por número de fontes que concordam.
//   - Casamento rigoroso por PN + fabricante (quando o fabricante é informado).
//   - Concordância entre fabricantes DIFERENTES não vira confiança alta: o mesmo
//     PN existe em vários fabricantes com lifecycles distintos.
//   - Degradação graciosa: qualquer fonte pode falhar sem derrubar as outras, e
//     cada uma tem orçamento de tempo próprio (a função morre em ~10s).
//
// Env vars no Netlify (todas opcionais, mas pelo menos uma precisa existir):
//   MOUSER_API_KEY
//   FARNELL_API_KEY
//   TRUSTEDPARTS_API_KEY + TRUSTEDPARTS_COMPANY_ID  (a ECIA exige os dois)
//   DIGIKEY_CLIENT_ID + DIGIKEY_CLIENT_SECRET

const MOUSER_URL = "https://api.mouser.com/api/v1/search/partnumber";
const FARNELL_URL = "https://api.element14.com/catalog/products";
const TRUSTEDPARTS_URL = "https://api.trustedparts.com/v2/search";
const DIGIKEY_TOKEN_URL = "https://api.digikey.com/v1/oauth2/token";
const DIGIKEY_SEARCH_URL = "https://api.digikey.com/products/v4/search/keyword";

// Peso de cada tipo de fonte para o cálculo de confiança.
// Distribuidor autorizado e canal-autorizado valem mais que agregador genérico.
const SOURCE_WEIGHT = {
  Mouser: 2,
  "Farnell/element14": 2,
  TrustedParts: 2,
  DigiKey: 2,
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

// A função da Netlify é morta em ~10s. Sem teto de tempo por fonte, uma única
// API pendurada trava as outras três e o usuário recebe um erro genérico de
// timeout em vez dos resultados que já estavam prontos. Por isso cada fonte tem
// orçamento próprio e cada tentativa é abortada individualmente.
//
// O teto precisa ser generoso: as fontes rodam EM PARALELO, então o tempo total
// da função é o da fonte mais lenta, não a soma. Um teto curto não acelera nada
// — só descarta fonte lenta que teria respondido. A element14/Farnell passa dos
// 3s com frequência, e perder uma fonte boa é pior que esperar mais um pouco.
const SOURCE_DEADLINE_MS = 7500; // orçamento total de uma fonte (todas as tentativas)
const ATTEMPT_TIMEOUT_MS = 7000; // teto de uma tentativa isolada

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, maxRetries = 2, deadlineMs = SOURCE_DEADLINE_MS) {
  const started = Date.now();
  const remaining = () => deadlineMs - (Date.now() - started);
  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const budget = Math.min(ATTEMPT_TIMEOUT_MS, remaining());
    if (budget <= 0) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (res.status >= 500 && attempt < maxRetries && remaining() > 0) {
        await sleep(Math.min(400 * (attempt + 1), Math.max(0, remaining())));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === "AbortError") {
        // Fonte pendurada: repetir só queimaria o orçamento das outras três,
        // que rodam em paralelo dentro do mesmo limite de 10s da função.
        throw new Error(`tempo esgotado (${budget}ms sem resposta)`);
      }
      lastErr = err;
      if (attempt < maxRetries && remaining() > 0) {
        await sleep(Math.min(400 * (attempt + 1), Math.max(0, remaining())));
        continue;
      }
    }
  }
  throw lastErr || new Error(`tempo esgotado (${deadlineMs}ms)`);
}

// Lê a resposta como JSON, mas devolve um motivo legível quando o servidor
// responde HTML (página de erro, portal de login, bloqueio de WAF).
async function readJson(res) {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("json")) {
    const text = await res.text();
    throw new Error(
      `resposta não-JSON (HTTP ${res.status}): ${text.slice(0, 120).replace(/\s+/g, " ")}`
    );
  }
  return res.json();
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
    const data = await readJson(res);
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
    const data = await readJson(res);

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
  const companyId = process.env.TRUSTEDPARTS_COMPANY_ID;
  if (!apiKey) return { result: null, debug: "não configurada" };
  if (!companyId) {
    return {
      result: null,
      debug: "falta TRUSTEDPARTS_COMPANY_ID (a API exige Company ID + API Key em toda requisição)",
    };
  }

  try {
    // A doc da ECIA é explícita: Company ID e API Key vão no CORPO de cada
    // requisição, em PascalCase — não em header Authorization: Bearer.
    // O formato do bloco de peças ainda não foi confirmado ao vivo, então o
    // debug abaixo devolve a resposta crua para revelar o schema no 1º teste.
    const body = {
      ApiKey: apiKey,
      CompanyId: companyId,
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
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
      2
    );

    const data = await readJson(res);
    if (res.status >= 400) {
      return {
        result: null,
        debug: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 160)}`,
      };
    }

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

// ---- Fonte 4: Digi-Key (maior catálogo, milhares de fabricantes) ----
let dkTokenCache = null;
let dkTokenExpiry = 0;

// Devolve { token } ou { error }. O motivo precisa chegar até as notas do
// resultado: "falha ao obter token" sozinho não diz se a credencial está errada,
// se é de sandbox, ou se a aplicação não tem a Product Information habilitada.
async function getDigiKeyToken() {
  const now = Date.now();
  if (dkTokenCache && now < dkTokenExpiry - 60000) return { token: dkTokenCache };

  const clientId = process.env.DIGIKEY_CLIENT_ID;
  const clientSecret = process.env.DIGIKEY_CLIENT_SECRET;
  // Nomear exatamente a variável que falta: dizer "faltam A/B" quando só B
  // falta manda o usuário procurar no lugar errado.
  const missing = [
    !clientId && "DIGIKEY_CLIENT_ID",
    !clientSecret && "DIGIKEY_CLIENT_SECRET",
  ].filter(Boolean);
  if (missing.length) {
    return {
      error: `falta a variável de ambiente ${missing.join(" e ")} no Netlify (defina e refaça o deploy)`,
    };
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  let res;
  try {
    res = await fetchWithRetry(
      DIGIKEY_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      },
      1
    );
  } catch (e) {
    return { error: `token: ${e.message}` };
  }

  let data;
  try {
    data = await readJson(res);
  } catch (e) {
    return { error: `token HTTP ${res.status}: ${e.message}` };
  }

  if (!res.ok || !data.access_token) {
    // O endpoint de token devolve error/error_description — é o que diz se o
    // client_id não existe, se o secret está errado ou se o app é de sandbox.
    const detail =
      [data.error, data.error_description || data.ErrorMessage]
        .filter(Boolean)
        .join(" — ") || JSON.stringify(data).slice(0, 160);
    return { error: `token HTTP ${res.status}: ${detail}` };
  }

  dkTokenCache = data.access_token;
  dkTokenExpiry = now + (data.expires_in || 1800) * 1000;
  return { token: dkTokenCache };
}

async function queryDigiKey(pn, mfr) {
  const clientId = process.env.DIGIKEY_CLIENT_ID;
  if (!clientId) return { result: null, debug: "não configurada" };

  try {
    const { token, error: tokenError } = await getDigiKeyToken();
    if (!token) return { result: null, debug: tokenError || "falha ao obter token OAuth2" };

    const res = await fetchWithRetry(
      DIGIKEY_SEARCH_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Accept é exigido pela V4 — sua ausência é causa conhecida de
          // HTTP 400 sem corpo de erro, difícil de diagnosticar.
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "X-DIGIKEY-Client-Id": clientId,
          "X-DIGIKEY-Locale-Site": "US",
          "X-DIGIKEY-Locale-Language": "en",
          "X-DIGIKEY-Locale-Currency": "USD",
        },
        body: JSON.stringify({ Keywords: pn, Limit: 10 }),
      },
      2
    );

    const data = await readJson(res);
    if (res.status >= 400) {
      return {
        result: null,
        debug: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 160)}`,
      };
    }

    const products = data.Products || data.ExactMatches || [];
    if (!Array.isArray(products) || !products.length) {
      return { result: null, debug: "componente não encontrado" };
    }

    let candidates = products.filter(
      (p) =>
        p.ManufacturerProductNumber &&
        p.ManufacturerProductNumber.toLowerCase() === pn.toLowerCase()
    );
    if (!candidates.length) candidates = products;

    if (mfr && mfr.trim()) {
      const filtered = candidates.filter((p) =>
        manufacturerMatches(p.Manufacturer && p.Manufacturer.Name, mfr)
      );
      if (filtered.length) candidates = filtered;
    }

    const match = candidates[0];
    if (!match) return { result: null, debug: "componente não encontrado" };

    const rawStatus = (match.ProductStatus && match.ProductStatus.Status) || "";
    const status = normalizeStatus(rawStatus);
    if (status === "unknown" && !rawStatus) {
      return { result: null, debug: "encontrado, mas sem campo de status preenchido" };
    }

    const datasheetUrl = match.DatasheetUrl || "";

    return {
      result: {
        source: "DigiKey",
        status,
        rawStatus,
        manufacturer: (match.Manufacturer && match.Manufacturer.Name) || "",
        substitute: "",
        url: match.ProductUrl || "",
        datasheetUrl,
        leadTime: "",
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
  const agreeingSources = conclusive.filter((r) => r.status === topStatus);
  const agreeing = agreeingSources.length;

  // Duas fontes concordarem só vale como confirmação se estiverem falando da
  // MESMA peça. O mesmo PN existe em fabricantes diferentes (LM317T da TI, da
  // onsemi, da ST) com lifecycles diferentes — nesse caso a concordância é
  // coincidência, não corroboração, e não pode virar confiança alta.
  const mfrs = agreeingSources.map((r) => r.manufacturer).filter(Boolean);
  let mfrConflict = false;
  for (let i = 0; i < mfrs.length && !mfrConflict; i++) {
    for (let j = i + 1; j < mfrs.length; j++) {
      if (!manufacturerMatches(mfrs[i], mfrs[j])) {
        mfrConflict = true;
        break;
      }
    }
  }

  let confidence;
  if (mfrConflict) confidence = "medium";
  else if (agreeing >= 2) confidence = "high";
  else confidence = "medium"; // fonte única
  return { status: topStatus, confidence, agreeing, mfrConflict };
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

  if (
    !process.env.MOUSER_API_KEY &&
    !process.env.FARNELL_API_KEY &&
    !process.env.TRUSTEDPARTS_API_KEY &&
    !process.env.DIGIKEY_CLIENT_ID
  ) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "Nenhuma fonte configurada no servidor." }),
    };
  }

  try {
    const [mouserOut, farnellOut, tpOut, dkOut] = await Promise.all([
      queryMouser(trimmedPn, mfr),
      queryFarnell(trimmedPn, mfr),
      queryTrustedParts(trimmedPn, mfr),
      queryDigiKey(trimmedPn, mfr),
    ]);

    const outs = [mouserOut, farnellOut, tpOut, dkOut];
    const results = outs.map((o) => o.result).filter(Boolean);

    const diagnostics = [];
    if (!mouserOut.result) diagnostics.push(`Mouser: ${mouserOut.debug}`);
    if (!farnellOut.result) diagnostics.push(`Farnell: ${farnellOut.debug}`);
    if (!tpOut.result) diagnostics.push(`TrustedParts: ${tpOut.debug}`);
    if (!dkOut.result) diagnostics.push(`DigiKey: ${dkOut.debug}`);
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
    // Guarda de qual fonte veio o substituto. O SuggestedReplacement da Mouser é
    // o código de estoque DELA (ex.: 863-LM317TG), não um MPN de fabricante —
    // sem rótulo, alguém colaria isso numa BOM achando que é part number.
    const subResult = results.find((r) => r.substitute);
    const substitute = subResult ? subResult.substitute : "";
    const substituteSource = subResult ? subResult.source : "";
    const manufacturer = results.find((r) => r.manufacturer)?.manufacturer || "";
    // Lead time zerado é o valor default do catálogo quando não há prazo, não um
    // prazo de zero dia — anunciá-lo numa peça obsoleta induz ao erro.
    const leadTime = results.find((r) => r.leadTime && !/^0\s*\D*$/.test(String(r.leadTime).trim()))?.leadTime || "";

    // Monta a nota final detalhada. Quando os fabricantes divergem, cada fonte
    // aparece com o seu — é a informação que explica por que a confiança caiu.
    const perSource = results
      .map((r) =>
        combined.mfrConflict && r.manufacturer
          ? `${r.source} (${r.manufacturer}): ${r.rawStatus || r.status}`
          : `${r.source}: ${r.rawStatus || r.status}`
      )
      .join("; ");

    let notes;
    if (combined.status === "unknown") {
      notes = `${combined.note || "Não conclusivo."} Fontes: ${perSource}.${leadTime ? " Lead time: " + leadTime + "." : ""}${diagSuffix}`;
    } else if (combined.mfrConflict) {
      notes = `Lifecycle: "${combined.status}" — ATENÇÃO: as fontes respondem por fabricantes diferentes para este PN, então a concordância não confirma a mesma peça. Informe o fabricante para desambiguar (${perSource}).${leadTime ? " Lead time: " + leadTime + "." : ""}${diagSuffix}`;
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
        substituteSource,
        manufacturer,
        notes,
        sources: sources.slice(0, 5),
        ambiguous: !!combined.diverge,
        mfrConflict: !!combined.mfrConflict,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message || "Erro interno" }) };
  }
};
