// Servidor de teste: serve public/ e finge ser a função /api/check-part.
// Registra tudo que o frontend envia, para provarmos o que chega (ou não chega) no backend.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PUBLIC = require("path").resolve(__dirname, "../public");
const requests = [];

const FIXTURES = {
  LM317T: { status: "obsolete", confidence: "high", substitute: "LM317AT", substituteSource: "Mouser", manufacturer: "Texas Instruments",
    notes: "Confirmado por 2 fontes independentes: Mouser: Obsolete; DigiKey: Discontinued at Digi-Key.",
    sources: [{ name: "Mouser", url: "http://127.0.0.1:{PORT}/fake/mouser" }] },
  STM32F103C8T6: { status: "active", confidence: "high", substitute: "", manufacturer: "STMicroelectronics",
    notes: "Confirmado por 2 fontes independentes: DigiKey: Active; Mouser: Active.", sources: [{ name: "DigiKey", url: "http://127.0.0.1:{PORT}/fake/dk" }] },
  INA226AIDGSR: { status: "nrnd", confidence: "medium", substitute: "INA228", manufacturer: "Texas Instruments",
    notes: "Confirmado por apenas 1 fonte (Mouser: NRND) — recomendável checar manualmente antes de decidir.", sources: [] },
  DESCONHECIDO: { status: "unknown", confidence: "low", substitute: "", manufacturer: "",
    notes: "Componente não encontrado nas bases consultadas.", sources: [] },
  // PN feito por 3 fabricantes diferentes — exercita a UI de candidatos.
  MULTIMFR001: {
    status: "active", confidence: "high", substitute: "", substituteSource: "",
    manufacturer: "Texas Instruments",
    notes: "Confirmado por 2 fontes independentes: Mouser: Active; DigiKey: Active. Este PN também é feito por: onsemi (obsolete), STMicroelectronics (active) — informe o fabricante para focar em um só.",
    sources: [{ name: "Mouser", url: "http://127.0.0.1:{PORT}/fake/mouser-ti" }],
    candidates: [
      { manufacturer: "Texas Instruments", status: "active", confidence: "high", substitute: "", substituteSource: "",
        notes: "Confirmado por 2 fontes independentes: Mouser: Active; DigiKey: Active.",
        sources: [{ name: "Mouser", url: "http://127.0.0.1:{PORT}/fake/mouser-ti" }], agreeing: 2, sourceCount: 2 },
      { manufacturer: "onsemi", status: "obsolete", confidence: "medium", substitute: "863-LM317TG", substituteSource: "Mouser",
        notes: "Confirmado por apenas 1 fonte (Mouser: Obsolete) — recomendável checar manualmente antes de decidir.",
        sources: [{ name: "Mouser", url: "http://127.0.0.1:{PORT}/fake/mouser-onsemi" }], agreeing: 1, sourceCount: 1 },
      { manufacturer: "STMicroelectronics", status: "active", confidence: "medium", substitute: "", substituteSource: "",
        notes: "Confirmado por apenas 1 fonte (Farnell/element14: Active) — recomendável checar manualmente antes de decidir.",
        sources: [{ name: "Farnell/element14", url: "http://127.0.0.1:{PORT}/fake/farnell-st" }], agreeing: 1, sourceCount: 1 },
    ],
  },
};

function start(port) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/check-part" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        requests.push({ at: Date.now(), body: parsed });
        const key = (parsed.pn || "").toUpperCase();
        const fx = FIXTURES[key] || FIXTURES.DESCONHECIDO;
        const out = JSON.parse(JSON.stringify(fx).replace(/\{PORT\}/g, String(port)));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (req.url.startsWith("/fake/")) { res.writeHead(200, { "Content-Type": "text/html" }); res.end("ok"); return; }

    const file = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) { res.writeHead(404); res.end("nf"); return; }
    const ext = path.extname(full);
    const type = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : "text/plain";
    res.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
    res.end(fs.readFileSync(full));
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

module.exports = { start, requests };
