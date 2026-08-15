const { chromium } = require("./playwright-loader").load();
const { start, requests } = require("./server");

const PORT = 8793;
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
  const page = await (await browser.newContext()).newPage();

  await page.goto(`http://127.0.0.1:${PORT}/`);

  console.log("\n== Vários fabricantes para o mesmo PN ==");
  requests.length = 0;
  await page.fill("#pn", "MULTIMFR001");
  await page.click("#autoCheckBtn");
  await page.waitForFunction(() => document.querySelector("#autoResult .auto-result") !== null, { timeout: 20000 });

  check("resultado principal é o de maior confiança (TI)",
    (await page.textContent("#autoResult .aline")).includes("Texas Instruments"), true);
  check("aparecem 3 chips de fabricante", await page.locator(".mfr-chip").count(), 3);
  const chipLabels = (await page.locator(".mfr-chip").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim());
  info(`chips: ${JSON.stringify(chipLabels)}`);
  check("chip da TI vem marcado como ativo", await page.locator(".mfr-chip.active").textContent(), await page.locator(".mfr-chip").first().textContent());

  console.log("\n== Trocar para o candidato onsemi (sem nova chamada ao backend) ==");
  const chamadasAntes = requests.length;
  await page.click(".mfr-chip:has-text('onsemi')");
  await page.waitForTimeout(150);
  check("não faz nova chamada à API ao trocar de candidato", requests.length, chamadasAntes);
  check("status muda para obsolete (onsemi)",
    (await page.textContent("#autoResult .tag")).trim(), "Obsolete");
  check("LED fica vermelho", (await page.getAttribute("#statusLed", "class")).includes("red"), true);
  check("substituto do onsemi aparece rotulado",
    (await page.textContent("#autoResult")).includes("863-LM317TG (Mouser PN)"), true);
  check("chip onsemi passa a ser o ativo",
    await page.locator(".mfr-chip.active").textContent().then((t) => t.includes("onsemi")), true);

  console.log("\n== 'Usar no log' registra o candidato SELECIONADO, não o primário ==");
  await page.click("#autoResult .use-btn");
  check("status do formulário é o do onsemi (obsolete)", await page.inputValue("#logStatus"), "obsolete");
  check("campo Fabricante é preenchido com onsemi", await page.inputValue("#mfr"), "onsemi");
  await page.click("text=Adicionar ao log");
  await page.waitForTimeout(200);
  const logCell = (await page.locator("#logBody tr").first().locator("td").first().textContent()).replace(/\s+/g, " ").trim();
  info(`linha gravada no log: ${JSON.stringify(logCell)}`);
  check("log grava o PN com o fabricante onsemi (não TI)", logCell.includes("onsemi"), true);

  console.log("\n== Voltar para a TI e confirmar que os detalhes trocam de volta ==");
  await page.click(".mfr-chip:has-text('Texas Instruments')");
  await page.waitForTimeout(150);
  check("status volta a ser active (TI)", (await page.textContent("#autoResult .tag")).trim(), "Active");

  console.log("\n== PN de fabricante único não mostra chips (sem regressão) ==");
  await page.fill("#pn", "LM317T");
  await page.click("#autoCheckBtn");
  await page.waitForFunction(() => document.querySelector("#autoResult .auto-result") !== null, { timeout: 20000 });
  check("nenhum chip aparece quando só há 1 fabricante", await page.locator(".mfr-chip").count(), 0);

  console.log(`\n----- frontend (candidatos de fabricante): ${pass} ok, ${fail} falhas -----`);
  await browser.close(); server.close(); process.exit(0);
})().catch((e) => { console.error("ERRO:", e); process.exit(1); });
