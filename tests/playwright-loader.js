// O Playwright é opcional: os testes de backend rodam sem nenhuma dependência.
// Este loader procura o pacote onde ele costuma estar (local ou global) e
// avisa de forma clara quando não encontra, em vez de estourar um require.
const { execSync } = require("child_process");

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

module.exports = { load, available: () => tryLoad() !== null };
