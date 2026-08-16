// O Playwright é opcional: os testes de backend rodam sem nenhuma dependência.
// Este loader procura o pacote onde ele costuma estar (local ou global) e
// avisa de forma clara quando não encontra, em vez de estourar um require.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Em ambientes com Chromium pré-instalado fora do cache padrão do Playwright
// (comum em sandboxes/CI que proíbem download de browser no `npm install`),
// o pacote local pode ficar sem nenhum binário compatível — ver
// PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD. Acha o chrome pré-instalado e devolve o
// executablePath pronto pra passar em chromium.launch({ ...launchOptions() }).
// Sem achar nada, devolve {} e deixa o Playwright resolver do jeito normal.
function launchOptions() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const roots = [base, "/opt/pw-browsers"].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try { entries = fs.readdirSync(root); } catch (e) { continue; }
    const dir = entries.find((d) => /^chromium-\d+$/.test(d));
    if (!dir) continue;
    const exe = path.join(root, dir, "chrome-linux", "chrome");
    if (fs.existsSync(exe)) return { executablePath: exe };
  }
  return {};
}

function candidates() {
  const list = ["playwright", "@playwright/test"];
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (globalRoot) list.push(`${globalRoot}/playwright`, `${globalRoot}/@playwright/test`);
  } catch (e) {
    /* npm indisponível: segue só com a resolução normal */
  }
  return list;
}

function tryLoad() {
  for (const mod of candidates()) {
    try {
      return require(mod);
    } catch (e) {
      /* tenta o próximo */
    }
  }
  return null;
}

function load() {
  const pw = tryLoad();
  if (!pw) {
    console.log("  (pulado) Playwright não encontrado — instale com: npm i -D playwright && npx playwright install chromium");
    process.exit(0);
  }
  return pw;
}

module.exports = { load, available: () => tryLoad() !== null, launchOptions };
