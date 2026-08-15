# Rastreador de Obsolescência de Componentes

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
- **Confiança**: 2+ fontes conclusivas concordando → `alta`; fonte única → `média`;
  nenhuma conclusiva → `baixa`.
- **Divergência** entre fontes conclusivas força `não conclusivo` — o app não escolhe
  arbitrariamente entre respostas contraditórias.
- **Fabricantes diferentes não se corroboram**: se duas fontes dizem "active" mas para
  fabricantes distintos, a confiança cai para `média` e o resultado avisa. O mesmo PN
  existe em vários fabricantes com lifecycles diferentes (LM317T da TI, onsemi, ST).

## Regras de confiabilidade (não remover sem motivo)

1. **Nunca inventar status sem fonte confirmada** — sem dado conclusivo, o status é
   `não conclusivo`, nunca um palpite.
2. **Casamento PN + fabricante** — quando o fabricante é informado, todas as fontes
   filtram por ele.
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
node tests/run.js
```

Não precisa instalar nada para os testes de backend. Os testes de frontend precisam do
Playwright e são pulados automaticamente se ele não estiver disponível.

## Segurança

- Credenciais nunca vão ao navegador — ficam só nas variáveis de ambiente do Netlify.
- O log fica no `localStorage` do navegador de cada usuário (não há banco central).
- Apenas URLs `http`/`https` viram links clicáveis no log.
