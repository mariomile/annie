# Architettura di Annie

Annie è un agente sempre attivo, sul modello di Hermes Agent, pensato per aziende attente a privacy e controllo dei processi: self-host o on-prem, multi-tenant, nessun dato in uscita senza una configurazione esplicita. Il runtime durevole è Pi Durable (`@earendil-works/pi-durable`, MIT, sperimentale), nascosto dietro un'interfaccia nostra.

Stato: settimana 1. Questo documento descrive cosa c'è nel codice oggi e cosa è solo progettato. Dove una cosa non è ancora implementata è scritto esplicitamente.

## 1. Mappa

```text
                Owner (futura dashboard)
                        │ TenantRegistry
                        ▼
   ┌──────────────── src/core ─────────────────────────────────────┐
   │ AnnieRuntime                                                   │
   │   ├─ TenantRegistry   tenant.json, instance.json               │
   │   ├─ TenantSecrets    secrets.json (0600) per tenant           │
   │   ├─ AuditLog         audit.jsonl append-only per tenant       │
   │   ├─ EgressPolicy     default deny: provider modello + canali  │
   │   └─ AnnieInstance ──► DurableEngine (interfaccia)             │
   │                           ▲                                    │
   │        src/core/adapters/pi-durable*.ts (unico import di Pi)   │
   └────────────────────────────────────────────────────────────────┘
                        ▲ submit / onReply
                        │
                 src/gateway.ts  (unico modulo che conosce core e canali)
                        │ onInbound / send
                        ▼
   src/channels/types.ts   ChannelAdapter, InboundMessage, OutboundMessage
   src/channels/telegram.ts  (implementato)
   web app, desktop, API/webhook, mobile  (solo interfaccia, sezione 6)
```

Regole verificate da `test/boundaries.test.ts`:

- Solo `src/core/adapters/pi-durable*.ts` importa pacchetti `@earendil-works/*`.
- `src/core` non importa nulla da `src/channels`.

## 2. Modello: Owner, Tenant, Instance

- **Owner**: chi installa e gestisce Annie (Buildrs o il reparto IT del cliente on-prem). Oggi agisce via codice sul `TenantRegistry`; in futuro tramite una dashboard owner che userà la stessa API.
- **Tenant**: un cliente. Confine di isolamento per dati, segreti, memoria e audit.
- **Instance**: un agente di un tenant. Ha il suo modello, la sua egress policy, le sue istruzioni e il suo storage durevole. Un tenant può avere più istanze (es. "segreteria commerciale" e "assistente interno").

### Layout su disco

```text
data/
  tenants/<tenantId>/
    tenant.json
    secrets.json                 mode 0600
    audit.jsonl                  append-only
    instances/<instanceId>/
      instance.json              modello, egress policy, istruzioni
      engine/pi-durable.sqlite   storage Pi Durable dedicato (WAL)
```

Gli ID di tenant e istanza diventano nomi di directory, quindi sono validati (`a-z0-9_-`, max 63 caratteri, niente punti né separatori): un ID come `../altro` viene rifiutato (testato).

## 3. Interfacce

### Nucleo (`src/core`)

```ts
class AnnieRuntime {
  registry: TenantRegistry;                       // createTenant, createInstance, get/list
  secrets(tenantId): TenantSecrets;               // legato a un solo tenant
  audit(tenantId): AuditLog;                      // legato a un solo tenant
  openInstance(tenantId, instanceId): Promise<AnnieInstance>;
  submit(req: SubmitRequest): Promise<{ submissionId }>;
  resume(tenantId, instanceId): Promise<{ pending }>;
  onReply(listener: (reply: Reply) => void): () => void;
  close(): Promise<void>;
}

type SubmitRequest = { tenantId, instanceId, channel, threadId, userId, text, messageId? };
type Reply = { tenantId, instanceId, channel, threadId } &
  ({ status: "answered"; text } | { status: "unanswered"; reason });
```

`SubmitRequest` ha la stessa forma di `InboundMessage` dei canali, ma è definito nel nucleo: il nucleo non dipende dai canali, il gateway passa l'uno all'altro.

### Motore durevole (`src/core/engine.ts`)

```ts
interface DurableEngine { open(options: EngineOpenOptions): Promise<EngineSession> }

type EngineOpenOptions = {
  storageDir;                                   // directory esclusiva dell'istanza
  model: { provider, modelId };
  apiKey: (provider) => Promise<string | undefined>;   // unica fonte di credenziali
  tools: AnnieTool[];
  instructions?;
};

interface EngineSession {
  submit(threadKey, text, requestId?): Promise<{ submissionId }>;  // ammesso in modo durevole
  resume(): Promise<{ pending }>;
  onReply(listener): () => void;
  idle(): Promise<void>;
  close(): Promise<void>;
}

type AnnieTool = {
  name; description; parameters /* JSON Schema */;
  replaySafe: boolean;
  execute(args, ctx: { step(key, work), progress(text), signal }): Promise<string>;
};
```

