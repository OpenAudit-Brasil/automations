#!/usr/bin/env node
/**
 *
 * Cria itens em um GitHub Project (Projects v2) a partir de 1 ou N arquivos JSON.
 * Você pode criar:
 * - **Draft Issues** (rascunhos dentro do Project), ou
 * - **Issues reais** em um repositório e adicioná-las ao Project.
 *
 * Formato dos JSONs aceitos (normalizado):
 * { "repo": "repo-name" | "owner/repo", "tasks": [ { "titulo": "...", ... } ] }
 *
 * Requisitos:
 * - Node.js 18+ (fetch nativo)
 * - env GITHUB_TOKEN
 *   - Para **draft**: precisa permissão de Projects (escopo `project` em PAT classic).
 *   - Para **issue**: além de Projects, precisa permissão para criar Issues no(s) repositório(s)
 *     (`repo` / `public_repo` em PAT classic, ou permissão equivalente em fine-grained).
 *
 * Docs (Projects v2 / GraphQL):
 * https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects
 *
 * Uso:
 *   GITHUB_TOKEN=xxx node index.js \
 *     --owner OpenAudit-Brasil \
 *     --project "OpenAudit Brasil — Roadmap" \
 *     --json ./tasks.json \
 *     --type draft
 *
 * Criar como issue (e adicionar ao Project):
 *   GITHUB_TOKEN=xxx node index.js \
 *     --owner OpenAudit-Brasil \
 *     --project "OpenAudit Brasil — Roadmap" \
 *     --json ./tasks.json \
 *     --type issue
 *
 * Vários arquivos:
 *   --json ./tasks-a.json --json ./tasks-b.json
 *   ou: --json ./tasks-a.json,./tasks-b.json
 *
 * Opcional:
 *   --project-number 5
 *   --skip-existing
 *   --dry-run
 *   --api-url https://api.github.com/graphql
 */

"use strict";

const DEFAULT_API_URL = "https://api.github.com/graphql";
require("dotenv").config();

main().catch((err) => {
    console.error("\n[FATAL]", err?.message || err);
    process.exit(1);
});

