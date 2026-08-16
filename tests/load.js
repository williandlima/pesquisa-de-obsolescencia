// Carrega a função check-part.js num contexto isolado e expõe os internos
// (que não são exportados na produção) para teste.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = path.resolve(__dirname, "../functions/api/check-part.js");
const EXPORT_LINE = "export async function onRequest(context) {";

function loadFunction({ fetchImpl } = {}) {
  const raw = fs.readFileSync(SRC, "utf8");
  if (!raw.includes(EXPORT_LINE)) {
    // A assinatura do arquivo de produção mudou — melhor falhar alto aqui do
    // que o vm.Script estourar um SyntaxError obscuro por causa do `export`
    // (só válido em módulo ES, não em script comum) mais abaixo.
    throw new Error(
      `load.js espera encontrar "${EXPORT_LINE}" em check-part.js — a assinatura mudou? Atualize load.js.`
    );
  }
  // O runtime do Cloudflare Pages Functions exige `export` (ESM). vm.Script
  // roda como script comum, não módulo — troca por uma declaração normal e
  // expõe via __internals, sem duplicar a função em lugar nenhum.
  const code =
    raw.replace(EXPORT_LINE, "async function onRequest(context) {") +
    "\n;__internals = { normalizeStatus, combine, manufacturerMatches, manufacturersEqual, pickManufacturerCandidates, groupByManufacturer, buildCandidate, compareCandidates, queryMouser, queryFarnell, queryTrustedParts, queryDigiKey, onRequest };";

  const sandbox = {
    fetch: fetchImpl || (async () => { throw new Error("fetch não stubado"); }),
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    Response,
    URLSearchParams,
    JSON,
    Promise,
    Object,
    Array,
    Number,
    String,
    Date,
    Error,
    encodeURIComponent,
    __internals: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__internals;
}

module.exports = { loadFunction };
