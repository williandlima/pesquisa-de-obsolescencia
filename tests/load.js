// Carrega a função check-part.js num contexto isolado e expõe os internos
// (que não são exportados na produção) para teste.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = path.resolve(__dirname, "../netlify/functions/check-part.js");

function loadFunction({ env = {}, fetchImpl } = {}) {
  const code = fs.readFileSync(SRC, "utf8") +
    "\n;__internals = { normalizeStatus, combine, manufacturerMatches, manufacturersEqual, pickManufacturerCandidates, groupByManufacturer, buildCandidate, compareCandidates, queryMouser, queryFarnell, queryTrustedParts, queryDigiKey, handler: exports.handler };";

  const sandbox = {
    process: { env: { ...env } },
    fetch: fetchImpl || (async () => { throw new Error("fetch não stubado"); }),
    console,
    setTimeout,
    clearTimeout,
    AbortController,
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
    exports: {},
    module: {},
    __internals: null,
  };
  sandbox.module.exports = sandbox.exports;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__internals;
}

module.exports = { loadFunction };
