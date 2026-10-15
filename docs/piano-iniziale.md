---
project: "Buildrs"
created: 2026-10-15
created_by: "emily"
last_updated: 2026-10-15
last_edited_by: "emily"
"tl;dr": "Piano per una piattaforma agenti open source Buildrs: nucleo Pi Durable (MIT, sperimentale), Hermes Agent come riferimento interno, solo core Apache di Mastra. Primo caso vendibile: segreteria commerciale su Telegram in 4 settimane."
tags:
  - type/reference
  - domain/ai-agents
  - domain/product
---
# Piattaforma agenti open source Buildrs: analisi tecnica

**Destinatario:** Emily (Chief of Staff), per Mario Miletta / [[Buildrs]]  
**Data:** 15 ottobre 2026 (Europe/Rome)  
**Scopo:** decidere stack e piano per una piattaforma di agenti open source, in stile harness sempre attivo ed espandibile, rivendibile o installabile on‑prem per PMI italiane. Canali: Telegram subito, app propria dopo. Nessun WhatsApp in questa fase.

**Metodo:** solo fatti verificati su fonti primarie (GitHub API, LICENSE, documentazione ufficiale, blog Earendil, npm). Dove qualcosa non è verificabile è marcato esplicitamente.

---

## 1. Cosa stiamo costruendo (e cosa no)

Buildrs non sta cercando un “chatbot con plugin”. Sta cercando un prodotto a tre livelli:

1. Un **agente generale sempre attivo**, estendibile, che Buildrs usa e che il cliente può parlare come assistente operativo.
2. La capacità di **creare agenti per clienti terzi**, collegati ai loro sistemi (CRM, mail, gestionali, API) per processi aziendali lunghi e interrotti (attese, approvazioni, crash, deploy).
3. Un modello commerciale **SaaS multi‑tenant e/o installazione on‑prem**, con Telegram come primo canale.

Questo cambia la scelta dello stack: serve un **harness durable** (conversazioni, tool, stato che sopravvivono ai crash), non solo un SDK che chiama un modello. Mario ha indicato come candidati **Hermes Agent**, **Pi Durable** (Earendil) e **Mastra**, più un motore durable generico. Il confronto centrale è su questi tre; Temporal, Inngest, Restate e DBOS restano solo punti di riferimento.

---

## 2. Confronto concreto delle opzioni

### 2.1 Hermes Agent (Nous Research)

**Cosa fa.** Hermes Agent è un agente open source “self‑improving” di Nous Research: memoria persistente, skills autodocumentate, gateway di messaging (Telegram, Discord, Slack, WhatsApp, Signal, CLI e altri), MCP, cron, terminali sandboxed (Docker, SSH, Modal, Daytona, ecc.), provider di modelli multipli. Si installa come CLI/desktop e può restare sempre attivo su una VPS. Documentazione: [hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com/), quickstart e gateway.

**Maturità (verificata via GitHub API, 15 ott 2026).**  
Repo: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). Licenza SPDX MIT. Creato 22 luglio 2025. Ultima release `v0.22.2` pubblicata il 15 ottobre 2026. Stelle/fork/issue riportati dall’API: circa 254 075 stelle, 55 167 fork, ~49 312 issue aperte. Questi numeri sono anomali per l’età del repo; li riporto come dato API, senza interpretarli come proxy di qualità enterprise.

**Licenza.** MIT (file LICENSE / SPDX sul repo).

