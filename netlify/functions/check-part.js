// Netlify Function: check-part  (v6)
// Consulta QUATRO fontes independentes e cruza os resultados:
//   1. Mouser (distribuidor autorizado)
//   2. Farnell/element14/Newark (distribuidor autorizado)
//   3. TrustedParts.com / ECIA (agregador SÓ de canal autorizado, 2000+ fabricantes)
//   4. Digi-Key (maior catálogo)
//
// Confiabilidade:
//   - Cada fonte pode devolver MAIS DE UM fabricante para o mesmo PN (quando o
//     usuário não informa fabricante). Em vez de escolher um arbitrariamente,
//     agrupamos por fabricante ENTRE as 4 fontes e votamos dentro de cada grupo
//     — assim "TI: active (2 fontes concordam)" e "onsemi: obsolete (1 fonte)"
//     aparecem como candidatos separados, cada um com a confiança que merece.
//   - Score de confiança ponderado por número de fontes que concordam DENTRO
//     do mesmo grupo de fabricante.
//   - Casamento por PN + fabricante quando o usuário informa o fabricante (filtro
//     é "soft": se nada bater, mostra os candidatos encontrados em vez de falhar).
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

// Quantos fabricantes distintos mostrar, por fonte e no total. Sem teto, um PN
// genérico (ex.: um transistor 2N2222 clonado por dezenas de fabricantes)
// inundaria a resposta.
const MAX_MANUFACTURER_CANDIDATES = 5;

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
// Filtro "soft": sem fabricante pedido, tudo passa.
function manufacturerMatches(candidateMfr, requestedMfr) {
  if (!requestedMfr || !requestedMfr.trim()) return true; // sem filtro
  if (!candidateMfr) return false;
  const a = candidateMfr.toLowerCase();
  const b = requestedMfr.trim().toLowerCase();
  return a.includes(b) || b.includes(a);
}

// Igualdade para AGRUPAR candidatos por fabricante (não para filtrar). Diferente
// de manufacturerMatches: aqui fabricante vazio só combina com outro vazio —
// não pode virar curinga que gruta qualquer coisa junto de um fabricante real.
function manufacturersEqual(a, b) {
  const x = (a || "").trim().toLowerCase();
  const y = (b || "").trim().toLowerCase();
  if (!x && !y) return true;
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

// Agrupa os itens brutos de UMA fonte por fabricante e escolhe o melhor
// representante de cada grupo (o que tem status preenchido, quando existe).
// Sem fabricante pedido, ou quando o pedido não bate com nada, devolve um
// candidato por fabricante distinto encontrado — é isso que permite comparar
// TI x onsemi x ST para o mesmo PN em vez de escolher um dos três sem avisar.
function pickManufacturerCandidates(items, { getMfr, hasStatus, mfr, maxCandidates = MAX_MANUFACTURER_CANDIDATES }) {
  if (!items.length) return [];

  let pool = items;
  if (mfr && mfr.trim()) {
    const filtered = items.filter((it) => manufacturerMatches(getMfr(it), mfr));
    if (filtered.length) pool = filtered; // não bateu em nada: mantém tudo (filtro soft)
  }

  const groups = [];
  pool.forEach((it) => {
    const m = getMfr(it) || "";
    let group = groups.find((g) => manufacturersEqual(g.key, m));
    if (!group) {
      group = { key: m, items: [] };
      groups.push(group);
    }
    group.items.push(it);
  });

  return groups.slice(0, maxCandidates).map((g) => g.items.find(hasStatus) || g.items[0]);
}

// ---- Fonte 1: Mouser ----
async function queryMouser(pn, mfr) {
  const apiKey = process.env.MOUSER_API_KEY;
  if (!apiKey) return { results: [], debug: "não configurada" };

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
      return { results: [], debug: `erro: ${errors.map((e) => e.Message).join(", ")}` };
    }

    const parts = (data.SearchResults && data.SearchResults.Parts) || [];
    let exactMatches = parts.filter(
      (p) => p.ManufacturerPartNumber && p.ManufacturerPartNumber.toLowerCase() === pn.toLowerCase()
    );
    if (!exactMatches.length) exactMatches = parts.slice(0, 1);
    if (!exactMatches.length) return { results: [], debug: "componente não encontrado" };

    const picks = pickManufacturerCandidates(exactMatches, {
      getMfr: (p) => p.Manufacturer,
      hasStatus: (p) => !!(p.LifecycleStatus && p.LifecycleStatus.trim()),
      mfr,
    });

    const results = picks
      .map((match) => {
        const rawStatus = match.LifecycleStatus || "";
        const status = normalizeStatus(rawStatus);
        if (status === "unknown" && !rawStatus) return null;
        return {
          source: "Mouser",
          status,
          rawStatus,
          manufacturer: match.Manufacturer || "",
          substitute: match.SuggestedReplacement || "",
          url: match.ProductDetailUrl || "",
          datasheetUrl: match.DataSheetUrl || "",
          leadTime: match.LeadTime || "",
        };
      })
      .filter(Boolean);

    if (!results.length) return { results: [], debug: "encontrado, mas sem campo de lifecycle preenchido" };
    return { results, debug: "ok" };
  } catch (e) {
    console.error(`[check-part] Mouser falhou para "${pn}":`, e.message);
    return { results: [], debug: `erro: ${e.message}` };
  }
}

