// Servidor de teste: serve public/ e finge ser a Netlify Function /api/check-part.
// Registra tudo que o frontend envia, para provarmos o que chega (ou não chega) no backend.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PUBLIC = require("path").resolve(__dirname, "../public");
const requests = [];

const FIXTURES = {
  LM317T: { status: "obsolete", confidence: "high", substitute: "LM317AT", manufacturer: "Texas Instruments",
    notes: 'Lifecycle: "obsolete" — Texas Instruments — 2 fontes independentes concordam.',
    sources: [{ name: "Mouser", url: "http://127.0.0.1:{PORT}/fake/mouser" }] },
  STM32F103C8T6: { status: "active", confidence: "high", substitute: "", manufacturer: "STMicroelectronics",
    notes: 'Lifecycle: "active" — STMicroelectronics.', sources: [{ name: "DigiKey", url: "http://127.0.0.1:{PORT}/fake/dk" }] },
  INA226AIDGSR: { status: "nrnd", confidence: "medium", substitute: "INA228", manufacturer: "Texas Instruments",
    notes: 'Lifecycle: "nrnd" — fonte única.', sources: [] },
  DESCONHECIDO: { status: "unknown", confidence: "low", substitute: "", manufacturer: "",
    notes: "Componente não encontrado nas bases consultadas.", sources: [] },
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