/**
 * Fluxo principal:
 * 1) Lê e valida argumentos
 * 2) Resolve owner (org/user) e localiza o ProjectV2
 * 3) Carrega tasks de 1..N JSONs
 * 4) Cria itens como Draft Issues (no Project) ou Issues (no repo) e adiciona ao Project
 *
 * @returns {Promise<void>}
 */
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error(
            "Defina a env GITHUB_TOKEN (PAT). Para --type draft/issue você precisa de Projects (escopo 'project' em PAT classic). Para --type issue, você também precisa permissão para criar issues no(s) repositório(s)."
        );
    }

    const ownerLogin = requireArg(args, "owner");
    const projectTitle = args.project ?? null;
    const projectNumber = args["project-number"]
        ? parseInt(args["project-number"], 10)
        : null;

    const type = String(args.type ?? "draft").trim().toLowerCase();
    if (type !== "draft" && type !== "issue") {
        throw new Error("Valor inválido para --type. Use: --type draft | issue");
    }

    if (!projectTitle && !projectNumber) {
        throw new Error(
            "Informe --project \"<titulo>\" ou --project-number <n> para localizar o projeto."
        );
    }

    const jsonPaths = collectJsonPaths(args);
    if (jsonPaths.length === 0) {
        throw new Error("Informe pelo menos um --json <caminho/arquivo.json>.");
    }

    const apiUrl = args["api-url"] || DEFAULT_API_URL;
    const dryRun = !!args["dry-run"];
    const skipExisting = !!args["skip-existing"];

    // 1) Descobrir se "owner" é org ou user (tenta org primeiro, depois user).
    const owner = await resolveOwner(token, apiUrl, ownerLogin);

    // 2) Localizar projectId.
    const project =
        projectNumber != null
            ? await getProjectByNumber(token, apiUrl, owner, projectNumber)
            : await findProjectByTitle(token, apiUrl, owner, projectTitle);

    if (!project?.id) {
        throw new Error("Não consegui obter projectId.");
    }

    console.log(`[OK] Owner: ${owner.__typename}(${owner.login})`);
    console.log(`[OK] Project: ${project.title} (#${project.number})`);
    console.log(`[OK] projectId: ${project.id}`);
    console.log(`[OK] Arquivos JSON: ${jsonPaths.join(", ")}`);
    console.log(`[OK] Tipo de criação: ${type}`);

    // 3) Carregar tasks dos JSONs.
    const allTasks = await loadAllTasksFromFiles(jsonPaths);

    if (allTasks.length === 0) {
        console.log("[INFO] Nenhuma task encontrada nos JSONs.");
        return;
    }

    console.log(`[INFO] Total de tasks: ${allTasks.length}`);

    // 4) Opcional: buscar títulos existentes para evitar duplicar.
    let existingTitles = new Set();
    if (skipExisting) {
        console.log("[INFO] Carregando itens existentes do projeto (para dedupe)...");
        existingTitles = await listProjectDraftIssueTitles(token, apiUrl, project.id);
        console.log(`[INFO] Títulos encontrados (draft/issue/pr): ${existingTitles.size}`);
    }

    // 5) Criar drafts.
    let created = 0;
    let skipped = 0;

    /** @type {Map<string, string>} */
    const repoIdCache = new Map();

    /** @type {Map<string, Map<string, string>>} */
    const repoLabelCache = new Map();

    for (const t of allTasks) {
        const title = buildDraftTitle(t.repo, t.task);
        const body = buildDraftBody(t.repo, t.task);

        if (skipExisting && existingTitles.has(title)) {
            skipped++;
            console.log(`[SKIP] Já existe: ${title}`);
            continue;
        }

        if (dryRun) {
            if (type === "draft") {
                console.log(`\n[DRY-RUN] Criaria draft no Project:\n- ${title}\n`);
            } else {
                console.log(`\n[DRY-RUN] Criaria issue e adicionaria ao Project:\n- ${title}\n  repo=${t.repo}\n`);
            }
            created++;
            continue;
        }

        if (type === "draft") {
            const projectItemId = await addProjectV2DraftIssue(
                token,
                apiUrl,
                project.id,
                title,
                body
            );
            created++;
            console.log(`[CREATED] ${title}`);
            console.log(`          type=draft projectItemId=${projectItemId}`);
            continue;
        }

        // type === "issue"
        const repoRef = parseRepoRef(t.repo, ownerLogin);
        const cacheKey = `${repoRef.owner}/${repoRef.name}`;

        let repositoryId = repoIdCache.get(cacheKey);
        if (!repositoryId) {
            repositoryId = await resolveRepositoryId(token, apiUrl, repoRef.owner, repoRef.name);
            repoIdCache.set(cacheKey, repositoryId);
        }

        const labelIds = await resolveLabelIdsForTags(
            token,
            apiUrl,
            repositoryId,
            t.task?.tags,
            repoLabelCache,
            cacheKey
        );

        const issue = await createIssue(token, apiUrl, repositoryId, title, body, labelIds);
        const projectItemId = await addProjectV2ItemById(token, apiUrl, project.id, issue.id);

        created++;
        console.log(`[CREATED] ${title}`);
        console.log(
            `          type=issue repo=${cacheKey} issue=#${issue.number} url=${issue.url} projectItemId=${projectItemId}`
        );
    }

    console.log("\n[RESUMO]");
    console.log(`Criadas: ${created}`);
    console.log(`Puladas: ${skipped}`);
}

/* ----------------------------- CLI / Args ----------------------------- */

/**
 * Faz parsing simples de CLI args no formato `--chave valor` e flags `--flag`.
 *
 * - Suporta repetição: `--json a --json b` (vira array)
 * - Suporta flags booleanas: `--dry-run`, `--skip-existing`
 *
 * @param {string[]} argv Lista de argumentos (ex.: process.argv.slice(2)).
 * @returns {Record<string, string | boolean | string[]>} Mapa chave->valor.
 */