// ---- Fonte 2: Farnell / element14 / Newark ----
async function queryFarnell(pn, mfr) {
  const apiKey = process.env.FARNELL_API_KEY;
  if (!apiKey) return { results: [], debug: "não configurada" };

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
      return { results: [], debug: `formato inesperado: ${Object.keys(data).join(",") || "vazio"}` };
    }
    if (!Array.isArray(root.products) || !root.products.length) {
      return { results: [], debug: "componente não encontrado" };
    }

    // PN exato tem prioridade; sem ele, usa a lista bruta da busca (a API já
    // busca por manuPartNum, então normalmente é tudo relevante).
    const pnExact = root.products.filter(
      (p) =>
        (p.translatedManufacturerPartNumber || p.manufacturerPartNumber || "").toLowerCase() === pn.toLowerCase()
    );
    const pool = pnExact.length ? pnExact : root.products;

    const codeMap = { "4": "active", "6": "nrnd", "7": "obsolete" };
    const deriveStatus = (p) => {
      if (p.releaseStatusCode !== undefined && codeMap[String(p.releaseStatusCode)]) {
        return { status: codeMap[String(p.releaseStatusCode)], rawStatus: `releaseStatusCode ${p.releaseStatusCode}` };
      }
      if (p.productStatus) return { status: normalizeStatus(p.productStatus), rawStatus: p.productStatus };
      return { status: "unknown", rawStatus: "" };
    };

    const picks = pickManufacturerCandidates(pool, {
      getMfr: (p) => p.vendorName || p.brandName,
      hasStatus: (p) => deriveStatus(p).status !== "unknown",
      mfr,
    });

    const results = picks
      .map((match) => {
        const { status, rawStatus } = deriveStatus(match);
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
          leadTime: match.leadTime || "",
        };
      })
      .filter(Boolean);

    if (!results.length) return { results: [], debug: "encontrado, mas sem status reconhecível" };
    return { results, debug: "ok" };
  } catch (e) {
    console.error(`[check-part] Farnell falhou para "${pn}":`, e.message);
    return { results: [], debug: `erro: ${e.message}` };
  }
}

