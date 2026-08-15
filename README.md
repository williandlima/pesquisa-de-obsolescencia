# Rastreador de Obsolescência de Componentes

[![Testes](https://github.com/williandlima/pesquisa-de-obsolescencia/actions/workflows/test.yml/badge.svg)](https://github.com/williandlima/pesquisa-de-obsolescencia/actions/workflows/test.yml)

App web para verificar o status de lifecycle (Active / NRND / Obsolete) de componentes
eletrônicos, cruzando **múltiplas fontes de distribuidor autorizado**, com verificação
individual e em lista, log auditável e exportação de relatório em Excel.

## Arquitetura

- **Frontend** (`public/index.html`): página estática, sem build step. Não contém nenhuma credencial.
- **Backend** (`netlify/functions/check-part.js`): função serverless que consulta as fontes
  em paralelo e cruza os resultados. As credenciais ficam em variáveis de ambiente no
  Netlify, invisíveis ao usuário final.
- **Testes** (`tests/`): suíte em Node puro, sem dependências. Ver [tests/README.md](tests/README.md).

O usuário final **não precisa de nenhuma chave** — só abrir o link e usar.

## Fontes de dados

Todas são opcionais, mas **pelo menos uma** precisa estar configurada. Se só a Mouser
estiver, o app funciona — as demais apenas deixam de contribuir, e o motivo aparece
nas notas do resultado entre colchetes.

| Fonte | Variáveis de ambiente | Observação |
|---|---|---|
| Mouser | `MOUSER_API_KEY` | Funcionando, testada ao vivo. |
| Farnell / element14 (Newark) | `FARNELL_API_KEY` | Funcionando. `storeInfo.id` precisa ser `www.newark.com`. |
| Digi-Key | `DIGIKEY_CLIENT_ID` + `DIGIKEY_CLIENT_SECRET` | OAuth2 `client_credentials` (2-legged), que é o fluxo documentado para a Product Information V4. Ainda não testada ao vivo. |
| TrustedParts (ECIA) | `TRUSTEDPARTS_API_KEY` + `TRUSTEDPARTS_COMPANY_ID` | A API exige **Company ID e API Key no corpo** de toda requisição (PascalCase), não em header `Authorization`. Requer cadastro com e-mail corporativo. Ainda não testada ao vivo. |

## Como funciona a verificação

- O navegador chama `/api/check-part` (redirecionado para a função) com `{ pn, mfr }`.
- A função consulta as quatro fontes **em paralelo**, cada uma com orçamento de tempo
  próprio (a função da Netlify é morta em ~10s, então uma fonte pendurada não pode
  travar as outras).
- Cada fonte normaliza o rótulo do distribuidor para `active` / `nrnd` / `obsolete` / `unknown`.
- **Sem fabricante informado, cada fonte pode devolver mais de um fabricante** para o
  mesmo PN (o mesmo part number existe em vários fabricantes, com lifecycles distintos
  — ex.: LM317T da TI, da onsemi, da ST). O backend agrupa os resultados das 4 fontes
  por fabricante ANTES de votar, então cada fabricante recebe a confiança que realmente
  merece, em vez de o app escolher um arbitrariamente ou diluir a confiança de todos.
- **Confiança**, calculada por grupo de fabricante: 2+ fontes conclusivas concordando
  sobre o mesmo fabricante → `alta`; fonte única → `média`; nenhuma conclusiva → `baixa`.
- **Divergência** entre fontes conclusivas sobre o mesmo fabricante força `não
  conclusivo` — o app não escolhe arbitrariamente entre respostas contraditórias.
- Quando há mais de um fabricante candidato, a resposta traz um array `candidates`
  (um por fabricante, já ordenado por confiança) além dos campos de nível raiz, que
  refletem sempre o candidato de maior confiança. O frontend mostra os demais como
  chips clicáveis, sem precisar de nova chamada à API.

## Regras de confiabilidade (não remover sem motivo)

1. **Nunca inventar status sem fonte confirmada** — sem dado conclusivo, o status é
   `não conclusivo`, nunca um palpite.
2. **Casamento PN + fabricante** — quando o fabricante é informado, todas as fontes
   filtram por ele (filtro "soft": se nada bater, mostra os candidatos encontrados em
   vez de falhar silenciosamente).
3. **Degradação graciosa** — qualquer fonte pode falhar sem quebrar o fluxo.
4. **URL da fonte é obrigatória no log manual** — registro sem link auditável não é aceito.
5. **Dado de lifecycle envelhece** — registros com mais de 90 dias
   (`STALE_THRESHOLD_DAYS`) são marcados no log e no relatório exportado.

## Deploy no Netlify

Como o projeto tem função serverless, deploy por arrastar pasta não ativa a função.

### Via Git (recomendado)

1. Suba o repositório para o GitHub.
2. No Netlify: **Add new site → Import an existing project → GitHub**.
3. As configurações de build são lidas do `netlify.toml`.
4. Em **Site settings → Environment variables**, adicione as chaves das fontes que for usar
   (ver tabela acima).
5. Refaça o deploy (**Trigger deploy**) para a função enxergar as variáveis.

### Via CLI

```bash
npm install -g netlify-cli
netlify login
netlify env:set MOUSER_API_KEY "sua_chave"
netlify env:list          # confirme que gravou antes de seguir
netlify deploy --prod
```

## Testes

```bash
npm test               # tudo
npm run test:backend   # só backend — zero dependências
npm run test:frontend  # só frontend — precisa de `npm install` antes (Playwright)
```

Os testes de backend não exigem nada instalado. Os de frontend precisam do Playwright
(`npm install` traz como devDependency) e são pulados automaticamente se ele não estiver
disponível. Todo push e PR roda a suíte inteira via GitHub Actions
(`.github/workflows/test.yml`).

## Segurança

- Credenciais nunca vão ao navegador — ficam só nas variáveis de ambiente do Netlify.
- O log fica no `localStorage` do navegador de cada usuário (não há banco central,
  então também não há como recuperar o log se o navegador for trocado ou o
  armazenamento local for limpo — exporte para Excel com frequência).
- Apenas URLs `http`/`https` viram links clicáveis no log.
- `Access-Control-Allow-Origin` da função é travado no domínio do app — outros sites
  não conseguem usar o navegador de um visitante para chamar `/api/check-part` e
  consumir a cota das APIs pagas. Isso não impede chamada direta via curl/script
  (CORS é imposto pelo navegador, não pelo servidor); não há rate limiting real hoje.
- Erros inesperados de cada fonte e do handler vão para os logs da função no Netlify
  (`console.error`), prefixados com `[check-part]`, para diagnóstico sem precisar
  reproduzir o problema localmente.
