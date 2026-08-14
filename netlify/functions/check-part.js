// Netlify Function: check-part
// Recebe { pn, mfr } e consulta o status de lifecycle via Claude (Anthropic API)
// com busca web real. A chave (ANTHROPIC_API_KEY) fica em variável de ambiente
// no Netlify — NUNCA no navegador. O usuário final não precisa de chave.
//
// Confiabilidade: só afirma um status se a busca web retornou uma citação real
// (página efetivamente consultada). Sem citação = "unknown", exige verificação manual.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return url;
  }
}

function buildPrompt(pn, mfr) {
  return `Você é um assistente técnico de engenharia eletrônica avaliando o status de lifecycle de componentes para um relatório profissional de obsolescência. Precisão é crítica: NÃO invente informação.

Pesquise na web o status de lifecycle do componente de part number "${pn}"${mfr ? " do fabricante " + mfr : ""}. Consulte fontes primárias e confiáveis: página oficial do fabricante (product status / PCN), DigiKey, Mouser, Octopart, Findchips, Sourcengine.

Regras obrigatórias:
- Só afirme "active", "nrnd" ou "obsolete" se você EFETIVAMENTE encontrou essa informação em uma fonte confiável durante a busca.
- Se a busca não retornou uma fonte que confirme o status com clareza, responda "status":"unknown" e "confidence":"low". NÃO chute.
- "confidence":"high" só se 2+ fontes independentes concordarem; "medium" para 1 fonte confiável; "low" se ambíguo ou inferido.

Responda EXCLUSIVAMENTE com um objeto JSON válido, sem markdown, sem texto antes ou depois:
{"status":"active|nrnd|obsolete|unknown","confidence":"high|medium|low","substitute":"part number sugerido ou vazio","notes":"observação curta em português, até 25 palavras. Se unknown, explique que precisa de verificação manual."}`;
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Método não permitido" }) };
  }

  let pn, mfr;
  try {
    ({ pn, mfr } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Corpo inválido" }) };
  }
  if (!pn || !pn.trim()) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Part number ausente" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada no servidor." }),
    };
  }

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: buildPrompt(pn.trim(), mfr) }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      }),
    });

    const data = await response.json();
    if (data.error) {
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ error: data.error.message || "Erro na API Anthropic" }),
      };
    }

    const content = data.content || [];

    // 1) Extrai o JSON com status/confidence/substitute/notes
    const textBlocks = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const jsonMatch = textBlocks.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ error: "Resposta sem JSON reconhecível" }),
      };
    }
    const parsed = JSON.parse(jsonMatch[0]);

    // 2) Captura as CITAÇÕES REAIS da busca web (páginas efetivamente consultadas)
    const sources = [];
    const seen = new Set();
    function addSource(url, title) {
      if (!url || seen.has(url)) return;
      seen.add(url);
      sources.push({ url, name: title || domainOf(url) });
    }

    content.forEach((block) => {
      if (block.type === "text" && Array.isArray(block.citations)) {
        block.citations.forEach((c) => {
          if (c.type === "web_search_result_location" && c.url) {
            addSource(c.url, c.title);
          }
        });
      }
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        block.content.forEach((r) => {
          if (r.url) addSource(r.url, r.title);
        });
      }
    });

    // 3) Regra de segurança: sem fonte real confirmada => não conclusivo
    if (sources.length === 0) {
      parsed.status = "unknown";
      parsed.confidence = "low";
      parsed.notes = "Nenhuma fonte confirmada foi retornada pela busca. Verificação manual necessária.";
    }

    parsed.sources = sources.slice(0, 3);

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message || "Erro interno" }),
    };
  }
};