// ---- Fonte 3: TrustedParts.com (ECIA — só canal autorizado) ----
async function queryTrustedParts(pn, mfr) {
  const apiKey = process.env.TRUSTEDPARTS_API_KEY;
  const companyId = process.env.TRUSTEDPARTS_COMPANY_ID;
  if (!apiKey) return { results: [], debug: "não configurada" };
  if (!companyId) {
    return {
      results: [],
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
        results: [],
        debug: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 160)}`,
      };
    }

    // A estrutura pode variar; tenta os caminhos conhecidos da v2.
    const products = data.Products || data.products || (data.Results && data.Results.Products) || [];
    if (!Array.isArray(products) || !products.length) {
      return { results: [], debug: "componente não encontrado no canal autorizado" };
    }

    const picks = pickManufacturerCandidates(products, {
      getMfr: (p) => p.Manufacturer || p.manufacturer,
      hasStatus: (p) =>
        !!(
          p.LifecycleStatus ||
          p.lifecycleStatus ||
          (p.LifecycleRisk && (p.LifecycleRisk.Status || p.LifecycleRisk.status))
        ),
      mfr,
    });

    const results = picks
      .map((match) => {
        const rawLifecycle =
          match.LifecycleStatus ||
          match.lifecycleStatus ||
          (match.LifecycleRisk && (match.LifecycleRisk.Status || match.LifecycleRisk.status)) ||
          "";
        const status = normalizeStatus(rawLifecycle);

        // TrustedParts é valioso mesmo sem status explícito: confirma que o PN
        // ainda tem distribuidor AUTORIZADO com estoque (sinal indireto de "vivo").
        const hasAuthorizedStock =
          (Array.isArray(match.Distributors) && match.Distributors.length > 0) ||
          (match.TotalAvailability && Number(match.TotalAvailability) > 0);

        if (status === "unknown" && !hasAuthorizedStock) return null;

        return {
          source: "TrustedParts",
          status,
          rawStatus: rawLifecycle || (hasAuthorizedStock ? "com estoque em canal autorizado" : ""),
          manufacturer: match.Manufacturer || match.manufacturer || "",
          substitute: "",
          url: match.ProductUrl || match.productUrl || "",
          datasheetUrl: match.DatasheetUrl || match.datasheetUrl || "",
          leadTime: "",
          authorizedStock: !!hasAuthorizedStock,
        };
      })
      .filter(Boolean);

    if (!results.length) return { results: [], debug: "encontrado, mas sem status nem estoque autorizado" };
    return { results, debug: "ok" };
  } catch (e) {
    console.error(`[check-part] TrustedParts falhou para "${pn}":`, e.message);
    return { results: [], debug: `erro: ${e.message}` };
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
  if (!clientId) return { results: [], debug: "não configurada" };

  try {
    const { token, error: tokenError } = await getDigiKeyToken();
    if (!token) return { results: [], debug: tokenError || "falha ao obter token OAuth2" };

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
        results: [],
        debug: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 160)}`,
      };
    }

    const products = data.Products || data.ExactMatches || [];
    if (!Array.isArray(products) || !products.length) {
      return { results: [], debug: "componente não encontrado" };
    }

    let pnExact = products.filter(
      (p) =>
        p.ManufacturerProductNumber &&
        p.ManufacturerProductNumber.toLowerCase() === pn.toLowerCase()
    );
    const pool = pnExact.length ? pnExact : products;

    const picks = pickManufacturerCandidates(pool, {
      getMfr: (p) => p.Manufacturer && p.Manufacturer.Name,
      hasStatus: (p) => !!(p.ProductStatus && p.ProductStatus.Status),
      mfr,
    });

    const results = picks
      .map((match) => {
        const rawStatus = (match.ProductStatus && match.ProductStatus.Status) || "";
        const status = normalizeStatus(rawStatus);
        if (status === "unknown" && !rawStatus) return null;
        return {
          source: "DigiKey",
          status,
          rawStatus,
          manufacturer: (match.Manufacturer && match.Manufacturer.Name) || "",
          substitute: "",
          url: match.ProductUrl || "",
          datasheetUrl: match.DatasheetUrl || "",
          leadTime: "",
        };
      })
      .filter(Boolean);

    if (!results.length) return { results: [], debug: "encontrado, mas sem campo de status preenchido" };
    return { results, debug: "ok" };
  } catch (e) {
    console.error(`[check-part] Digi-Key falhou para "${pn}":`, e.message);
    return { results: [], debug: `erro: ${e.message}` };
  }
}

// Calcula status final + confiança ponderada a partir das fontes que responderam
// para o MESMO fabricante (o agrupamento por fabricante acontece antes, no
// handler — aqui as fontes já falam da mesma peça).
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
  const [topStatus] = ranked[0];
  const distinct = ranked.length;

  // Divergência real entre fontes conclusivas => não conclusivo (força manual).
  // Como o agrupamento por fabricante já separou os candidatos antes de chegar
  // aqui, isso agora significa que fontes DISCORDAM sobre a MESMA peça — não
  // que são fabricantes diferentes (isso vira grupos/candidatos separados).
  if (distinct > 1) {
    return {
      status: "unknown",
      confidence: "low",
      note: "Fontes conclusivas divergem entre si para o mesmo fabricante — verificação manual necessária.",
      diverge: true,
    };
  }

  const agreeing = conclusive.filter((r) => r.status === topStatus).length;
  const confidence = agreeing >= 2 ? "high" : "medium"; // fonte única
  return { status: topStatus, confidence, agreeing };
}

// Fontes (links) e datasheets do grupo, deduplicados. Escopado por grupo: um
// candidato de fabricante só mostra as fontes que falaram DELE, não das outras.
function dedupeSources(items) {
  const sources = [];
  const seen = new Set();
  items.forEach((r) => {
    if (r.url && !seen.has(r.url)) {
      seen.add(r.url);
      sources.push({ name: r.source, url: r.url });
    }
  });
  items.forEach((r) => {
    if (r.datasheetUrl && !seen.has(r.datasheetUrl)) {
      seen.add(r.datasheetUrl);
      sources.push({ name: `Datasheet (${r.source})`, url: r.datasheetUrl });
    }
  });
  return sources;
}

