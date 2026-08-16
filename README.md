# Rastreador de Obsolescência de Componentes

[![Testes](https://github.com/williandlima/pesquisa-de-obsolescencia/actions/workflows/test.yml/badge.svg)](https://github.com/williandlima/pesquisa-de-obsolescencia/actions/workflows/test.yml)

App web para verificar o status de lifecycle (Active / NRND / Obsolete) de componentes
eletrônicos, cruzando **múltiplas fontes de distribuidor autorizado**, com verificação
individual e em lista, log auditável e exportação de relatório em Excel.

## Arquitetura

- **Frontend** (`public/index.html`): página estática, sem build step. Não contém nenhuma credencial.
- **Backend** (`functions/api/check-part.js`): Cloudflare Pages Function que consulta as
  fontes em paralelo e cruza os resultados. Roteamento por diretório — o arquivo em
  `functions/api/check-part.js` fica disponível automaticamente em `/api/check-part`,
  sem redirect explícito. As credenciais ficam em variáveis de ambiente/secrets do
  Cloudflare Pages, invisíveis ao usuário final.
- **Testes** (`tests/`): suíte em Node puro, quase sem dependências (só o Playwright
  para os testes de frontend). Ver [tests/README.md](tests/README.md).

O usuário final **não precisa de nenhuma chave** — só abrir o link e usar.

> Migrado da Netlify em 2026. O `wrangler.toml` e o `.dev.vars.example` na raiz são
> específicos do Cloudflare Pages; não há mais `netlify.toml` nem pasta `netlify/`.

## Fontes de dados

Todas são opcionais, mas **pelo menos uma** precisa estar configurada. Se só a Mouser
estiver, o app funciona — as demais apenas deixam de contribuir, e o motivo aparece
nas notas do resultado entre colchetes.

| Fonte | Variáveis de ambiente | Observação |
|---|---|---|
| Mouser | `MOUSER_API_KEY` | Funcionando, testada ao vivo (na Netlify; revalidar após a migração). |
| Farnell / element14 (Newark) | `FARNELL_API_KEY` | Funcionando. `storeInfo.id` precisa ser `www.newark.com`. |
| Digi-Key | `DIGIKEY_CLIENT_ID` + `DIGIKEY_CLIENT_SECRET` | OAuth2 `client_credentials` (2-legged), que é o fluxo documentado para a Product Information V4. Ainda não testada ao vivo. |
| TrustedParts (ECIA) | `TRUSTEDPARTS_API_KEY` + `TRUSTEDPARTS_COMPANY_ID` | A API exige **Company ID e API Key no corpo** de toda requisição (PascalCase), não em header `Authorization`. Requer cadastro com e-mail corporativo. Ainda não testada ao vivo. |
| Octopart / Nexar | `NEXAR_CLIENT_ID` + `NEXAR_CLIENT_SECRET` | Agregador multi-distribuidor via GraphQL, cadastro self-service em [portal.nexar.com](https://portal.nexar.com) (tem free tier). Pesa menos no cálculo de confiança porque já agrega dados de fontes que consultamos direto (Mouser, Digi-Key). Transporte (OAuth2 + endpoint) confirmado em doc pública; nomes exatos de campo do schema GraphQL ainda não testados ao vivo. |
| Arrow Electronics | `ARROW_LOGIN` + `ARROW_API_KEY` | Distribuidor autorizado. Chave via [developers.arrow.com](https://developers.arrow.com/api/) ("Request API Key"), self-service. Endpoint confirmado; nome do campo de status na resposta ainda não confirmado ao vivo — o código tenta os candidatos mais prováveis e cai num debug com o corpo cru se nada bater. |
| Avnet | `AVNET_CLIENT_ID` + `AVNET_CLIENT_SECRET` + `AVNET_SUBSCRIPTION_KEY` | Distribuidor autorizado. Cadastro em [apiportal.avnet.com](https://apiportal.avnet.com/) exige aprovação manual do lado da Avnet (não é instantâneo). Endpoint de busca e schema **não confirmados** (docs atrás de login) — implementação best-effort, precisa de ajuste no 1º teste ao vivo. |

**Pendente** — RS Components/Electrocomponents não tem portal de developer self-service público conhecido; o acesso parece exigir contato comercial direto (gerente de conta). Não foi implementada por falta de documentação confiável; entra como 8ª fonte assim que houver credenciais e doc reais.

Mais uma, opcional, específica desta plataforma:

| Variável | Observação |
|---|---|
| `ALLOWED_ORIGIN` | Domínio liberado no CORS da função (ver seção Segurança). Sem ela, usa o default hardcoded em `functions/api/check-part.js` — **atualize depois do 1º deploy**, quando souber a URL final (`*.pages.dev` ou domínio próprio). |

## Como funciona a verificação

- O navegador chama `/api/check-part` com `{ pn, mfr }`.
- A função consulta as sete fontes **em paralelo**, cada uma com orçamento de tempo
  próprio — não é para caber num teto de plataforma (Workers HTTP não têm limite de
  wall-clock), é escolha de UX: uma fonte pendurada não pode travar as outras nem
  segurar quem está esperando o resultado por tempo demais.
- Cada fonte normaliza o rótulo do distribuidor para `active` / `nrnd` / `obsolete` / `unknown`.
- **Sem fabricante informado, cada fonte pode devolver mais de um fabricante** para o
  mesmo PN (o mesmo part number existe em vários fabricantes, com lifecycles distintos
  — ex.: LM317T da TI, da onsemi, da ST). O backend agrupa os resultados de todas as
  fontes por fabricante ANTES de votar, então cada fabricante recebe a confiança que
  realmente merece, em vez de o app escolher um arbitrariamente ou diluir a confiança
  de todos.
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

## Deploy no Cloudflare Pages

Sem build step: o site é `public/` + a função em `functions/api/`. Roteamento por
diretório é automático, não precisa configurar redirect.

### Via Git (recomendado)

1. Suba o repositório para o GitHub.
2. No dashboard do Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**,
   selecione o repositório.
3. Configuração de build: **framework preset "None"**, build command **vazio**,
   build output directory **`public`** (já reflete o `pages_build_output_dir` do
   `wrangler.toml`, mas o dashboard não lê esse arquivo automaticamente na primeira
   configuração — confira/ajuste manualmente).
4. Em **Settings → Variables and Secrets**, adicione as chaves das fontes que for usar
   (ver tabela acima) como **Secret**, não como variável de texto — secrets não podem
   ser lidos de volta depois de criados, o que é o comportamento certo para chave de API.
5. Refaça o deploy (**Retry deployment** ou um novo push) para a função enxergar as variáveis.
6. Depois do 1º deploy, pegue a URL real (`<projeto>.pages.dev` ou domínio próprio) e
   defina `ALLOWED_ORIGIN` com ela — o CORS da função só libera esse domínio.

### Via CLI (wrangler)

```bash
npm install -g wrangler
wrangler login
wrangler pages deploy public --project-name=rastreador-obsolescencia
wrangler pages secret put MOUSER_API_KEY --project-name=rastreador-obsolescencia
# repita para as demais chaves e para ALLOWED_ORIGIN
```

### Dev local

```bash
cp .dev.vars.example .dev.vars     # preencha com suas chaves de teste
wrangler pages dev public
```

`.dev.vars` nunca é commitado (está no `.gitignore`).

## Testes

```bash
npm test               # tudo
npm run test:backend   # só backend — zero dependências
npm run test:frontend  # só frontend — precisa de `npm install` antes (Playwright)
```

Os testes de backend não exigem nada instalado — chamam `onRequest` diretamente com um
`Request` real (Fetch API nativa do Node), sem precisar do `wrangler` nem de rede. Os de
frontend precisam do Playwright (`npm install` traz como devDependency) e são pulados
automaticamente se ele não estiver disponível. Todo push e PR roda a suíte inteira via
GitHub Actions (`.github/workflows/test.yml`).

## Segurança

- Credenciais nunca vão ao navegador — ficam só em Secrets do Cloudflare Pages.
- O log fica no `localStorage` do navegador de cada usuário — não há banco central,
  não sincroniza entre pessoas ou dispositivos. Use "Baixar backup completo (.json)"
  no painel do log com frequência; "Restaurar backup" recria o log a partir desse
  arquivo (dedupa por PN + fabricante, então restaurar 2x não duplica linha). O
  relatório em Excel/CSV é só leitura humana — não serve para restaurar o log.
- Apenas URLs `http`/`https` viram links clicáveis no log.
- `Access-Control-Allow-Origin` da função é travado num domínio (`ALLOWED_ORIGIN`, com
  fallback hardcoded) — outros sites não conseguem usar o navegador de um visitante para
  chamar `/api/check-part` e consumir a cota das APIs pagas. Isso não impede chamada
  direta via curl/script (CORS é imposto pelo navegador, não pelo servidor); não há
  rate limiting real hoje.
- Erros inesperados de cada fonte e do handler vão para o `console.error`, prefixados
  com `[check-part]` — no Cloudflare, visíveis via `wrangler pages deployment tail` ou
  na aba **Logs** do projeto no dashboard.
