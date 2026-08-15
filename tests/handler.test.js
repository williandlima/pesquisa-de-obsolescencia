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

async function invoke({ env, routes, body }) {
  const log = [];
  const { handler } = loadFunction({ env, fetchImpl: makeFetch(routes, log) });
  const res = await handler({ httpMethod: "POST", body: JSON.stringify(body) });
  return { res, parsed: JSON.parse(res.body), log };
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

  console.log("\n== handler: fabricantes cruzados sem filtro (risco) ==");
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
    info(`  manufacturer reportado: "${parsed.manufacturer}" (mas 2 fabricantes distintos responderam)`);
    check("confiança NÃO deveria ser 'high' com fabricantes distintos", parsed.confidence, "medium");
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
    const { handler } = loadFunction({ env: {}, fetchImpl: async () => jsonRes({}) });
    const res = await handler({ httpMethod: "POST", body: JSON.stringify({ pn: "X" }) });
    check("500 com mensagem clara", [res.statusCode, JSON.parse(res.body).error], [500, "Nenhuma fonte configurada no servidor."]);
  }

  console.log("\n== handler: robustez de entrada ==");
  {
    const { handler } = loadFunction({ env: { MOUSER_API_KEY: "k" }, fetchImpl: async () => jsonRes({}) });
    check("OPTIONS => 204", (await handler({ httpMethod: "OPTIONS" })).statusCode, 204);
    check("GET => 405", (await handler({ httpMethod: "GET" })).statusCode, 405);
    check("body inválido => 400", (await handler({ httpMethod: "POST", body: "{{{" })).statusCode, 400);
    check("pn vazio => 400", (await handler({ httpMethod: "POST", body: '{"pn":"  "}' })).statusCode, 400);
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

  console.log("\n== handler: latência / timeout (limite de 10s da Netlify) ==");
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
    check("handler deveria abortar antes de 10s (limite Netlify)", elapsed < 10000, true);
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
    // O contrato é caber nos 10s da Netlify com folga, não ser instantâneo: o
    // teto é generoso de propósito para não descartar fonte lenta que funciona.
    const LIMITE_MS = 9000;
    const race = await Promise.race([done, new Promise((r) => setTimeout(() => r("TIMEOUT"), LIMITE_MS))]);
    if (race === "TIMEOUT") {
      fail++;
      console.log(`  FAIL fonte pendurada levou o handler além de ${LIMITE_MS}ms (a Netlify mata em 10s)`);
    } else {
      pass++;
      console.log(`  ok   fonte pendurada abortada e as outras entregaram (${Date.now() - t0}ms)`);
    }
  }

  console.log(`\n----- handler: ${pass} ok, ${fail} falhas -----`);
  process.exit(0);
})();