// Monta um candidato (um fabricante) a partir dos resultados das fontes que
// concordam se tratar dele.
function buildCandidate(items) {
  const combined = combine(items);
  const subResult = items.find((r) => r.substitute);
  const substitute = subResult ? subResult.substitute : "";
  const substituteSource = subResult ? subResult.source : "";
  const manufacturer = items.find((r) => r.manufacturer)?.manufacturer || "";
  // Lead time zerado é o valor default do catálogo quando não há prazo, não um
  // prazo de zero dia — anunciá-lo numa peça obsoleta induz ao erro.
  const leadTime = items.find((r) => r.leadTime && !/^0\s*\D*$/.test(String(r.leadTime).trim()))?.leadTime || "";
  const perSource = items.map((r) => `${r.source}: ${r.rawStatus || r.status}`).join("; ");

  let notes;
  if (combined.status === "unknown") {
    notes = `${combined.note || "Não conclusivo."} Fontes: ${perSource}.${leadTime ? " Lead time: " + leadTime + "." : ""}`;
  } else {
    const agree =
      combined.agreeing > 1 ? ` — ${combined.agreeing} fontes independentes concordam` : ` — fonte única`;
    notes = `Lifecycle: "${combined.status}"${manufacturer ? " — " + manufacturer : ""}${agree} (${perSource}).${leadTime ? " Lead time: " + leadTime + "." : ""}`;
  }

  return {
    manufacturer,
    status: combined.status,
    confidence: combined.confidence,
    substitute,
    substituteSource,
    notes,
    sources: dedupeSources(items).slice(0, 5),
    agreeing: combined.agreeing || 0,
    sourceCount: items.length,
    ambiguous: !!combined.diverge,
  };
}

// Agrupa resultados de TODAS as fontes por fabricante (fuzzy). É aqui que
// "LM317T sem fabricante informado" vira grupos separados por TI/onsemi/ST em
// vez de um resultado só escolhido sem critério de negócio.
function groupByManufacturer(results) {
  const groups = [];
  results.forEach((r) => {
    const m = r.manufacturer || "";
    let group = groups.find((g) => manufacturersEqual(g.key, m));
    if (!group) {
      group = { key: m, items: [] };
      groups.push(group);
    }
    group.items.push(r);
  });
  return groups;
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

// Ordena candidatos: confiança primeiro, depois nº de fontes concordando,
// depois nº total de fontes que falaram dele, depois se tem fabricante nomeado
// (grupo "fabricante não identificado" fica por último em empate).
function compareCandidates(a, b) {
  const ra = [
    CONFIDENCE_RANK[a.confidence] || 0,
    a.agreeing,
    a.sourceCount,
    a.manufacturer ? 1 : 0,
  ];
  const rb = [
    CONFIDENCE_RANK[b.confidence] || 0,
    b.agreeing,
    b.sourceCount,
    b.manufacturer ? 1 : 0,
  ];
  for (let i = 0; i < ra.length; i++) {
    if (rb[i] !== ra[i]) return rb[i] - ra[i];
  }
  return 0;
}

// "*" deixava qualquer site do mundo chamar esta função pelo navegador de
// quem estivesse com a página aberta — e cada chamada bate em APIs pagas com
// cota limitada (Mouser/Farnell/Digi-Key/TrustedParts). Travar no domínio do
// app não impede chamada direta via curl/script (CORS é aplicado pelo
// navegador, não pelo servidor), mas fecha o vetor de abuso via browser.
const ALLOWED_ORIGIN = "https://obscomp2026.netlify.app";

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
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

    const outs = [
      { name: "Mouser", out: mouserOut },
      { name: "Farnell", out: farnellOut },
      { name: "TrustedParts", out: tpOut },
      { name: "DigiKey", out: dkOut },
    ];
    const allResults = outs.flatMap(({ out }) => out.results || []);

    const diagnostics = outs
      .filter(({ out }) => !out.results || !out.results.length)
      .map(({ name, out }) => `${name}: ${out.debug}`);
    const diagSuffix = diagnostics.length ? ` [${diagnostics.join(" | ")}]` : "";

    if (!allResults.length) {
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

    const candidates = groupByManufacturer(allResults)
      .map((g) => buildCandidate(g.items))
      .sort(compareCandidates)
      .slice(0, MAX_MANUFACTURER_CANDIDATES);

    const primary = candidates[0];
    let notes = primary.notes + diagSuffix;
    if (candidates.length > 1) {
      const others = candidates
        .slice(1)
        .map((c) => `${c.manufacturer || "fabricante não identificado"} (${c.status})`)
        .join(", ");
      notes += ` Este PN também é feito por: ${others} — informe o fabricante para focar em um só.`;
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        status: primary.status,
        confidence: primary.confidence,
        substitute: primary.substitute,
        substituteSource: primary.substituteSource,
        manufacturer: primary.manufacturer,
        notes,
        sources: primary.sources,
        ambiguous: primary.ambiguous,
        candidates: candidates.length > 1 ? candidates : undefined,
      }),
    };
  } catch (err) {
    console.error(`[check-part] Erro interno inesperado para "${trimmedPn}":`, err.stack || err.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message || "Erro interno" }) };
  }
};