function parseArgs(argv) {
    const out = Object.create(null);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) continue;

        const key = a.slice(2);
        const next = argv[i + 1];

        const isFlag = next == null || next.startsWith("--");
        if (isFlag) {
            out[key] = true;
        } else {
            // aceita repetição: --json a --json b
            if (out[key] == null) out[key] = next;
            else if (Array.isArray(out[key])) out[key].push(next);
            else out[key] = [out[key], next];
            i++;
        }
    }
    return out;
}

/**
 * Obtém um argumento obrigatório do objeto retornado por {@link parseArgs}.
 *
 * @param {Record<string, any>} args Resultado do parse de args.
 * @param {string} key Nome do parâmetro (sem `--`).
 * @returns {any} Valor do argumento.
 * @throws {Error} Se o argumento não existir ou estiver vazio.
 */
function requireArg(args, key) {
    const v = args[key];
    if (v == null || v === "") throw new Error(`Parâmetro obrigatório: --${key}`);
    return v;
}

/**
 * Coleta caminhos de JSON de `--json`.
 *
 * Suporta:
 * - `--json a.json` (1 arquivo)
 * - `--json a.json --json b.json` (N arquivos)
 * - `--json a.json,b.json` (lista separada por vírgula)
 *
 * @param {Record<string, any>} args Resultado do parse.
 * @returns {string[]} Lista normalizada de caminhos.
 */
function collectJsonPaths(args) {
    const val = args.json;
    if (!val) return [];

    const arr = Array.isArray(val) ? val : [val];
    // permite: --json a,b,c
    return arr
        .flatMap((x) => String(x).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
}

/* ----------------------------- JSON Loading ----------------------------- */

/**
 * Carrega e normaliza tasks de 1..N arquivos JSON.
 *
 * @param {string[]} paths Caminhos dos arquivos JSON.
 * @returns {Promise<Array<{repo: string, task: any}>>} Lista plana de tasks.
 */
async function loadAllTasksFromFiles(paths) {
    const fs = await import("node:fs/promises");

    const results = [];
    for (const p of paths) {
        const raw = await fs.readFile(p, "utf8");
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            throw new Error(`JSON inválido em: ${p}`);
        }

        const normalized = normalizeTaskFile(data, p);
        results.push(...normalized);
    }
    return results;
}

/**
 * Normaliza vários formatos aceitáveis de JSON.
 *
 * Formatos aceitos:
 * 1) `{ repo: "x", tasks: [ ... ] }`
 * 2) `[ { repo:"x", tasks:[...] }, { repo:"y", tasks:[...] } ]`
 * 3) `{ items: [ { repo:"x", tasks:[...] } ] }` (fallback)
 *
 * @param {any} data Objeto/array carregado do JSON.
 * @param {string} filePathForErrors Caminho do arquivo (para mensagem de erro).
 * @returns {Array<{repo: string, task: any}>} Lista plana `{ repo, task }`.
 */
function normalizeTaskFile(data, filePathForErrors) {
    const out = [];

    if (Array.isArray(data)) {
        for (const entry of data) out.push(...normalizeTaskFile(entry, filePathForErrors));
        return out;
    }

    if (data && typeof data === "object" && Array.isArray(data.items)) {
        for (const entry of data.items) out.push(...normalizeTaskFile(entry, filePathForErrors));
        return out;
    }

    if (!data || typeof data !== "object") {
        throw new Error(`Formato inesperado em ${filePathForErrors}: esperado objeto/array.`);
    }

    if (typeof data.repo !== "string" || !Array.isArray(data.tasks)) {
        throw new Error(
            `Formato inesperado em ${filePathForErrors}: esperado { repo: string, tasks: array }.`
        );
    }

    for (const task of data.tasks) {
        if (!task || typeof task !== "object" || typeof task.titulo !== "string") {
            throw new Error(`Task inválida em ${filePathForErrors}: cada task precisa de "titulo".`);
        }
        out.push({ repo: data.repo, task });
    }

    return out;
}