**Multi‑tenant.** Hermes è pensato come agente personale o di team con **profili** e gateway multiplexing (un processo, più profili isolati: sessioni, memoria, secret, allowlist Telegram). Documentazione: [Running Many Gateways at Once](https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways). Un orchestratore multi‑tenant con OIDC e container per utente risulta come **feature request** aperta ([issue #82701](https://github.com/NousResearch/hermes-agent/issues/82701)), non come prodotto SaaS pronto. Non è un control plane multi‑tenant per rivendere agenti a decine di PMI con isolamento forte e billing.

**Integrazioni.** MCP first‑class; catalogo skills/plugin; messaging gateway; tool gateway Nous (opzionale, a pagamento). Ideale per “un agente che vive su Telegram e tocca i sistemi”, meno ideale come kernel di una piattaforma white‑label.

**Durabilità.** Sessioni e state.db/FTS5, resume, cron. Non è un motore di durable execution con checkpoint espliciti per ogni tool call e ripresa after crash come modello di programmazione (a differenza di Pi Durable).

**Costo ops / self‑host.** Basso per un’istanza: documentano deploy su VPS economica, container, Modal/Daytona. Alto se si cerca di forzarlo a multi‑tenant SaaS (provisioning profili/container, isolamento credential, osservabilità per tenant).

**Verdetto per Buildrs.** Ottimo come **agente operativo interno** di Buildrs e come **riferimento UX** (Telegram + skills + memoria). Debole come **nucleo della piattaforma commerciale multi‑tenant**. Usarlo come prodotto rivenduto “as‑is” significa ereditare un modello mentale single‑user/team, non un control plane PMI.

---

### 2.2 Pi Durable (Earendil / ecosistema Pi)

**Cosa fa.** Pi Durable (`@earendil-works/pi-durable`) è un **harness durable sperimentale** spedito insieme a Pi 1.0 (1 ottobre 2026). Non sostituisce Pi coding agent: è un framework per applicazioni agentiche long‑running. Definizione Earendil di harness: storage + macchina per far girare una o più conversazioni LLM in parallelo, con tool e ambienti di esecuzione. Fonte primaria: [Pi Durable | Earendil](https://earendil.com/posts/pi-durable/), README in `packages/durable` del repo [earendil-works/pi](https://github.com/earendil-works/pi).

Capacità dichiarate e documentate (tutte verificate sul post ufficiale e sul README):

- **Checkpoint per ogni task** (turno modello, tool call, compaction, task custom): se il processo muore, un nuovo processo apre lo stesso storage, chiama `resume()`, e continua dall’ultimo checkpoint.
- **Storage pluggable:** memory, SQLite, JSONL; interfaccia piccola per Postgres/KV; SQLite/JSONL senza API Node (adattabile a Bun / Cloudflare Durable Object).
- **Molte conversazioni concorrenti**, fork (es. canale Slack + thread), ownership tree (abort a cascata).
- **Extensions** (prompt sections, tools, hooks, task), registry hot‑reload senza fermare gli agenti.
- **Replay safety** sui tool (`replay: "safe"` vs non ripetibile, es. deploy).
- **Compaction** in background, handoff/reset senza cancellare lo storico ricercabile.
- **Documents** (stato applicativo tipizzato nello stesso commit atomico del transcript).
- **Multiplayer:** più client guardano e steerano la stessa conversazione (`viewState`, `watch`, `whenBusy: "steer"`).
- **Codice piccolo** (~15 000 linee senza test, stimati ~150–250 k token), leggibile da un agente che lo modifica.

**Maturità.**  
Repo monorepo Pi: [earendil-works/pi](https://github.com/earendil-works/pi), MIT, creato 9 agosto 2025. GitHub API 15 ott 2026: ~115 429 stelle, ~14 709 fork, ~348 issue aperte. Pacchetto npm `@earendil-works/pi-durable` versione **1.3.0**, license **MIT**. Il README marca il pacchetto come **Experimental: The API changes without notice between releases.** Pi 1.0 (coding agent) è presentato come base stabile; Pi Durable è esplicitamente sperimentale.

**Licenza.** MIT (LICENSE del repo, copyright Mario Zechner / ecosistema Earendil; npm conferma MIT).

**Multi‑tenant.** Non c’è un “tenant” di prodotto. Il modello è: **un processo proprietario di uno storage**; altri client si attaccano a quel processo. Per SaaS Buildrs va costruito sopra: uno storage (o un Harness) per workspace/tenant, routing Telegram → conversation, vault credenziali. È fattibile perché l’API è a livello di libreria, non di prodotto chiuso.

**Integrazioni.** Tool ed execution environment pluggable; coding tools inclusi; subagent come poche righe. MCP non è il centro del pitch Durable (Pi in generale ha posizioni proprie su MCP/codemode: vedi post Earendil “You Said No MCP!”; **non approfondito qui come requisito**). Per CRM/mail/gestionali Buildrs aggiunge extensions/tool o un bridge MCP esterno.

**Durabilità.** Questo è il punto di forza: durable execution **dentro** il ciclo agente (non un workflow engine generico accanto). Exact‑once submission via `requestId`. Ideale per processi aziendali che sono conversazioni lunghe con tool.

**Costo ops.** Molto basso rispetto a Temporal: libreria TypeScript + SQLite/Postgres, un processo (o un processo per tenant). On‑prem PMI‑friendly. Rischio: API sperimentale → breaking change.

**Verdetto per Buildrs.** **Candidato centrale per il runtime durable della piattaforma.** Allinea “agente sempre attivo + processi lunghi + multi‑client (Telegram + futura app)” meglio di un workflow engine generico. Il prezzo da pagare è la giovinezza dell’API e il lavoro di tenancy/integrazioni da fare sopra.

---

### 2.3 Mastra (Kepler Software / mastra.ai)

**Cosa fa.** Framework TypeScript per agenti e applicazioni AI: agent loop, workflow, memoria, eval, studio locale, osservabilità, adapter server, storage composito. Supporto AI SDK v6. Annuncio 1.0 stabile: 20 gennaio 2026 ([Announcing Mastra 1.0](https://mastra.ai/blog/announcing-mastra-1)). Adozione dichiarata in produzione (Replit, PayPal, Sanity, ecc.) e ~300 k download npm settimanali (blog 1.0; cifra non ri‑verificata oggi su npm).

**Maturità.** Repo [mastra-ai/mastra](https://github.com/mastra-ai/mastra). GitHub API 15 ott 2026: ~28 834 stelle, ~2 987 fork, ~580 issue. Release recente `@mastra/core@1.77.0` (14 ott 2026). Creato agosto 2024. Più “product framework” maturo di Pi Durable; meno specializzato sulla durabilità fine‑grained del singolo tool call.

**Licenza (critica).** Dual license ([docs](https://mastra.ai/docs/license), `LICENSE.md`):

- Core e maggioranza del codice: **Apache‑2.0**.
- Directory `ee/` (es. `@mastra/core/auth/ee`, `agent-builder/ee`, `@mastra/editor/ee`): **Mastra Enterprise License**: source‑available; in produzione serve licenza enterprise; libero per sviluppo/test.

Per una piattaforma open source rivendibile/on‑prem: il core Apache va bene; **auth multi‑utente, agent builder ed editor EE non si possono shippare in produzione senza accordo commerciale** (salvo riscrivere quelle parti).

**Multi‑tenant.** Mastra punta a cloud/admin multi‑project (roadmap discussa pubblicamente su HN al momento del 1.0). RBAC e pezzi admin sono nell’area EE. Buildrs può fare tenancy propria sul core Apache.

**Integrazioni.** Tool, MCP (ecosistema), AI SDK providers. Non sostituisce un connector hub (Nango/Composio/Activepieces).

**Durabilità.** Workflow e storage, ma non lo stesso modello “ogni tool call è un task checkpointato con replay policy” di Pi Durable. Mastra e Pi Durable si sovrappongono parzialmente sul concetto di agent runtime.

**Costo ops.** Tipico stack Node + DB; Cloud Mastra in beta (secondo materiale pubblico). Self‑host del core Apache è realistico.

**Verdetto per Buildrs.** Ottimo come **framework di prodotto TypeScript** (API agent, workflow ad alto livello, eval, studio) **se** si resta sul core Apache e si costruiscono auth/builder in casa (o si paga EE). Non sostituisce Pi Durable sul problema “agente long‑running che non muore a metà tool”. Può convivere: Mastra per definizione agenti/eval/UI; Pi Durable come motore di esecuzione durable: oppure scegliere **solo Pi Durable** come runtime e limitare Mastra per non duplicare astrazioni.

---

### 2.4 Riferimenti brevi: Temporal, Inngest, Restate, DBOS

Servono se Buildrs ha **workflow business** lunghi fuori dal ciclo conversazionale dell’agente (fatturazione batch, sync notturni, saga tra sistemi). Non sono harness agentici.

| Motore | Licenza (verificata) | Forma self‑host | Nota per Buildrs |
|--------|----------------------|-----------------|------------------|
| **Temporal** | Server MIT ([temporalio/temporal](https://github.com/temporalio/temporal), ~23.7 k★) | Cluster multi‑servizio + DB | Gold standard enterprise; ops pesanti per PMI on‑prem. |
| **Inngest** | Server **SSPL** + future Apache dopo 3 anni ([LICENSE.md](https://github.com/inngest/inngest/blob/main/LICENSE.md)); SDK npm `inngest` **Apache‑2.0** | Binario + Postgres/Redis | SSPL: offrire il motore come servizio a terzi è giuridicamente delicato; per piattaforma OSS rivenduta è un rischio. |
| **Restate** | Server **BSL 1.1**, Change License Apache dopo 4 anni; Additional Use Grant permette uso interno e prodotti con GUI/DSL che **non** espongono le API Restate a terzi ([LICENSE](https://github.com/restatedev/restate/blob/main/LICENSE)) | Singolo binario | Usabile dentro il prodotto Buildrs se non si rivende Restate “nudo”. |
| **DBOS Transact** | Libreria **MIT** (es. [dbos-transact-ts](https://github.com/dbos-inc/dbos-transact-ts)); Conductor a pagamento ([pricing](https://www.dbos.dev/dbos-pricing)) | App + Postgres | Ops minime; ottimo se serve durable **fuori** dall’agente. Pro $99/mese per Conductor gestito. |

**Con Pi Durable in casa, un secondo motore durable non è necessario nelle prime 4 settimane.** Si rivaluta solo se emergono job non‑agentici (ETL, billing) che non vogliono vivere come task Pi.

---

### 2.5 Altri pezzi rilevanti (integrazioni e canali)

**Composio**: [ComposioHQ/composio](https://github.com/ComposioHQ/composio), MIT, ~30.6 k★. Toolkits, auth, workbench per agenti. Utile per collegare velocemente Gmail/CRM; valutare lock‑in cloud vs self‑host (dettaglio self‑host **non verificato in questa passata** oltre alla licenza MIT del repo).

**Activepieces**: [activepieces/activepieces](https://github.com/activepieces/activepieces), core **MIT**, pezzi `packages/ee/` commerciali; ~25 k★. Automazione + MCP server. Buon candidato self‑host per workflow no‑code accanto agli agenti.

**Nango**: [NangoHQ/nango](https://github.com/NangoHQ/nango), **Elastic License 2.0**: si può embeddare/self‑host, **non** offrire Nango come managed service a terzi. Self‑host free limitato ad Auth+Proxy; sync/MCP/RBAC pieni richiedono Enterprise ([docs self‑hosting](https://nango.dev/docs/guides/platform/self-hosting/self-hosting)). Per una piattaforma OSS che *rivende* connector come feature, ELv2 è accettabile solo se Buildrs non sta “offrendo Nango”; conviene Composio MIT o connector MCP propri per gestionali italiani.

**Vercel AI SDK**: [vercel/ai](https://github.com/vercel/ai), Apache‑2.0 sul LICENSE, ~27.3 k★. Streaming/UI/provider. Complementare; Pi porta già `pi-ai`.

**LangGraph**: MIT, ~43.3 k★. Forte su grafi Python/TS. Sovrappone Pi Durable/Mastra; non necessario se si sceglie Pi Durable.

**Letta**: Apache‑2.0, ~25.2 k★. Memoria long‑term. Opzionale dopo, se la memoria di prodotto supera documents + compaction di Pi.

**MCP**: protocollo di fatto per tool esterni. Hermes lo usa nativamente; su Pi Durable si integra come bridge tool se serve. Per PMI italiane i gestionali (Fatture in Cloud, TeamSystem, ecc.) raramente hanno MCP pronti: andranno **MCP/connector custom**.

---

## 3. Architettura consigliata

### Principio

**Un solo cervello durable (Pi Durable), un prodotto Buildrs intorno, Hermes solo come agente interno e ispirazione canale, Mastra solo dove accelera senza duplicare il runtime.**

### Layer

1. **Agent runtime (cuore)**: `Harness` Pi Durable per workspace. Extensions Buildrs: CRM, mail, gestionale, approvazioni umane, handoff. Conversazione = unità di lavoro (es. “pratica preventivo #123”). Fork per thread Telegram / escalation.

2. **Durable workflows**: Task Pi Durable per tool e sotto‑processi (triage, sync, checkout‑like). Nessun Temporal/Inngest nel MVP. Eventuale DBOS/Temporal solo per job batch non conversazionali dal mese 2–3.

3. **Memory**: Documents Pi (todo, piano, stato pratica) + transcript + compaction. Indice ricerca su storico (tool `search_history` pattern). Più avanti: pgvector per knowledge base cliente.

4. **Integrazioni / connector**: Interfaccia `Connector` Buildrs (OAuth, refresh, audit). Implementazioni: Gmail/Microsoft Graph, HubSpot/Pipedrive, Fatture in Cloud (o gestionale del primo cliente). Opzionale Composio o Activepieces per i SaaS globali. Credenziali **per tenant** in vault (secret manager), mai nel prompt.

5. **Canali**: Adapter Telegram Bot API → `conversation.submit` / `steer` / notify. Una chat Telegram (o topic) mappa a una conversation Pi. Dopo: app web che usa `viewState`/`watch` (multiplayer già nel modello Pi).

6. **Admin / agent builder**: UI Buildrs: prompt, tool abilitati, connector, allowlist utenti Telegram, policy approvazione. Non dipendere da Mastra EE editor in produzione open source; se si usa Mastra, solo core Apache (definizione agent/workflow/eval).

7. **Observability / eval**: Tracce per conversation/task (OpenTelemetry), costo token da `pi.usage`, suite eval su casi PMI (estrazione lead, bozza email, “non inventare prezzi”). Mastra eval o harness interno.

8. **Model gateway**: `pi-ai` (già nell’ecosistema) con provider multipli e fallback. Policy per‑tenant (modello default, tetto spesa).

9. **Tenancy & isolation**: `Workspace` = storage dedicato (SQLite file o schema Postgres) + processo Harness o routing con lock. Isolamento forte per on‑prem single‑tenant (un Compose per cliente). Multi‑tenant cloud: un Harness per workspace o storage partition + worker pool. Auth: Buildrs (OIDC), non Mastra EE obbligatorio.

10. **On‑prem packaging**: Docker Compose: API Buildrs + worker Pi Durable + Postgres + reverse proxy. Telegram webhook in uscita. Licenza prodotto: codice Buildrs Apache‑2.0 o MIT; dipendenze MIT/Apache (Pi, Composio core, Activepieces core). Evitare di shippare Inngest server o Nango “come servizio”.

### Perché questa combinazione

- **Pi Durable** risolve il problema vero: agenti lunghi, crash mid‑tool, più umani sullo stesso agente, stato app allineato al transcript: con licenza MIT e footprint da PMI.
- **Hermes** evita di reinventare Telegram/skills per l’uso interno Buildrs, senza vincolare il prodotto al modello single‑gateway.
- **Mastra** resta opzionale per velocità su eval/workflow dichiarativi TypeScript, con occhi aperti sulla EE.
- I motori durable generici **non** competono con Pi Durable sul harness; li si aggiunge solo per job non‑agentici.

### Diagramma logico

```text
Telegram / futura App
        │
        ▼
Buildrs Channel Gateway  ──►  Workspace Router (tenant)
        │                           │
        │                           ▼
        │                    Pi Durable Harness
        │                    (conversations, tasks,
        │                     documents, resume)
        │                           │
        │              ┌────────────┼────────────┐
        │              ▼            ▼            ▼
        │         pi-ai models   Extensions   Execution env
        │         (gateway)      (CRM, mail,  (sandbox/VM)
        │                         gestionale)
        │                           │
        └───────────────────────────┼───────────► Vault credenziali per tenant
                                    ▼
                              Postgres / SQLite
                              (transcript + docs)
```

---

## 4. Piano 4 settimane e primo caso d’uso vendibile

### Caso d’uso #1 (vendibile a una PMI italiana)

**“Segreteria commerciale su Telegram”** per uno studio / e‑commerce / distributore:

- Arriva una email di richiesta preventivo (Gmail o Microsoft 365).
- L’agente estrae contatto, prodotto/servizio, urgenza; crea o aggiorna lead sul CRM (HubSpot o Pipedrive: comuni e con API chiare; oppure anagrafica Fatture in Cloud se il cliente già la usa).
- Bozza risposta in italiano, tono del cliente; **non invia** senza approvazione umana su Telegram (pulsanti Approva / Modifica / Scarta).
- Notifica il commerciale su Telegram con riassunto e link alla bozza.
- Registra esito sul CRM e nello storico conversazione (riassumibile, ricercabile).

Perché vende: tempo risparmiato misurabile, rischio basso (human‑in‑the‑loop), Telegram già in uso, niente WhatsApp Business API. Prezzo tipico consulting+SaaS: setup + canone mensile (token a parte o inclusi con cap).

### Settimana 1: Fondamenta

- Repo piattaforma Buildrs (TypeScript), packaging MIT/Apache.
- Pi Durable: Harness su SQLite, `resume()`, una conversation root, un tool idempotente di esempio.
- Tenant stub: `workspaceId` → path storage.
- Telegram bot: ricevi messaggio → `submit`; rispondi con testo streaming o chunk.
- Model gateway `pi-ai` con un provider e log costi.
- Milestone: da Telegram, l’agente risponde e sopravvive a `kill -9` + restart riprendendo il tool.

### Settimana 2: Connector e approvazioni

- Extension `mail`: lettura inbox (Gmail API o Graph), tool `replay: "safe"`.
- Extension `crm`: create/update lead (HubSpot o Pipedrive).
- Hook/tool approvazione: prima di `send_email`, memo durable + messaggi inline Telegram.
- Documents: stato pratica `{ leadId, draftId, status }`.
- Milestone: email di test → lead CRM → bozza → approve su Telegram → (opzionale) send.

### Settimana 3: Prodotto minimo per un cliente pilota

- Admin grezzo: collegante OAuth, system prompt cliente, allowlist Telegram user id.
- Compaction + ricerca storico pratica.
- Observability: log conversation id, token, esito pratica.
- Eval manuale su 20 email reali anonimizzate (precisione estrazione, allucinazioni prezzi).
- Milestone: un cliente pilota in staging con i suoi account.

### Settimana 4: Pacchetto vendibile

- Docker Compose on‑prem / VPS.
- Runbook installazione, backup SQLite/Postgres, rotazione secret.
- Pricing one‑pager Buildrs (setup + retainer).
- Demo registrata + checklist go‑live.
- Decisione go/no‑go su Mastra (solo eval) e su secondo connector gestionale italiano.
- Milestone: primo contratto pilota firmabile (anche a prezzo simbolico) con SLA “bozze, non invii autonomi”.

---

## 5. Rischi e cosa evitare

**Rischi**

1. **API Pi Durable sperimentale**: breaking change tra minor. Mitigazione: pin di versione, adapter Buildrs sottile intorno a `Harness`, test di ripresa crash in CI, budget per upgrade.
2. **Confondere Hermes con la piattaforma**: Hermes eccelle come agente personale; forzarne il multi‑tenant SaaS costa mesi e lascia Buildrs inseguire upstream. Mitigazione: Hermes per Buildrs ops; prodotto = codice proprio su Pi Durable.
3. **Licenze che bloccano la rivendita OSS**: Inngest SSPL (server), Nango ELv2 (no managed service), Mastra EE (auth/builder), Restate BSL (ok dentro prodotto con astrazione, non come platform Restate pubblica). Mitigazione: stack MIT/Apache sul percorso critico.
4. **Allucinazioni su prezzi/disponibilità**: in ambito commerciale italiano è rischio legale e reputazionale. Mitigazione: tool solo lettura catalogo; invio email solo con approve; eval continue.
5. **Credenziali tenant**: un leak cross‑tenant uccide il business. Mitigazione: vault, isolation storage, mai loggare token, allowlist Telegram stretta.
6. **Scope creep gestionali**: ogni PMI ha un ERP diverso. Mitigazione: un solo CRM + una sola casella mail nel pilota; gestionale custom solo a progetto a pagamento.
7. **Stelle GitHub come metrica**: sia Hermes sia Pi mostrano conteggi API molto alti per l’età; non usarli come prova di maturità enterprise. Contano release notes, licenza, ops e se l’API fa il lavoro durable.

**Cosa evitare**

- Riscrivere un Temporal “perché sì” nelle prime 4 settimane.
- Basare il prodotto su pezzi Mastra EE senza contratto.
- Offrire WhatsApp “dopo una settimana” (compliance e API).
- Autonomia totale sull’invio email al cliente finale nel MVP.
- Dipendere da Nango Cloud senza piano se il messaggio commerciale è “100% open source on‑prem”.
- Promettere multi‑tenant hardened senza isolation testata.
- Mettere secret LLM o OAuth nel git (processo e secret scanning obbligatori).

---

## 6. Raccomandazione esecutiva (una pagina)

Per Buildrs, la mossa giusta è:

1. **Runtime:** Pi Durable (MIT) come harness durable centrale.  
2. **Prodotto e tenancy:** codice Buildrs sopra Pi (Telegram, vault, admin, connector).  
3. **Hermes:** agente interno Buildrs + lezioni su gateway/skills; non il kernel SaaS.  
4. **Mastra:** opzionale e solo core Apache (eval/workflow); niente EE in produzione OSS senza deal.  
5. **Motori tipo Temporal/Inngest/Restate/DBOS:** solo riferimento; nessun obbligo nel MVP se Pi Durable tiene conversazioni e task.  
6. **Primo soldo:** segreteria commerciale email+CRM+Telegram con human approve, in 4 settimane, Compose on‑prem.

Questa architettura è allineata a un’agenzia che vende e installa per PMI: footprint piccolo, licenze pulite, storia credibile (“l’agente non perde il lavoro se il server si riavvia”), e una strada chiara verso un’app multiplayer usando il modello già presente in Pi Durable.

---

## Fonti primarie (estratto)

- https://earendil.com/posts/pi-durable/  
- https://earendil.com/posts/pi-1-0/  
- https://github.com/earendil-works/pi (LICENSE MIT; API metadata 15 ott 2026)  
- https://github.com/earendil-works/pi/blob/main/packages/durable/README.md  
- https://www.npmjs.com/package/@earendil-works/pi-durable (v1.3.0, MIT)  
- https://github.com/NousResearch/hermes-agent  
- https://hermes-agent.nousresearch.com/docs/getting-started/quickstart  
- https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways  
- https://github.com/mastra-ai/mastra + https://mastra.ai/docs/license + https://mastra.ai/blog/announcing-mastra-1  
- https://github.com/temporalio/temporal  
- https://github.com/inngest/inngest/blob/main/LICENSE.md + npm `inngest` Apache‑2.0  
- https://github.com/restatedev/restate/blob/main/LICENSE  
- https://github.com/dbos-inc/dbos-transact-ts + https://www.dbos.dev/dbos-pricing  
- https://github.com/NangoHQ/nango/blob/master/LICENSE (Elastic 2.0)  
- https://nango.dev/docs/guides/platform/self-hosting/self-hosting  
- https://github.com/activepieces/activepieces/blob/main/LICENSE  
- https://github.com/ComposioHQ/composio  
- https://github.com/vercel/ai/blob/main/LICENSE (Apache‑2.0)  

*Fine analisi.*
