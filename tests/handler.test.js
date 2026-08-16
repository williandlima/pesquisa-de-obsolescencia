const { loadFunction } = require("./load");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         esperado: ${e}\n         obtido:   ${a}`); }
}
function info(msg) { console.log(`  info  ${msg}`); }

function jsonRes(body, status = 200) {
  return {
    status,
    ok: status < 400,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const mouserBody = (parts) => ({ SearchResults: { Parts: parts, Errors: [] } });
const dkBody = (products) => ({ Products: products });

function makeFetch(routes, log = []) {
  return async (url, opts) => {
    log.push({ url: String(url), body: opts && opts.body });
    for (const [frag, handler] of routes) {
      if (String(url).includes(frag)) return handler(url, opts);
    }
    throw new Error(`rota não stubada: ${url}`);
  };
}

// Constrói um Request real (Fetch API nativa do Node) e chama onRequest com
// a mesma forma de EventContext que o Cloudflare Pages Functions usa em
// produção — { request, env } — em vez do event/context estilo Netlify.
async function callRaw({ env = {}, method = "POST", rawBody, fetchImpl }) {
  const { onRequest } = loadFunction({
    fetchImpl: fetchImpl || (async () => { throw new Error("fetch não stubado"); }),
  });
  const request = new Request("http://localhost/api/check-part", {
    method,
    body: rawBody === undefined ? undefined : rawBody,
  });
  const res = await onRequest({ request, env });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { res, parsed, text };
}

async function invoke({ env, routes, body }) {
  const log = [];
  const { res, parsed } = await callRaw({
    env,
    method: "POST",
    rawBody: JSON.stringify(body),
    fetchImpl: makeFetch(routes, log),
  });
  return { res, parsed, log };
}

(async () => {
  console.log("\n== handler: caminho feliz ==");
  {
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k" },
      routes: [["api.mouser.com", () => jsonRes(mouserBody([
        { ManufacturerPartNumber: "LM317T", Manufacturer: "Texas Instruments", LifecycleStatus: "Active", ProductDetailUrl: "https://mouser.com/lm317t" },
      ]))]],
      body: { pn: "LM317T" },
    });
    check("fonte única => active/medium", [parsed.status, parsed.confidence], ["active", "medium"]);
    check("fabricante propagado", parsed.manufacturer, "Texas Instruments");
  }

  console.log("\n== handler: duas fontes concordando ==");
  {
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k", DIGIKEY_CLIENT_ID: "id", DIGIKEY_CLIENT_SECRET: "sec" },
      routes: [
        ["api.mouser.com", () => jsonRes(mouserBody([
          { ManufacturerPartNumber: "LM317T", Manufacturer: "Texas Instruments", LifecycleStatus: "Obsolete", ProductDetailUrl: "https://mouser.com/x" }]))],
        ["oauth2/token", () => jsonRes({ access_token: "t", expires_in: 600 })],
        ["digikey.com/products", () => jsonRes(dkBody([
          { ManufacturerProductNumber: "LM317T", Manufacturer: { Name: "Texas Instruments" }, ProductStatus: { Status: "Obsolete" }, ProductUrl: "https://dk.com/x" }]))],
      ],
      body: { pn: "LM317T" },
    });
    check("2 fontes concordam => obsolete/high", [parsed.status, parsed.confidence], ["obsolete", "high"]);
  }

  console.log("\n== handler: divergência real ==");
  {
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k", DIGIKEY_CLIENT_ID: "id", DIGIKEY_CLIENT_SECRET: "sec" },
      routes: [
        ["api.mouser.com", () => jsonRes(mouserBody([
          { ManufacturerPartNumber: "X", Manufacturer: "TI", LifecycleStatus: "Active" }]))],
        ["oauth2/token", () => jsonRes({ access_token: "t", expires_in: 600 })],
        ["digikey.com/products", () => jsonRes(dkBody([
          { ManufacturerProductNumber: "X", Manufacturer: { Name: "TI" }, ProductStatus: { Status: "Obsolete" } }]))],
      ],
      body: { pn: "X" },
    });
    check("divergência => unknown + ambiguous", [parsed.status, parsed.ambiguous], ["unknown", true]);
  }

  console.log("\n== handler: filtro por fabricante (regra de confiabilidade #2) ==");
  {
    // Mouser devolve DOIS fabricantes para o mesmo PN, com status opostos.
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k" },
      routes: [["api.mouser.com", () => jsonRes(mouserBody([
        { ManufacturerPartNumber: "LM317T", Manufacturer: "onsemi", LifecycleStatus: "Obsolete", ProductDetailUrl: "https://m/on" },
        { ManufacturerPartNumber: "LM317T", Manufacturer: "Texas Instruments", LifecycleStatus: "Active", ProductDetailUrl: "https://m/ti" },
      ]))]],
      body: { pn: "LM317T", mfr: "Texas Instruments" },
    });
    check("mfr='Texas Instruments' seleciona o TI (active)", parsed.status, "active");
    check("mfr correto no resultado", parsed.manufacturer, "Texas Instruments");
  }
  {
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k" },
      routes: [["api.mouser.com", () => jsonRes(mouserBody([
        { ManufacturerPartNumber: "LM317T", Manufacturer: "onsemi", LifecycleStatus: "Obsolete", ProductDetailUrl: "https://m/on" },
        { ManufacturerPartNumber: "LM317T", Manufacturer: "Texas Instruments", LifecycleStatus: "Active", ProductDetailUrl: "https://m/ti" },
      ]))]],
      body: { pn: "LM317T", mfr: "onsemi" },
    });
    check("mfr='onsemi' seleciona o onsemi (obsolete)", parsed.status, "obsolete");
  }

  console.log("\n== handler: fabricantes diferentes sem filtro viram candidatos separados ==");
  {
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k", DIGIKEY_CLIENT_ID: "id", DIGIKEY_CLIENT_SECRET: "sec" },
      routes: [
        ["api.mouser.com", () => jsonRes(mouserBody([
          { ManufacturerPartNumber: "LM317T", Manufacturer: "Texas Instruments", LifecycleStatus: "Active" }]))],
        ["oauth2/token", () => jsonRes({ access_token: "t", expires_in: 600 })],
        ["digikey.com/products", () => jsonRes(dkBody([
          { ManufacturerProductNumber: "LM317T", Manufacturer: { Name: "onsemi" }, ProductStatus: { Status: "Active" } }]))],
      ],
      body: { pn: "LM317T" },
    });
    info(`Mouser=TI/active + DigiKey=onsemi/active => status=${parsed.status} conf=${parsed.confidence}`);
    info(`candidates: ${JSON.stringify((parsed.candidates || []).map((c) => [c.manufacturer, c.status, c.confidence]))}`);
    // Cada fabricante só tem 1 fonte falando dele — nenhum vira confiança alta
    // por coincidência de status entre fabricantes diferentes.
    check("confiança do primário é 'medium' (fonte única dentro do grupo)", parsed.confidence, "medium");
    check("aparecem 2 candidatos (TI e onsemi), não 1 escolhido arbitrariamente",
      (parsed.candidates || []).length, 2);
    check("TI vem primeiro (Mouser é consultado antes da DigiKey)", parsed.manufacturer, "Texas Instruments");
    check("onsemi não é descartado — aparece como 2º candidato",
      parsed.candidates.some((c) => c.manufacturer === "onsemi"), true);
    check("nota principal avisa sobre o outro fabricante",
      /também é feito por: onsemi/.test(parsed.notes), true);
  }

  console.log("\n== handler: degradação graciosa ==");
  {
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k", FARNELL_API_KEY: "f" },
      routes: [
        ["api.mouser.com", () => jsonRes(mouserBody([
          { ManufacturerPartNumber: "X", Manufacturer: "TI", LifecycleStatus: "Active" }]))],
        ["element14", () => { throw new Error("ECONNRESET"); }],
      ],
      body: { pn: "X" },
    });
    check("Farnell caindo não derruba Mouser", parsed.status, "active");
    check("motivo da falha aparece nas notas", /Farnell:.*ECONNRESET/.test(parsed.notes), true);
  }

  console.log("\n== handler: nenhuma fonte configurada ==");
  {
    const { res, parsed } = await callRaw({
      env: {},
      method: "POST",
      rawBody: JSON.stringify({ pn: "X" }),
      fetchImpl: async () => jsonRes({}),
    });
    check("500 com mensagem clara", [res.status, parsed.error], [500, "Nenhuma fonte configurada no servidor."]);
  }

  console.log("\n== handler: robustez de entrada ==");
  {
    const stubEnv = { MOUSER_API_KEY: "k" };
    const stubFetch = async () => jsonRes({});
    check("OPTIONS => 204", (await callRaw({ env: stubEnv, method: "OPTIONS", fetchImpl: stubFetch })).res.status, 204);
    check("GET => 405", (await callRaw({ env: stubEnv, method: "GET", fetchImpl: stubFetch })).res.status, 405);
    check("body inválido => 400",
      (await callRaw({ env: stubEnv, method: "POST", rawBody: "{{{", fetchImpl: stubFetch })).res.status, 400);
    check("pn vazio => 400",
      (await callRaw({ env: stubEnv, method: "POST", rawBody: '{"pn":"  "}', fetchImpl: stubFetch })).res.status, 400);
  }

  console.log("\n== handler: resposta não-JSON (HTML de erro) ==");
  {
    const htmlRes = {
      status: 500, ok: false,
      headers: { get: () => "text/html" },
      json: async () => { throw new Error("Unexpected token < in JSON"); },
      text: async () => "<html><body>500 Internal Server Error</body></html>",
    };
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k", FARNELL_API_KEY: "f" },
      routes: [["api.mouser.com", () => htmlRes], ["element14", () => htmlRes]],
      body: { pn: "X" },
    });
    info(`notas: ${parsed.notes}`);
    check("Farnell explica HTTP 500 legivelmente", /Farnell: (erro: )?resposta não-JSON \(HTTP 500\)/.test(parsed.notes), true);
    check("Mouser também deveria explicar HTTP 500 legivelmente", /Mouser: (erro: )?resposta não-JSON \(HTTP 500\)/.test(parsed.notes), true);
  }

  console.log("\n== handler: fonte lenta porém funcional (regressão Farnell) ==");
  {
    // A element14/Farnell passa dos 3s com frequência. Um teto curto descartaria
    // uma fonte que teria respondido — é o que aconteceu em produção.
    const slowButOk = () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve(jsonRes({
            manufacturerPartNumberSearchReturn: {
              products: [{ translatedManufacturerPartNumber: "LM317T", vendorName: "onsemi", releaseStatusCode: 7 }],
            },
          })),
          5000
        )
      );
    const { parsed } = await invoke({
      env: { FARNELL_API_KEY: "f" },
      routes: [["element14", slowButOk]],
      body: { pn: "LM317T" },
    });
    info(`Farnell respondendo em 5s => status=${parsed.status}`);
    check("fonte que leva 5s ainda é aproveitada", parsed.status, "obsolete");
  }

  console.log("\n== handler: erro de token da Digi-Key é explicado ==");
  {
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k", DIGIKEY_CLIENT_ID: "id", DIGIKEY_CLIENT_SECRET: "errado" },
      routes: [
        ["api.mouser.com", () => jsonRes(mouserBody([
          { ManufacturerPartNumber: "LM317T", Manufacturer: "onsemi", LifecycleStatus: "Obsolete" }]))],
        ["oauth2/token", () => jsonRes({ error: "invalid_client", error_description: "Client credentials are invalid" }, 401)],
      ],
      body: { pn: "LM317T" },
    });
    info(`notas: ${parsed.notes.slice(parsed.notes.indexOf("DigiKey"))}`);
    check("motivo real do erro aparece nas notas",
      /DigiKey: token HTTP 401.*invalid_client.*Client credentials are invalid/.test(parsed.notes), true);
  }

  console.log("\n== handler: variável de ambiente faltando é nomeada ==");
  {
    // Só o secret ausente: a mensagem precisa apontar ELE, não os dois.
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k", DIGIKEY_CLIENT_ID: "id" },
      routes: [["api.mouser.com", () => jsonRes(mouserBody([
        { ManufacturerPartNumber: "X", Manufacturer: "TI", LifecycleStatus: "Active" }]))]],
      body: { pn: "X" },
    });
    info(`notas: ${parsed.notes.slice(parsed.notes.indexOf("DigiKey"))}`);
    check("aponta só o DIGIKEY_CLIENT_SECRET",
      /DigiKey: falta a variável de ambiente DIGIKEY_CLIENT_SECRET no Cloudflare Pages/.test(parsed.notes), true);
    check("não cita o CLIENT_ID, que está presente",
      /DIGIKEY_CLIENT_ID/.test(parsed.notes), false);
  }
  {
    // Nenhum dos dois: aí sim a fonte nem é consultada.
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k" },
      routes: [["api.mouser.com", () => jsonRes(mouserBody([
        { ManufacturerPartNumber: "X", Manufacturer: "TI", LifecycleStatus: "Active" }]))]],
      body: { pn: "X" },
    });
    check("sem CLIENT_ID a fonte aparece como não configurada",
      /DigiKey: não configurada/.test(parsed.notes), true);
  }

  console.log("\n== handler: substituto vem identificado pela fonte ==");
  {
    // O SuggestedReplacement da Mouser é o código de estoque dela (863-...),
    // não um MPN — o resultado precisa dizer de onde veio para não virar BOM.
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k" },
      routes: [["api.mouser.com", () => jsonRes(mouserBody([
        { ManufacturerPartNumber: "LM317T", Manufacturer: "onsemi", LifecycleStatus: "Obsolete",
          SuggestedReplacement: "863-LM317TG" }]))]],
      body: { pn: "LM317T" },
    });
    check("substituto preservado cru", parsed.substitute, "863-LM317TG");
    check("fonte do substituto identificada", parsed.substituteSource, "Mouser");
  }
  {
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k" },
      routes: [["api.mouser.com", () => jsonRes(mouserBody([
        { ManufacturerPartNumber: "X", Manufacturer: "TI", LifecycleStatus: "Active" }]))]],
      body: { pn: "X" },
    });
    check("sem substituto, sem fonte de substituto", [parsed.substitute, parsed.substituteSource], ["", ""]);
  }

  console.log("\n== handler: lead time zerado não é anunciado ==");
  {
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k" },
      routes: [["api.mouser.com", () => jsonRes(mouserBody([
        { ManufacturerPartNumber: "LM317T", Manufacturer: "onsemi", LifecycleStatus: "Obsolete", LeadTime: "0 Dias" }]))]],
      body: { pn: "LM317T" },
    });
    info(`notas: ${parsed.notes}`);
    check("'Lead time: 0 Dias' é omitido", /Lead time/.test(parsed.notes), false);
  }
  {
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k" },
      routes: [["api.mouser.com", () => jsonRes(mouserBody([
        { ManufacturerPartNumber: "X", Manufacturer: "TI", LifecycleStatus: "Active", LeadTime: "84 Dias" }]))]],
      body: { pn: "X" },
    });
    check("lead time real continua aparecendo", /Lead time: 84 Dias/.test(parsed.notes), true);
  }

  console.log("\n== handler: latência / timeout (orçamento de UX, sem teto de plataforma) ==");
  {
    const slow = () => new Promise((r) => setTimeout(() => r(jsonRes(mouserBody([]))), 3000));
    const t0 = Date.now();
    const { parsed } = await invoke({
      env: { MOUSER_API_KEY: "k" },
      routes: [["api.mouser.com", slow]],
      body: { pn: "X" },
    });
    const elapsed = Date.now() - t0;
    info(`fonte lenta (3s/req): handler levou ${elapsed}ms, status=${parsed.status}`);
    check("handler não fica preso indefinidamente numa fonte lenta", elapsed < 10000, true);
  }

  console.log("\n== handler: fonte pendurada (sem resposta) ==");
  {
    // Como o fetch real, respeita o AbortSignal — se a função não abortar, pendura.
    const hang = (_url, opts) =>
      new Promise((_resolve, reject) => {
        if (opts && opts.signal) {
          opts.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }
      });
    const t0 = Date.now();
    const done = invoke({
      env: { MOUSER_API_KEY: "k", FARNELL_API_KEY: "f" },
      routes: [
        ["api.mouser.com", () => jsonRes(mouserBody([{ ManufacturerPartNumber: "X", Manufacturer: "TI", LifecycleStatus: "Active" }]))],
        ["element14", hang],
      ],
      body: { pn: "X" },
    });
    // O contrato é caber no orçamento (SOURCE_DEADLINE_MS) com folga, não ser
    // instantâneo: o teto é generoso de propósito para não descartar fonte
    // lenta que funciona — não existe mais um teto de plataforma a respeitar.
    const LIMITE_MS = 9000;
    const race = await Promise.race([done, new Promise((r) => setTimeout(() => r("TIMEOUT"), LIMITE_MS))]);
    if (race === "TIMEOUT") {
      fail++;
      console.log(`  FAIL fonte pendurada levou o handler além de ${LIMITE_MS}ms`);
    } else {
      pass++;
      console.log(`  ok   fonte pendurada abortada e as outras entregaram (${Date.now() - t0}ms)`);
    }
  }

  console.log(`\n----- handler: ${pass} ok, ${fail} falhas -----`);
  process.exit(0);
})();