/* ----------------------------- Task -> Draft ----------------------------- */

/**
 * Monta o título padronizado da task.
 *
 * @param {string} repo Repositório (ex.: "repo" ou "owner/repo").
 * @param {{ titulo: string }} task Task com campo `titulo`.
 * @returns {string} Título formatado.
 */
function buildDraftTitle(repo, task) {
    // Exigência: "[repo] titulo"
    return `[${repo}] ${task.titulo}`.trim();
}

/**
 * Monta o body (Markdown) do item a partir do payload da task.
 *
 * Observação:
 * - Draft Issues não suportam labels/assignees como Issues de repo.
 * - Para manter rastreabilidade, este script inclui as `tags` no body.
 *
 * @param {string} repo Repositório alvo.
 * @param {any} task Task (payload do JSON).
 * @returns {string} Markdown do body.
 */
function buildDraftBody(repo, task) {
    const lines = [];

    lines.push(`**Repo:** \`${repo}\``);
    lines.push("");

    if (Array.isArray(task.tags) && task.tags.length) {
        lines.push(`**Tags:** ${task.tags.map((t) => `\`${t}\``).join(" ")}`);
        lines.push("");
    }

    if (task.visao_geral) {
        lines.push("## Visão geral");
        lines.push(task.visao_geral);
        lines.push("");
    }

    if (task.contexto) {
        lines.push("## Contexto");
        lines.push(task.contexto);
        lines.push("");
    }

    if (task.descricao) {
        lines.push("## Descrição");
        lines.push(task.descricao);
        lines.push("");
    }

    if (task.impacto) {
        lines.push("## Impacto");
        lines.push(task.impacto);
        lines.push("");
    }

    if (Array.isArray(task.referencias) && task.referencias.length) {
        lines.push("## Referências");
        for (const r of task.referencias) lines.push(`- ${r}`);
        lines.push("");
    }

    if (Array.isArray(task.definicao_de_pronto) && task.definicao_de_pronto.length) {
        lines.push("## Definição de pronto");
        for (const d of task.definicao_de_pronto) {
            const text = String(d ?? "").trim().replace(/\s*\n\s*/g, " ");
            if (text) lines.push(`- [ ] ${text}`);
        }
        lines.push("");
    }

    return lines.join("\n");
}

/**
 * Converte um identificador de repo em `{ owner, name }`.
 *
 * Regras:
 * - Se `repo` vier como `owner/name`, usa esse owner.
 * - Se `repo` vier como `name`, usa `defaultOwner`.
 *
 * @param {string} repo String vinda do JSON.
 * @param {string} defaultOwner Owner padrão (CLI `--owner`).
 * @returns {{ owner: string, name: string }} Repo parseado.
 */
function parseRepoRef(repo, defaultOwner) {
    const raw = String(repo || "").trim();
    if (!raw) return { owner: defaultOwner, name: raw };
    if (raw.includes("/")) {
        const [owner, name] = raw.split("/");
        return { owner: owner.trim(), name: (name || "").trim() };
    }
    return { owner: defaultOwner, name: raw };
}

/* ----------------------------- GitHub GraphQL ----------------------------- */

/**
 * Executa uma operação GraphQL no GitHub (query/mutation).
 *
 * @param {string} token Token (PAT).
 * @param {string} apiUrl URL do endpoint GraphQL.
 * @param {string} query Query/mutation GraphQL.
 * @param {Record<string, any>} variables Variáveis para a operação.
 * @returns {Promise<any>} `data` retornado pelo GitHub.
 */
async function githubGraphQL(token, apiUrl, query, variables) {
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "openaudit-project-tasks-script",
        },
        body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new Error(`Resposta não-JSON do GitHub: HTTP ${res.status}\n${text}`);
    }

    if (!res.ok) {
        throw new Error(
            `GitHub GraphQL HTTP ${res.status}: ${payload?.message || "erro"}\n${text}`
        );
    }

    if (payload.errors?.length) {
        const msg = payload.errors.map((e) => e.message).join(" | ");
        throw new Error(`GitHub GraphQL errors: ${msg}`);
    }

    return payload.data;
}

/**
 * Resolve um `owner` (Organization ou User) a partir do login.
 *
 * @param {string} token Token (PAT).
 * @param {string} apiUrl URL GraphQL.
 * @param {string} login Login do owner.
 * @returns {Promise<{id: string, login: string, __typename: 'Organization' | 'User'}>}
 */
async function resolveOwner(token, apiUrl, login) {
    const qOrg = `
    query($login: String!) {
      organization(login: $login) { id login __typename }
    }
  `;
    const d1 = await githubGraphQL(token, apiUrl, qOrg, { login });
    if (d1?.organization?.id) return d1.organization;

    const qUser = `
    query($login: String!) {
      user(login: $login) { id login __typename }
    }
  `;
    const d2 = await githubGraphQL(token, apiUrl, qUser, { login });
    if (d2?.user?.id) return d2.user;

    throw new Error(`Owner não encontrado: ${login}`);
}

/**
 * Busca um ProjectV2 pelo número (`/orgs/<org>/projects/<number>`).
 *
 * @param {string} token Token (PAT).
 * @param {string} apiUrl URL GraphQL.
 * @param {{login: string, __typename: string}} owner Owner resolvido.
 * @param {number} number Número do project.
 * @returns {Promise<{id: string, title: string, number: number}>}
 */
async function getProjectByNumber(token, apiUrl, owner, number) {
    const query =
        owner.__typename === "Organization"
            ? `
        query($login: String!, $number: Int!) {
          organization(login: $login) {
            projectV2(number: $number) { id title number }
          }
        }
      `
            : `
        query($login: String!, $number: Int!) {
          user(login: $login) {
            projectV2(number: $number) { id title number }
          }
        }
      `;

    const data = await githubGraphQL(token, apiUrl, query, {
        login: owner.login,
        number,
    });

    const p =
        owner.__typename === "Organization"
            ? data.organization?.projectV2
            : data.user?.projectV2;

    if (!p) throw new Error(`ProjectV2 #${number} não encontrado em ${owner.login}.`);
    return p;
}

