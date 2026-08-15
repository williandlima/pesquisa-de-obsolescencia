const { loadFunction } = require("./load");

let pass = 0, fail = 0;
const fails = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL ${name}\n         esperado: ${e}\n         obtido:   ${a}`); }
}

// ---------------------------------------------------------------
console.log("\n== normalizeStatus: rótulos reais dos distribuidores ==");
const { normalizeStatus, combine, manufacturerMatches } = loadFunction();

// Mouser LifecycleStatus reais
check("Mouser 'Active'", normalizeStatus("Active"), "active");
check("Mouser 'New Product'", normalizeStatus("New Product"), "active");
check("Mouser 'Obsolete'", normalizeStatus("Obsolete"), "obsolete");
check("Mouser 'EOL'", normalizeStatus("EOL"), "obsolete");
check("Mouser 'NRND'", normalizeStatus("NRND"), "nrnd");

// DigiKey ProductStatus reais (v4)
check("DK 'Active'", normalizeStatus("Active"), "active");
check("DK 'Not For New Designs'", normalizeStatus("Not For New Designs"), "nrnd");
check("DK 'Last Time Buy'", normalizeStatus("Last Time Buy"), "obsolete");
check("DK 'Obsolete'", normalizeStatus("Obsolete"), "obsolete");
check("DK 'Discontinued at Digi-Key'", normalizeStatus("Discontinued at Digi-Key"), "obsolete");
check("DK 'Preliminary'", normalizeStatus("Preliminary"), "unknown");

// Fabricantes
check("TI 'ACTIVE'", normalizeStatus("ACTIVE"), "active");
check("TI 'NRND'", normalizeStatus("NRND"), "nrnd");
check("ST 'Not Recommended for New Designs'", normalizeStatus("Not Recommended for New Designs"), "nrnd");
check("ST 'Proposal'", normalizeStatus("Proposal"), "unknown");
check("Microchip 'In Production'", normalizeStatus("In Production"), "active");
check("'Inactive'", normalizeStatus("Inactive"), "obsolete");

// Casos-armadilha
check("'Not Recommended' NÃO vira active por conter 'new'", normalizeStatus("Not Recommended for New Designs"), "nrnd");
check("vazio", normalizeStatus(""), "unknown");
check("null", normalizeStatus(null), "unknown");
check("'Active' com espaço", normalizeStatus("  Active  "), "active");

// ---------------------------------------------------------------
console.log("\n== manufacturerMatches ==");
check("sem filtro passa tudo", manufacturerMatches("onsemi", ""), true);
check("exato", manufacturerMatches("Texas Instruments", "Texas Instruments"), true);
check("parcial (usuário digita curto)", manufacturerMatches("Texas Instruments", "TI"), false);
check("substring", manufacturerMatches("STMicroelectronics", "STMicro"), true);
check("case-insensitive", manufacturerMatches("onsemi", "ONSEMI"), true);
check("fabricante errado é rejeitado", manufacturerMatches("onsemi", "Texas Instruments"), false);

// ---------------------------------------------------------------
console.log("\n== combine: votação e confiança ==");
check("fonte única conclusiva => medium",
  combine([{ source: "Mouser", status: "active" }]).confidence, "medium");
check("2 fontes concordam => high",
  combine([{ source: "Mouser", status: "active" }, { source: "DigiKey", status: "active" }]).confidence, "high");
check("2 fontes divergem => unknown",
  combine([{ source: "Mouser", status: "active" }, { source: "DigiKey", status: "obsolete" }]).status, "unknown");
check("nenhuma conclusiva => unknown/low",
  combine([{ source: "Mouser", status: "unknown" }]).confidence, "low");
check("estoque autorizado sem status => low + nota",
  combine([{ source: "TrustedParts", status: "unknown", authorizedStock: true }]).confidence, "low");

// PROBLEMA A INVESTIGAR: 2 fontes concordam mas são de FABRICANTES DIFERENTES
const crossMfr = combine([
  { source: "Mouser", status: "active", manufacturer: "Texas Instruments" },
  { source: "DigiKey", status: "active", manufacturer: "onsemi" },
]);
check("2 fabricantes DIFERENTES não deveriam dar confiança alta",
  crossMfr.confidence, "medium");

// PROBLEMA: maioria 2x1 é tratada como divergência total
const majority = combine([
  { source: "Mouser", status: "obsolete" },
  { source: "DigiKey", status: "obsolete" },
  { source: "Farnell/element14", status: "active" },
]);
console.log(`  info  maioria 2x1 (2 obsolete, 1 active) => status="${majority.status}" conf="${majority.confidence}"`);

console.log(`\n----- normalize/combine: ${pass} ok, ${fail} falhas -----`);
module.exports = { pass, fail, fails };
