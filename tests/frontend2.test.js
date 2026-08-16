const { load, launchOptions } = require("./playwright-loader");
const { chromium } = load();
const { start } = require("./server");

const PORT = 8792;
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         esperado: ${e}\n         obtido:   ${a}`); }
}
function info(m) { console.log(`  info  ${m}`); }

(async () => {
  const server = await start(PORT);
  const browser = await chromium.launch(launchOptions());
  const page = await (await browser.newContext()).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));

  await page.goto(`http://127.0.0.1:${PORT}/`);

  console.log("\n== A. Dependência de CDN (SheetJS) ==");
  const xlsxLoaded = await page.evaluate(() => typeof window.XLSX !== "undefined");
  info(`XLSX carregou do cdnjs? ${xlsxLoaded}`);
  if (!xlsxLoaded) {
    // Simula exatamente o que um usuário atrás de firewall corporativo vê:
    await page.evaluate(() => localStorage.setItem("obsolescence-log", JSON.stringify([
      { pn: "LM317T", status: "obsolete", confidence: "high", sub: "", sourceName: "Mouser", sourceUrl: "http://x", verifiedDate: "01/01/2026", notes: "" },
    ])));
    await page.reload();
    await page.waitForTimeout(200);
    errs.length = 0;
    const dialogs = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
    await page.click("#exportBtn");
    await page.waitForTimeout(600);
    info(`erro lançado: ${errs.join(" | ") || "(nenhum)"}`);
    info(`aviso mostrado ao usuário: ${dialogs.length ? dialogs.join(" | ") : "(NENHUM — botão morre em silêncio)"}`);
    check("usuário é avisado quando o export falha", dialogs.length > 0, true);
  }

  console.log("\n== B. Lógica de export (com SheetJS injetado localmente) ==");
  // Injeta um XLSX falso para exercitar a lógica de montagem das linhas.
  await page.evaluate(() => {
    window.__captured = null;
    window.XLSX = {
      utils: {
        json_to_sheet: (rows) => { window.__captured = rows; return {}; },
        book_new: () => ({}),
        book_append_sheet: () => {},
      },
      writeFile: () => {},
    };
  });
  await page.evaluate(() => localStorage.setItem("obsolescence-log", JSON.stringify([
    { pn: "LM317T", status: "obsolete", confidence: "high", sub: "LM317AT", sourceName: "Mouser",
      sourceUrl: "http://x", sourceReachable: true, verifiedDate: "01/01/2024", notes: "verificado há muito tempo" },
    { pn: "STM32F103C8T6", status: "active", confidence: "high", sub: "", sourceName: "DigiKey",
      sourceUrl: "http://y", sourceReachable: true, verifiedDate: new Date().toLocaleDateString("pt-BR"), notes: "hoje" },
  ])));
  await page.click("#exportBtn");
  await page.waitForTimeout(400);
  const rows = await page.evaluate(() => window.__captured);
  info(`colunas exportadas: ${rows ? Object.keys(rows[0]).join(" | ") : "(nada)"}`);
  check("exporta as 2 linhas", rows ? rows.length : 0, 2);
  const cols = rows ? Object.keys(rows[0]) : [];
  check("tem coluna de idade/dias desde verificação",
    cols.some((c) => /dias|idade|desatualiz/i.test(c)), true);
  if (rows) info(`registro de 01/01/2024 (>2 anos) exportado sem nenhum alerta de staleness`);

  console.log("\n== C. CSV: PN na primeira coluna entre aspas ==");
  const csvQuoted = 'Part Number,Desc\n"LM317T","REG, LDO"\n"STM32F103C8T6","MCU, ARM"\n';
  await page.setInputFiles("#batchFile", { name: "b.csv", mimeType: "text/csv", buffer: Buffer.from(csvQuoted) });
  await page.waitForTimeout(400);
  const imported = await page.inputValue("#batchList");
  info(`importado: ${JSON.stringify(imported)}`);
  check("aspas removidas do PN", imported.split("\n").filter(Boolean), ["LM317T", "STM32F103C8T6"]);

  console.log("\n== D. CSV com separador ';' (padrão Excel pt-BR) ==");
  const csvSemi = "Part Number;Qtd\nLM317T;5\nSTM32F103C8T6;2\n";
  await page.setInputFiles("#batchFile", { name: "b2.csv", mimeType: "text/csv", buffer: Buffer.from(csvSemi) });
  await page.waitForTimeout(400);
  const imported2 = await page.inputValue("#batchList");
  info(`importado: ${JSON.stringify(imported2)}`);
  check("lida com ';' (Excel brasileiro)", imported2.split("\n").filter(Boolean), ["LM317T", "STM32F103C8T6"]);

  console.log("\n== E. Coluna de fabricante do CSV é aproveitada? ==");
  const csvMfr = "Part Number,Fabricante\nLM317T,Texas Instruments\nSTM32F103C8T6,STMicroelectronics\n";
  await page.setInputFiles("#batchFile", { name: "b3.csv", mimeType: "text/csv", buffer: Buffer.from(csvMfr) });
  await page.waitForTimeout(400);
  const impMfr = await page.inputValue("#batchList");
  info(`textarea após import: ${JSON.stringify(impMfr)}`);
  check("coluna 'Fabricante' é levada para o batch", impMfr.split("\n").filter(Boolean),
    ["LM317T, Texas Instruments", "STM32F103C8T6, STMicroelectronics"]);

  console.log("\n== F. Cancelamento do batch ==");
  const hasCancel = await page.evaluate(() => !!document.getElementById("cancelBatchBtn"));
  check("existe botão de cancelar batch", hasCancel, true);

  await page.fill("#batchList", Array.from({ length: 12 }, (_, i) => `PN-${i}`).join("\n"));
  await page.click("#runBatchBtn");
  await page.waitForTimeout(900);
  check("botão Cancelar aparece durante a execução", await page.isVisible("#cancelBatchBtn"), true);
  await page.click("#cancelBatchBtn");
  await page.waitForFunction(() => /Cancelado/.test(document.getElementById("progressLabel").textContent), { timeout: 15000 });
  const label = await page.textContent("#progressLabel");
  info(`rótulo final: ${label.trim()}`);
  check("batch para antes dos 12", /Cancelado: \d+ de 12/.test(label), true);
  check("botão Processar volta a ficar ativo", await page.isEnabled("#runBatchBtn"), true);

  console.log("\n== G. Alerta de dado velho (>90 dias) ==");
  await page.evaluate(() => localStorage.setItem("obsolescence-log", JSON.stringify([
    { pn: "VELHO", mfr: "TI", status: "active", confidence: "high", sub: "", sourceName: "Mouser",
      sourceUrl: "http://x", verifiedDate: "01/01/2024", notes: "" },
    { pn: "NOVO", mfr: "TI", status: "active", confidence: "high", sub: "", sourceName: "Mouser",
      sourceUrl: "http://x", verifiedDate: new Date().toLocaleDateString("pt-BR"), notes: "" },
  ])));
  await page.reload();
  await page.waitForTimeout(300);
  const linhas = await page.locator("#logBody tr").allTextContents();
  info(`linha antiga: ${linhas[0].replace(/\s+/g, " ").trim()}`);
  check("registro antigo recebe alerta visual", /⚠\s*\d+d/.test(linhas[0]), true);
  check("registro de hoje não recebe alerta", /⚠\s*\d+d/.test(linhas[1]), false);

  console.log("\n== H. Backup completo (.json): exporta e restaura ==");
  const [backupDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    page.click("text=Baixar backup completo"),
  ]);
  check("nome do arquivo de backup", /^backup_obsolescencia_.*\.json$/.test(backupDownload.suggestedFilename()), true);
  const backupPath = require("path").join(__dirname, "out_" + backupDownload.suggestedFilename());
  await backupDownload.saveAs(backupPath);
  const backupJson = JSON.parse(require("fs").readFileSync(backupPath, "utf8"));
  info(`backup contém ${backupJson.entries.length} registro(s), versão ${backupJson.version}`);
  check("backup guarda os 2 registros do log", backupJson.entries.length, 2);
  check("backup preserva o PN cru (sem formatação de exibição)",
    backupJson.entries.map((e) => e.pn).sort(), ["NOVO", "VELHO"]);

  console.log("\n== I. Restaurar backup depois de limpar o navegador ==");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(200);
  check("log vazio após limpar localStorage", await page.locator("#logBody .empty-row").count(), 1);

  await page.setInputFiles("#backupFile", { name: "backup.json", mimeType: "application/json", buffer: require("fs").readFileSync(backupPath) });
  await page.waitForTimeout(300);
  check("os 2 registros voltam após restaurar", await page.locator("#logBody tr").count(), 2);
  check("status do backupStatus confirma a restauração",
    /2 registro\(s\) restaurado/.test(await page.textContent("#backupStatus")), true);

  console.log("\n== J. Restaurar backup NÃO duplica (dedupa por PN+fabricante) ==");
  await page.setInputFiles("#backupFile", { name: "backup.json", mimeType: "application/json", buffer: require("fs").readFileSync(backupPath) });
  await page.waitForTimeout(300);
  check("restaurar o mesmo backup 2x não duplica linhas", await page.locator("#logBody tr").count(), 2);

  console.log("\n== K. Backup com JSON inválido é rejeitado com mensagem clara ==");
  await page.setInputFiles("#backupFile", { name: "lixo.json", mimeType: "application/json", buffer: Buffer.from("{ isso não é json") });
  await page.waitForTimeout(200);
  info(`mensagem: ${await page.textContent("#backupStatus")}`);
  check("avisa que o arquivo é inválido", /não é um JSON legível/.test(await page.textContent("#backupStatus")), true);
  check("log permanece intacto (não apagou nada)", await page.locator("#logBody tr").count(), 2);

  console.log(`\n----- frontend (parte 2): ${pass} ok, ${fail} falhas -----`);
  await browser.close(); server.close(); process.exit(0);
})().catch((e) => { console.error("ERRO:", e); process.exit(1); });