/**
 * Busca um ProjectV2 pelo título (case-insensitive) percorrendo paginação.
 *
 * @param {string} token Token (PAT).
 * @param {string} apiUrl URL GraphQL.
 * @param {{login: string, __typename: string}} owner Owner resolvido.
 * @param {string} title Título do project.
 * @returns {Promise<{id: string, title: string, number: number}>}
 */
async function findProjectByTitle(token, apiUrl, owner, title) {
    // Lista projectsV2 e encontra por title (case-insensitive).
    // Paginação: first=100 + after.
    const query =
        owner.__typename === "Organization"
            ? `
        query($login: String!, $after: String) {
          organization(login: $login) {
            projectsV2(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id title number }
            }
          }
        }
      `
            : `
        query($login: String!, $after: String) {
          user(login: $login) {
            projectsV2(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id title number }
            }
          }
        }
      `;

    let after = null;
    const target = String(title).trim().toLowerCase();

    while (true) {
        const data = await githubGraphQL(token, apiUrl, query, {
            login: owner.login,
            after,
        });

        const conn =
            owner.__typename === "Organization"
                ? data.organization?.projectsV2
                : data.user?.projectsV2;

        const nodes = conn?.nodes ?? [];
        for (const p of nodes) {
            if (String(p.title).trim().toLowerCase() === target) return p;
        }

        if (!conn?.pageInfo?.hasNextPage) break;
        after = conn.pageInfo.endCursor;
    }

    throw new Error(
        `Project "${title}" não encontrado em ${owner.login}. Dica: use --project-number (URL: /orgs/<org>/projects/<n>).`
    );
}

/**
 * Cria um Draft Issue diretamente dentro do Project (Projects v2).
 *
 * @param {string} token Token (PAT).
 * @param {string} apiUrl URL GraphQL.
 * @param {string} projectId ID global do ProjectV2.
 * @param {string} title Título do item.
 * @param {string} body Corpo markdown do item.
 * @returns {Promise<string>} ID do project item criado.
 */