`ctx.step(key, work)` è il checkpoint durevole di un tool: esegue `work` al massimo una volta per chiamata e chiave, e dopo un crash restituisce il risultato salvato senza rieseguirlo. Nell'adapter è implementato con `api.memo()` di Pi Durable (memo durevole, first-writer-wins, legato al task del tool).

### Canali (`src/channels/types.ts`)

```ts
interface ChannelAdapter {
  name: string;                          // "telegram", ...
  start(): Promise<void>;
  stop(): Promise<void>;
  onInbound(handler: (m: InboundMessage) => Promise<void>): void;
  send(m: OutboundMessage): Promise<void>;
}
type InboundMessage  = { tenantId, instanceId, channel, threadId, userId, text, messageId? };
type OutboundMessage = { tenantId, instanceId, channel, threadId, text };
```

## 4. Flussi

### Messaggio in arrivo e risposta

```text
Telegram getUpdates ─► TelegramAdapter ─► InboundMessage
  ─► gateway ─► AnnieRuntime.submit
       ├─ egress: il canale è consentito?        no ─► EgressDenied + audit "egress.denied"
       ├─ audit "message.received" (solo metadati: canale, thread, utente, lunghezza)
       └─ EngineSession.submit(threadKey = "telegram:<chatId>", text, requestId = "telegram:<chatId>:<messageId>")
            ├─ conversazione Pi per threadKey (creata al primo messaggio, mappa salvata nello stesso commit)
            └─ conversation.submit(): ammissione durevole, poi generazione e tool come task Pi
  ◄─ onReply ◄─ submission.wait() ◄─ risposta del modello
       ├─ egress: il canale è ancora consentito? (secondo controllo, in uscita)
       └─ audit "reply.emitted"
  ─► gateway ─► TelegramAdapter.send ─► sendMessage (spezzato a 4096 caratteri)
```

