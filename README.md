# GitHub Project Tasks Importer (Draft / Issue)

Script Node.js para importar tasks a partir de arquivos JSON e criar itens em um **GitHub Project (Projects v2)** como:

- **Draft Issues** (rascunhos dentro do Project), ou
- **Issues reais** em um repositório, **com labels** (tags) e **adicionadas ao Project**.

> Ideal para popular um roadmap/kanban a partir de um backlog em JSON.

---

## Recursos

- Suporta `--type draft | issue`
- Suporta 1 ou N arquivos JSON (`--json` repetido ou separado por vírgula)
- `--dry-run` para simular sem criar nada
- `--skip-existing` para evitar duplicar itens pelo **título** (dedupe no Project)
- Cache interno de `repositoryId` e `labelIds` por repositório (performance)

---

## Requisitos

- Node.js **18+** (usa `fetch` nativo)
- Token no ambiente: `GITHUB_TOKEN`
- Dependência local: `dotenv` (opcional, mas recomendado)
- (Opcional) `jq` se você for usar scripts auxiliares no terminal, não é necessário para este script

Instale dependências:

```bash
npm i dotenv
# ou
pnpm add dotenv
````

Crie um `.env` (opcional):

```env
GITHUB_TOKEN=ghp_xxx
```

---

## Permissões do Token

### Para `--type draft`

* Precisa de permissão de **Projects v2 (write)**

  * Em PAT classic: escopo `project`

### Para `--type issue`

* Precisa de:

  * **Projects v2 (write)** para adicionar ao Project
  * Permissão para **criar issues** no repositório
  * Permissão para **ler labels** e **aplicar labels** (normalmente junto de Issues write)

Se falhar com:

* `Resource not accessible by personal access token`

  * Seu token não tem permissão suficiente **ou** seu usuário não tem acesso “Write/Admin” no Project/repo.

---

## Uso

### Criar Draft Issues no Project (padrão)

```bash
GITHUB_TOKEN=xxx node index.js \
  --owner OpenAudit-Brasil \
  --project "OpenAudit Brasil — Roadmap" \
  --json ./tasks.json \
  --type draft
```

### Criar Issues no repositório e adicionar ao Project

```bash
GITHUB_TOKEN=xxx node index.js \
  --owner OpenAudit-Brasil \
  --project "OpenAudit Brasil — Roadmap" \
  --json ./tasks.json \
  --type issue
```

---

## Flags disponíveis

| Flag               | Obrigatório | Exemplo            | Descrição                                   |
| ------------------ | ----------- | ------------------ | ------------------------------------------- |
| `--owner`          | sim         | `OpenAudit-Brasil` | Login do owner (org ou user)                |
| `--project`        | condicional | `"Roadmap"`        | Título do ProjectV2                         |
| `--project-number` | condicional | `1`                | Número do ProjectV2 (alternativa ao título) |
| `--json`           | sim         | `./tasks.json`     | Arquivo(s) JSON de entrada (pode repetir)   |
| `--type`           | não         | `draft` / `issue`  | Tipo de criação (`draft` padrão)            |
| `--dry-run`        | não         |                    | Simula sem criar nada                       |
| `--skip-existing`  | não         |                    | Evita duplicar pelo título no Project       |
| `--api-url`        | não         |                    | Endpoint GraphQL (default: GitHub)          |

> Você deve informar `--project` **ou** `--project-number`.

---

## Formato do JSON

O script aceita e normaliza os seguintes formatos:

### Formato 1 (recomendado)

```json
{
  "repo": "openaudit-core-contracts",
  "tasks": [
    {
      "titulo": "Bootstrap do repositório",
      "tags": ["priority:high", "type:chore", "good first issue"],
      "visao_geral": "…",
      "contexto": "…",
      "descricao": "…",
      "impacto": "…",
      "referencias": ["https://..."],
      "definicao_de_pronto": ["Item 1", "Item 2"]
    }
  ]
}
```

### Formato 2 (lista de múltiplos repos)

```json
[
  { "repo": "repo-a", "tasks": [ { "titulo": "..." } ] },
  { "repo": "repo-b", "tasks": [ { "titulo": "..." } ] }
]
```

### Formato 3 (wrapper)

```json
{
  "items": [
    { "repo": "repo-a", "tasks": [ { "titulo": "..." } ] }
  ]
}
```

---

## Como o `repo` é interpretado

* Se `repo` vier como `"repo-name"`, o script assume `--owner` como owner do repositório:

  * `OpenAudit-Brasil/repo-name`
* Se `repo` vier como `"owner/repo"`, usa exatamente esse par.

---

## Como as tags viram labels (somente `--type issue`)

* `task.tags` é interpretado como **nomes de labels existentes** no repositório.
* O script lista labels do repo e mapeia `name -> id`.
* Depois cria a issue usando `labelIds`.

### Importante

* Se a label **não existir** no repo, o script:

  * não cria a label automaticamente
  * imprime um warning e segue sem essa label

---

## Checklist em "Definição de pronto"

Se `definicao_de_pronto` existir, o script gera uma checklist:

```md
## Definição de pronto
- [ ] Item 1
- [ ] Item 2
```

Recomendação: evite itens com quebras de linha. Se existir texto com `\n`, normalize para uma linha.

---

## Dedupe (`--skip-existing`)

Quando habilitado, o script carrega títulos existentes no Project (Draft/Issue/PR) e evita criar itens com o **mesmo título**.

**Observação:** isso deduplica pelo Project, não pelo repositório.

---

## Diagnóstico rápido

* Se você consegue listar o Project mas falha para criar: token sem **write**.
* Se cria issue mas não aplica label:

  * labels não existem no repo
  * token não tem permissão para issues/labels
* Se o Project não é encontrado:

  * use `--project-number` (mais confiável)

---

## Segurança / Boas práticas

* Não comite `GITHUB_TOKEN` em repositório.
* Use `.env` e garanta `.gitignore` para arquivos de ambiente.

---

## Licença

MIT
