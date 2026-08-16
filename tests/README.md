# Testes

```bash
npm test                     # tudo (equivalente a node tests/run.js)
node tests/run.js backend    # só backend (nenhuma dependência)
node tests/run.js frontend   # só frontend (precisa de Playwright — `npm install` traz)
```

Sem framework de teste: o projeto não tem build step, e os testes seguem a mesma
regra. Cada arquivo imprime `ok` / `FAIL` por asserção e uma linha de total que o
`run.js` agrega. O `package.json` existe só para declarar o Playwright como
devDependency e dar scripts padrão — CI roda via `.github/workflows/test.yml`.

## O que cada arquivo cobre

| Arquivo | Cobre |
|---|---|
| `backend.test.js` | `normalizeStatus` contra os rótulos reais de Mouser, Digi-Key, TI, ST e Microchip; `manufacturerMatches` (filtro) vs. `manufacturersEqual` (agrupamento); `pickManufacturerCandidates`, `compareCandidates` e votação/confiança do `combine`. |
| `handler.test.js` | O handler inteiro com `fetch` mockado: concordância, divergência, filtro por fabricante, fabricantes diferentes viram candidatos separados, degradação graciosa, respostas HTML de erro, orçamento de tempo e fonte pendurada. |
| `frontend.test.js` | A página real num Chromium contra um backend falso: verificação individual, envio do fabricante, log, persistência, batch, deduplicação, importação de CSV, exportação e sanitização de XSS. |
| `frontend2.test.js` | Casos de borda: CSV com aspas, CSV com `;` (Excel pt-BR), coluna de fabricante, fallback do export sem CDN, cancelamento do batch, alerta de dado velho, e backup/restauração completa do log em JSON (export, restore após limpar o navegador, dedup ao restaurar 2x, rejeição de arquivo inválido). |
| `frontend3.test.js` | PN com vários fabricantes: chips de candidato, troca sem nova chamada à API, "Usar no log" gravando o candidato selecionado (não sempre o primário), e ausência de chips quando só há 1 fabricante. |

## Como o backend é carregado

`load.js` lê `netlify/functions/check-part.js` e o executa num contexto isolado
(`vm`), injetando `process.env` e um `fetch` falso, e expondo as funções internas
que a produção não exporta. Assim os testes exercitam o arquivo de produção sem
que ele precise de código de teste dentro dele.

## Como o frontend é servido

`server.js` sobe um HTTP local que serve `public/` e responde `/api/check-part`
com fixtures, registrando cada requisição recebida — é isso que permite afirmar
o que o frontend realmente envia ao backend (e não só o que a tela mostra).

## Notas

- Os testes de frontend rodam offline. O SheetJS vem de CDN e normalmente **não**
  carrega nesse ambiente — o que é proposital: exercita o caminho de fallback para
  CSV, o mesmo que um usuário atrás de firewall corporativo enfrenta.
- Nenhum teste chama API de distribuidor de verdade. Para validar chave nova,
  teste contra o ambiente do Netlify.
