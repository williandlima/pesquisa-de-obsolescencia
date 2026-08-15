#!/usr/bin/env node
// Runner da suíte. Uso: node tests/run.js [backend|frontend]
//
// Os testes de backend não exigem nenhuma dependência. Os de frontend sobem a
// página real num Chromium (Playwright) contra um backend falso e são pulados
// automaticamente se o Playwright não estiver instalado.
const { spawnSync } = require("child_process");
const path = require("path");

const SUITES = {
  backend: ["backend.test.js", "handler.test.js"],
  frontend: ["frontend.test.js", "frontend2.test.js"],
};

const which = (process.argv[2] || "all").toLowerCase();
const files =
  which === "all"
    ? [...SUITES.backend, ...SUITES.frontend]
    : SUITES[which] || (console.error(`suíte desconhecida: ${which}`), process.exit(2));

let totalPass = 0, totalFail = 0, hadError = false;

for (const file of files) {
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  process.stdout.write(res.stdout || "");

  const m = /-----[^-]*?(\d+) ok, (\d+) falhas/.exec(res.stdout || "");
  if (m) {
    totalPass += Number(m[1]);
    totalFail += Number(m[2]);
  } else if (res.status !== 0) {
    hadError = true;
    console.error(`\n!! ${file} terminou com código ${res.status}`);
  }
}

console.log("\n========================================");
console.log(`TOTAL: ${totalPass} ok, ${totalFail} falhas`);
console.log("========================================");
process.exit(totalFail > 0 || hadError ? 1 : 0);