Un messaggio riconsegnato da Telegram (stesso `message_id`, es. dopo un crash prima della conferma dell'offset) produce lo stesso `requestId`: Pi Durable lo riconosce e non c'è una seconda risposta (testato).

### Crash e ripresa

```text
processo A: submit("conta fino a 6") ─► pi.generation ─► tool slow_counter (replay: "safe")
            step 1 ✓ memo, step 2 ✓ memo, step 3 ✓ memo, ── SIGKILL ──
processo B: openInstance ─► Harness.open(stesso SQLite) ─► resume()
            harness.resume() riparte dallo stato salvato; inspect() trova la submission aperta
            il tool riparte: step 1-3 letti dai memo, step 4-6 eseguiti ─► risposta ─► onReply
```

Verificato da `test/crash-resume.test.ts` con due processi figli reali e `SIGKILL`. Garanzia: at-least-once per step. Uno step il cui lavoro è finito ma il cui memo non è stato ancora scritto al momento del crash viene rieseguito; i tool con effetti esterni devono quindi essere idempotenti anche dentro lo step (es. chiave di idempotenza verso il CRM).

## 5. Isolamento ed egress

### Isolamento per tenant

| Risorsa | Come è isolata | Test |
|---|---|---|
| Storage conversazioni e task | un file SQLite Pi Durable per istanza, sotto la directory del tenant | `isolation.test.ts`: i byte su disco di un tenant non contengono dati dell'altro |
| Segreti | `TenantSecrets` è costruito per un solo tenant e legge solo il suo file (0600) | stesso test |
| Chiavi modello | l'engine riceve solo una funzione `apiKey` che legge i segreti del tenant dell'istanza | `isolation.test.ts`: acme riceve la sua chiave, mai quella di globex |
| Audit | un `audit.jsonl` per tenant; ogni record porta il `tenantId` | stesso test |
| Memoria | per ora la memoria è il transcript Pi dell'istanza, quindi segue lo storage | |

L'isolamento oggi è di processo condiviso: più tenant possono girare nello stesso processo Node, separati da file e API. Per clienti che lo richiedono, il deployment consigliato è un processo (o container) per tenant, con lo stesso layout. Con un container per tenant l'isolamento diventa anche di sistema operativo.

### Egress policy (default deny)

```ts
type EgressPolicy = { modelProviders: string[]; channels: string[] };   // vuoto = nulla
```

- Un'istanza creata senza policy ha `{ modelProviders: [], channels: [] }` e non può aprire alcun modello (testato).
- **Modello**: all'apertura dell'istanza il provider configurato deve essere nella lista, altrimenti `EgressDenied` e audit. Nell'adapter Pi viene registrato solo quel provider in pi-ai, e pi-ai riceve un `authContext` vuoto: nessuna chiave da variabili d'ambiente o file di credenziali locali, solo dal secret store del tenant (verificato sul codice di pi-ai 1.3.0: una credenziale salvata ha precedenza e le fonti ambientali sono lette solo tramite `authContext`).
- **Canali**: un messaggio da un canale non consentito è rifiutato prima di arrivare al motore (testato); una risposta verso un canale non consentito non viene emessa.
- Con il modello locale `faux` un'intera conversazione con tool non fa alcuna chiamata di rete (testato con `fetch` intercettato).

Limiti attuali, da sapere:

- La policy controlla chi Annie contatta tramite i suoi moduli. Non è un firewall: un tool scritto male potrebbe aprire connessioni proprie. Per garanzie forti serve anche un controllo di rete a livello di deployment (egress firewall del container).
- La policy è letta all'apertura dell'istanza: una modifica a `instance.json` vale dal riavvio successivo.
- pi-ai rispetta `HTTPS_PROXY`/`HTTP_PROXY` dell'ambiente: in un deployment con proxy, il proxy vede le richieste verso il provider consentito.
- Il canale Telegram usa un token di processo (`TELEGRAM_BOT_TOKEN`), non un segreto per tenant: un bot per processo.

## 6. Roadmap canali

Ogni canale è un `ChannelAdapter` con un `name` che la policy dell'istanza deve consentire. Nessuno dei seguenti è implementato.

| Canale | Forma prevista | Note |
|---|---|---|
| Telegram | long polling Bot API (fatto) | webhook in uscita quando serve scalare |
| API / webhook | server HTTP: `POST /v1/tenants/:t/instances/:i/threads/:thread/messages`, risposta via webhook firmato o polling | primo canale enterprise: integrazione con sistemi interni |
| Web app | adapter che espone thread via HTTP + streaming (SSE/WebSocket) | Pi Durable ha `viewState()`/`watch()` per seguire una conversazione dal vivo e più client sulla stessa conversazione; servirà estendere `EngineSession` con un'operazione di osservazione |
| Desktop | stessa API della web app, client nativo | nessun adapter separato se parla con l'API |
| Mobile | stessa API, notifiche push come canale di uscita | push = adapter solo `send` |

Due estensioni previste dell'interfaccia, da fare quando arriva il primo canale che le richiede: streaming di risposte parziali e azioni strutturate (pulsanti Approva/Scarta per l'human-in-the-loop del caso d'uso segreteria commerciale).

## 7. Rischi di Pi Durable sperimentale

| Rischio | Mitigazione in atto |
|---|---|
| API che cambia senza preavviso tra release (README: "Experimental") | versione pinnata esatta (`1.3.0`, anche `pi-ai` e `chord`); tutto il codice Pi in un adapter (~280 righe in due file); `DurableEngine` è nostra; test di confine che impedisce import di Pi altrove |
| Formato dello storage che cambia tra versioni | un upgrade va provato su una copia di `data/`; test crash-resume come gate di upgrade. Nessuna migrazione automatica per ora |
| Un solo processo per storage, nessun lock tra processi (README Pi) | un'istanza deve girare in un solo processo. Non c'è ancora un lock file nostro: due processi sulla stessa istanza corromperebbero lo stato. Da aggiungere prima del deploy |
| `node:sqlite` è sperimentale in Node 22 (warning a runtime) | Node 22.19+ richiesto dal pacchetto; valutare Node 24 LTS |
| Replay dei tool: at-least-once, non exactly-once | `replaySafe` esplicito per tool; i tool con effetti esterni devono essere idempotenti; i tool non ripetibili (invio email) restano `replaySafe: false` e il modello riceve un risultato "interrupted" |
| Comportamento di `resume()`: lo scheduler riparte anche al primo `submit` | `resume()` di Annie va chiamato all'avvio prima di accettare messaggi, per riagganciare le risposte in sospeso ai canali |
| Progetto giovane, numeri GitHub anomali (vedi piano iniziale) | dipendiamo da poche primitive (Harness, conversation, submit/wait, tool con memo, SQLite storage); sostituibili dietro `DurableEngine` se necessario |

## 8. Decisioni e alternative scartate

- **Un'istanza = uno storage Pi Durable**, non un Harness condiviso con una conversazione per tenant: isolamento fisico dei dati, backup e cancellazione per istanza con un `rm -r`, ed è coerente con il modello "un processo possiede uno storage" di Pi.
- **Thread del canale → conversazione Pi**, mappa salvata come documento Pi di sessione nello stesso commit che crea la conversazione: non può puntare a una conversazione inesistente.
- **Segreti in JSON 0600 non cifrato**: sufficiente per self-host su macchina del cliente nella settimana 1. Prossimo passo: cifratura a riposo con chiave fornita dall'owner (o KMS/Vault del cliente) dietro la stessa classe.
- **Audit senza contenuti**: l'audit registra metadati (chi, dove, quanti caratteri, esito), mai testo dei messaggi o risposte. Il contenuto vive solo nello storage dell'istanza.
- **Modello predefinito**: Anthropic `claude-sonnet-5-5` via pi-ai. Il provider `faux` (modello locale deterministico di pi-ai, nessuna rete, nessuna chiave) serve per test e sviluppo.
