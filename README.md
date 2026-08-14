# Rastreador de Obsolescência de Componentes

App web para verificar o status de lifecycle (Active / NRND / Obsolete) de componentes eletrônicos, com dados oficiais da base **Octopart/Nexar**, verificação individual e em lista, log auditável e exportação de relatório em Excel.

## Arquitetura

- **Frontend** (`public/index.html`): página estática. Não contém nenhuma credencial.
- **Backend** (`netlify/functions/check-part.js`): função serverless que consulta a API Nexar. As credenciais ficam em variáveis de ambiente no Netlify, invisíveis ao usuário final.

O usuário final **não precisa de nenhuma chave** — só abrir o link e usar.

## Pré-requisitos: credenciais Nexar (gratuito)

1. Crie uma conta em https://portal.nexar.com
2. Crie uma aplicação (**Create app**) com escopo de **Supply**.
3. Copie o **Client ID** e o **Client Secret** (o secret aparece só uma vez).
4. O plano gratuito cobre até 1000 componentes verificados por mês.

## Deploy no Netlify

### Opção A — via interface (drag & drop não serve aqui, pois há função serverless)

Como este projeto tem uma função serverless, o deploy por arrastar pasta não ativa a função. Use o método Git ou CLI:

### Opção B — via Git (recomendado)

1. Suba esta pasta para um repositório no GitHub.
2. No Netlify: **Add new site → Import an existing project → GitHub** e selecione o repositório.
3. As configurações de build são lidas automaticamente do `netlify.toml`.
4. Antes do primeiro deploy terminar, vá em **Site settings → Environment variables** e adicione:
   - `NEXAR_CLIENT_ID` = seu Client ID
   - `NEXAR_CLIENT_SECRET` = seu Client Secret
5. Refaça o deploy (**Trigger deploy**) para que a função leia as variáveis.

### Opção C — via CLI

```bash
npm install -g netlify-cli
netlify login
netlify deploy --prod
# depois, configure as variáveis:
netlify env:set NEXAR_CLIENT_ID "seu_client_id"
netlify env:set NEXAR_CLIENT_SECRET "seu_client_secret"
netlify deploy --prod
```

## Como funciona a verificação

- O navegador chama `/api/check-part` (redirecionado para a função).
- A função pega um token OAuth2 na Nexar, consulta `supSearchMpn`, e extrai o campo
  `manufacturerlifecyclestatus` (valor bruto do fabricante) ou `lifecyclestatus` (homogeneizado).
- Confiança: **alta** se veio direto do fabricante, **média** se homogeneizado, **baixa/não conclusivo** se ausente.
- Sem dado de lifecycle na base → status "não conclusivo", exigindo verificação manual.

## Segurança

- Credenciais nunca vão ao navegador — ficam só nas variáveis de ambiente do Netlify.
- O log e o histórico ficam no `localStorage` do navegador de cada usuário (não há banco de dados central).
