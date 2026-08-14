const { chromium } = require("./playwright-loader").load();
const { start, requests } = require("./server");

const PORT = 8791;
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         esperado: ${e}\n         obtido:   ${a}`); }
}
function info(m) { console.log(`  info  ${m}`); }

(async () => {
  const server = await start(PORT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push("console: " + m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/`);

  console.log("\n== 1. Verificação individual ==");
  requests.length = 0;
  await page.fill("#pn", "LM317T");
  await page.fill("#mfr", "Texas Instruments");
  await page.click("#autoCheckBtn");
  await page.waitForFunction(() => document.querySelector("#autoResult .auto-result") !== null, { timeout: 20000 });

  const statusTxt = await page.textContent("#statusText");
  info(`statusText: ${statusTxt.trim()}`);
  check("LED vermelho para obsolete", (await page.getAttribute("#statusLed", "class")).includes("red"), true);
  check("tag de status renderizada", (await page.textContent("#autoResult .tag")).trim(), "Obsolete");

  // A prova do bug do fabricante:
  info(`payload enviado ao backend: ${JSON.stringify(requests[0].body)}`);
  check("campo 'mfr' preenchido pelo usuário chega ao backend", requests[0].body.mfr, "Texas Instruments");

  console.log("\n== 2. 'Usar no log' + gravação ==");
  await page.click("#autoResult .use-btn");
  check("status copiado p/ formulário", await page.inputValue("#logStatus"), "obsolete");
  check("substituto copiado", await page.inputValue("#logSub"), "LM317AT");
  check("URL da fonte copiada", (await page.inputValue("#logSourceUrl")).includes("/fake/mouser"), true);
  await page.click("text=Adicionar ao log");
  await page.waitForTimeout(200);
  check("linha gravada no log", await page.locator("#logBody tr").count(), 1);

  console.log("\n== 3. Regra: URL obrigatória no log manual ==");
  await page.fill("#logPn", "TESTE1");
  await page.selectOption("#logStatus", "active");
  await page.fill("#logSourceUrl", "");
  await page.click("text=Adicionar ao log");
  await page.waitForTimeout(150);
  check("bloqueia registro sem URL", await page.isVisible("#formError"), true);
  info(`erro exibido: "${(await page.textContent("#formError")).trim()}"`);
  check("não gravou a linha", await page.locator("#logBody tr").count(), 1);

  console.log("\n== 4. Persistência entre sessões (localStorage) ==");
  await page.reload();
  await page.waitForTimeout(300);
  check("log sobrevive ao reload", await page.locator("#logBody tr").count(), 1);
  check("PN preservado", (await page.textContent("#logBody tr .pn")).trim().startsWith("LM317T"), true);

  console.log("\n== 5. Busca em lista (batch) ==");
  requests.length = 0;
  await page.fill("#batchList", "LM317T\nSTM32F103C8T6\nINA226AIDGSR\nPN-INEXISTENTE");
  const t0 = Date.now();
  await page.click("text=Processar lista");
  await page.waitForFunction(() => /Concluído/.test(document.querySelector("#progressLabel").textContent), { timeout: 60000 });
  const batchMs = Date.now() - t0;
  check("4 linhas de resultado", await page.locator("#batchResultsBody tr").count(), 4);
  info(`batch de 4 PNs levou ${batchMs}ms`);

  // Intervalo real entre chamadas ao backend (documentado como 350ms):
  const gaps = requests.slice(1).map((r, i) => r.at - requests[i].at);
  info(`intervalos entre chamadas: ${gaps.join("ms, ")}ms`);
  const minGap = Math.min(...gaps);
  check("existe delay >=350ms entre chamadas (anti rate-limit)", minGap >= 350, true);

  // O batch manda o fabricante?
  info(`payload do batch: ${JSON.stringify(requests[0].body)}`);

  check("log consolidado: 4 PNs distintos (LM317T re-verificado substitui o manual)", await page.locator("#logBody tr").count(), 4);

  console.log("\n== 6. Deduplicação de PN no log ==");
  const pnsNoLog = await page.locator("#logBody tr .pn").allTextContents();
  const lm317 = pnsNoLog.filter((p) => p.trim().startsWith("LM317T")).length;
  info(`PNs no log: ${pnsNoLog.map((s) => s.trim()).join(", ")}`);
  check("LM317T verificado 2x aparece 1x (histórico consolidado)", lm317, 1);

  console.log("\n== 7. Importação de CSV realista (BOM com vírgulas) ==");
  const csv = 'Part Number,Descrição,Qtd\nLM317T,"REG LDO, 1.2-37V, TO-220",5\nSTM32F103C8T6,"MCU ARM, 64KB",2\n';
  await page.setInputFiles("#batchFile", { name: "bom.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.waitForTimeout(400);
  const importado = await page.inputValue("#batchList");
  info(`PNs importados: ${JSON.stringify(importado)}`);
  check("importa só os 2 PNs, sem lixo das colunas", importado.split("\n").filter(Boolean), ["LM317T", "STM32F103C8T6"]);

  console.log("\n== 8. Exportação (com fallback quando o CDN é bloqueado) ==");
  const dialogs8 = [];
  page.on("dialog", (d) => { dialogs8.push(d.message()); d.accept(); });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }).catch(() => null),
    page.click("#exportBtn"),
  ]);
  const semCdn = await page.evaluate(() => typeof window.XLSX === "undefined");
  info(`SheetJS disponível? ${!semCdn}`);
  check("gera um arquivo mesmo sem o CDN", download ? /\.(xlsx|csv)$/.test(download.suggestedFilename()) : false, true);
  if (semCdn) {
    check("usuário é avisado do fallback", dialogs8.some((d) => /SheetJS|planilhas/i.test(d)), true);
  }
  if (download) {
    const fs = require("fs");
    const p = require("path").join(__dirname, "out_" + download.suggestedFilename());
    await download.saveAs(p);
    if (p.endsWith(".csv")) {
      const txt = fs.readFileSync(p, "utf8");
      const header = txt.split("\r\n")[0];
      info(`cabeçalho exportado: ${header}`);
      check("export traz coluna de dias desde a verificação", /Dias desde a verifica/.test(header), true);
      check("export traz coluna de revalidação", /Revalidar/.test(header), true);
      check("export traz coluna de fabricante", /Fabricante/.test(header), true);
    }
  }

  console.log("\n== 9. XSS / sanitização ==");
  await page.evaluate(() => localStorage.setItem("obsolescence-log", JSON.stringify([{
    pn: '<img src=x onerror="window.__xss=1">', status: "active", confidence: "high",
    sub: "", sourceName: "teste", sourceUrl: 'javascript:window.__xss2=1', verifiedDate: "01/01/2026", notes: "<script>window.__xss3=1<\/script>",
  }])));
  await page.reload();
  await page.waitForTimeout(300);
  check("HTML no PN não executa", await page.evaluate(() => window.__xss === undefined), true);
  check("script nas notas não executa", await page.evaluate(() => window.__xss3 === undefined), true);
  const href = await page.getAttribute("#logBody tr a.src-link", "href").catch(() => null);
  info(`href renderizado para fonte 'javascript:': ${JSON.stringify(href)}`);
  check("URL 'javascript:' não vira link clicável", href === null || !String(href).startsWith("javascript:"), true);

  console.log("\n== 10. Erros de página ==");
  info(pageErrors.length ? pageErrors.join(" | ") : "nenhum erro de console/página");
  check("sem erros de JS não tratados", pageErrors.filter((e) => !/Failed to load resource/.test(e)).length, 0);

  console.log(`\n----- frontend: ${pass} ok, ${fail} falhas -----`);
  await browser.close();
  server.close();
  process.exit(0);
})().catch((e) => { console.error("ERRO NO TESTE:", e); process.exit(1); });