async function addProjectV2DraftIssue(token, apiUrl, projectId, title, body) {
    const mutation = `
    mutation($projectId: ID!, $title: String!, $body: String!) {
      addProjectV2DraftIssue(
        input: { projectId: $projectId, title: $title, body: $body }
      ) {
        projectItem { id }
      }
    }
  `;

    const data = await githubGraphQL(token, apiUrl, mutation, {
        projectId,
        title,
        body,
    });

    const id = data?.addProjectV2DraftIssue?.projectItem?.id;
    if (!id) throw new Error("Falha ao criar draft issue (sem projectItem.id).");
    return id;
}

/**
 * Resolve o `repositoryId` (GraphQL Node ID) a partir de owner/name.
 *
 * @param {string} token Token (PAT).
 * @param {string} apiUrl URL GraphQL.
 * @param {string} repoOwner Login do owner do repo.
 * @param {string} repoName Nome do repositório.
 * @returns {Promise<string>} repositoryId.
 */
async function resolveRepositoryId(token, apiUrl, repoOwner, repoName) {
    const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id nameWithOwner }
    }
  `;

    const data = await githubGraphQL(token, apiUrl, query, { owner: repoOwner, name: repoName });
    const repo = data?.repository;
    if (!repo?.id) {
        throw new Error(`Repositório não encontrado (ou sem acesso): ${repoOwner}/${repoName}`);
    }
    return repo.id;
}


/**
 * Lista labels existentes do repositório.
 *
 * Nota:
 * - Labels são **por repositório**, não por organização. Se você quer um conjunto padrão,
 *   precisa garantir que elas existam no repo antes (ou criar via outra automação).
 *
 * @param {string} token Token (PAT).
 * @param {string} apiUrl URL GraphQL.
 * @param {string} repositoryId Node ID do repositório.
 * @returns {Promise<Map<string, string>>} Mapa `labelNameLower -> labelId`.
 */
async function listRepositoryLabels(token, apiUrl, repositoryId) {
    const query = `
    query($id: ID!, $after: String) {
      node(id: $id) {
        ... on Repository {
          labels(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id name }
          }
        }
      }
    }
  `;

    /** @type {Map<string, string>} */
    const out = new Map();
    let after = null;

    while (true) {
        const data = await githubGraphQL(token, apiUrl, query, { id: repositoryId, after });
        const labels = data?.node?.labels;
        const nodes = labels?.nodes ?? [];

        for (const l of nodes) {
            if (!l?.id || !l?.name) continue;
            out.set(String(l.name).trim().toLowerCase(), l.id);
        }

        if (!labels?.pageInfo?.hasNextPage) break;
        after = labels.pageInfo.endCursor;
    }

    return out;
}

/**
 * Resolve os `labelIds` a partir de uma lista de tags (strings) do JSON.
 *
 * Comportamento:
 * - Se a tag existir como label no repo (match case-insensitive), ela será aplicada na issue.
 * - Se NÃO existir, o script **não cria** automaticamente (para evitar efeitos colaterais),
 *   apenas emite um warning e segue.
 *
 * @param {string} token Token (PAT).
 * @param {string} apiUrl URL GraphQL.
 * @param {string} repositoryId Node ID do repositório.
 * @param {unknown} tags Campo `task.tags` vindo do JSON.
 * @param {Map<string, Map<string, string>>} repoLabelCache Cache por repo (key: `${owner}/${name}`).
 * @param {string} repoCacheKey Chave do cache (`owner/name`).
 * @returns {Promise<string[] | null>} Lista de labelIds (ou `null` se não houver nada para aplicar).
 */
async function resolveLabelIdsForTags(token, apiUrl, repositoryId, tags, repoLabelCache, repoCacheKey) {
    if (!Array.isArray(tags) || tags.length === 0) return null;

    let labelMap = repoLabelCache.get(repoCacheKey);
    if (!labelMap) {
        labelMap = await listRepositoryLabels(token, apiUrl, repositoryId);
        repoLabelCache.set(repoCacheKey, labelMap);
    }

    const ids = [];
    const missing = [];

    for (const t of tags) {
        const name = String(t ?? "").trim();
        if (!name) continue;

        const id = labelMap.get(name.toLowerCase());
        if (id) ids.push(id);
        else missing.push(name);
    }

    if (missing.length) {
        console.warn(
            `[WARN] Labels não encontradas em ${repoCacheKey}: ${missing.join(", ")}`
        );
    }

    return ids.length ? ids : null;
}

/**
 * Cria uma Issue no repositório.
 *
 * Se `labelIds` for fornecido, aplica labels na criação.
 *
 * Observações:
 * - Labels são por repositório; se um nome não existir, ele não será aplicado.
 * - Para aplicar labels, o token precisa de permissão de escrita em Issues no repo.
 *
 * @param {string} token Token (PAT).
 * @param {string} apiUrl URL GraphQL.
 * @param {string} repositoryId Node ID do repo.
 * @param {string} title Título da issue.
 * @param {string} body Corpo markdown.
 * @param {string[] | null | undefined} labelIds Lista de IDs de labels (ou null).
 * @returns {Promise<{id: string, number: number, url: string}>} Issue criada.
 */
async function createIssue(token, apiUrl, repositoryId, title, body, labelIds) {
    const mutation = `
    mutation($repositoryId: ID!, $title: String!, $body: String!, $labelIds: [ID!]) {
      createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body, labelIds: $labelIds }) {
        issue { id number url }
      }
    }
  `;

    const data = await githubGraphQL(token, apiUrl, mutation, {
        repositoryId,
        title,
        body,
        labelIds: labelIds && labelIds.length ? labelIds : null,
    });
    const issue = data?.createIssue?.issue;
    if (!issue?.id) throw new Error("Falha ao criar issue (sem issue.id).");
    return { id: issue.id, number: issue.number, url: issue.url };
}

/**
 * Adiciona um content (Issue/PR) ao ProjectV2.
 *
 * @param {string} token Token (PAT).
 * @param {string} apiUrl URL GraphQL.
 * @param {string} projectId Node ID do ProjectV2.
 * @param {string} contentId Node ID do content (ex.: Issue.id).
 * @returns {Promise<string>} ID do item dentro do Project.
 */
async function addProjectV2ItemById(token, apiUrl, projectId, contentId) {
    const mutation = `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `;

    const data = await githubGraphQL(token, apiUrl, mutation, { projectId, contentId });
    const id = data?.addProjectV2ItemById?.item?.id;
    if (!id) throw new Error("Falha ao adicionar issue ao project (sem item.id).");
    return id;
}

/**
 * Lista títulos já existentes no Project (DraftIssue/Issue/PullRequest) para deduplicar.
 *
 * Nota: isso pode ser “caro” em projetos enormes; aqui limitamos a 500 itens.
 *
 * @param {string} token Token (PAT).
 * @param {string} apiUrl URL GraphQL.
 * @param {string} projectId Node ID do ProjectV2.
 * @returns {Promise<Set<string>>} Conjunto de títulos encontrados.
 */
async function listProjectDraftIssueTitles(token, apiUrl, projectId) {
    const query = `
    query($projectId: ID!, $after: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              content {
                __typename
                ... on DraftIssue { title }
                ... on Issue { title }
                ... on PullRequest { title }
              }
            }
          }
        }
      }
    }
  `;

    const titles = new Set();
    let after = null;
    let seen = 0;

    while (true) {
        const data = await githubGraphQL(token, apiUrl, query, { projectId, after });
        const items = data?.node?.items;
        const nodes = items?.nodes ?? [];

        for (const n of nodes) {
            const t = n?.content?.title;
            if (typeof t === "string" && t.trim()) titles.add(t.trim());
            seen++;
            if (seen >= 500) return titles;
        }

        if (!items?.pageInfo?.hasNextPage) break;
        after = items.pageInfo.endCursor;
    }

    return titles;
}
