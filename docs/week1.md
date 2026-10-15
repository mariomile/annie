# Settimana 1: nucleo durevole, multi-tenant, Telegram

Branch `week1-core`. Dettagli di design in [`architettura.md`](architettura.md).

## Cosa funziona (verificato dai test)

- **Nucleo multi-tenant**: `AnnieRuntime` con registry di tenant e istanze, un file SQLite Pi Durable per istanza in `data/tenants/<t>/instances/<i>/engine/`.
- **Crash e ripresa**: `test/crash-resume.test.ts` avvia un processo figlio, gli fa contare fino a 6 con il tool `slow_counter`, lo uccide con `SIGKILL` dopo il checkpoint dello step 3, avvia un secondo processo sullo stesso storage e chiama `resume()`. Il run completa con la risposta "Fatto. Ho contato fino a 6." e il log degli effetti mostra ogni step eseguito una volta sola: 1-3 dal primo processo, 4-6 dal secondo. Ripetuto 5 volte di fila senza fallimenti.
- **Modello finto deterministico**: pi-ai 1.3.0 include un faux provider. L'adapter lo usa come modello `faux/annie-dev`, che decide la risposta solo in base al transcript: per questo un nuovo processo dopo il crash continua esattamente da dove era. Nessuna chiave e nessuna rete nei test.
- **Isolamento tra tenant**: due tenant con la stessa istanza e lo stesso thread non vedono storage, segreti, chiavi modello e audit l'uno dell'altro (`test/isolation.test.ts`, controlla anche i byte su disco).
- **Egress default deny**: istanza senza policy non apre il modello; provider non consentito rifiutato; canale non consentito rifiutato prima del motore; con modello locale zero chiamate `fetch` (`test/egress.test.ts`).
- **Telegram**: adapter long polling con `fetch`, normalizzazione in `InboundMessage`, offset, invio spezzato a 4096 caratteri, errori senza token, start/stop, flusso completo Telegram → nucleo → Telegram, messaggio riconsegnato che non produce una seconda risposta. Tutto con `fetch` finto (`test/telegram.test.ts`). Nessuna chiamata all'API Telegram reale.
- **Configurazione**: variabili mancanti riportate per nome esatto, processo con exit code 1.
- **Confini dei moduli**: test che fallisce se Pi viene importato fuori da `src/core/adapters/pi-durable*` o se il nucleo importa dai canali.

## Decisioni

- **Requisiti architetturali nuovi al posto di `openWorkspace`**: il "workspace" del brief originale è diventato la coppia tenant/istanza. `openInstance(tenantId, instanceId)` corrisponde a `openWorkspace`, con storage in `data/tenants/<t>/instances/<i>/` invece di `data/<workspaceId>/`. `submit`, `resume()` e `onReply` sono rimasti, con il thread del canale al posto del `conversationId` libero.
- **Checkpoint degli step con `api.memo()`** di Pi Durable: memo durevole e first-writer-wins legato al task del tool. Esposto ai tool come `ctx.step(key, work)`, senza far trapelare Pi.
- **Nessuna chiave dall'ambiente dentro il motore**: pi-ai riceve un `CredentialStore` nostro che legge solo il secret store del tenant e un `authContext` vuoto. `pnpm dev:telegram` copia la chiave da `.env` nel secret store del tenant all'avvio.
- **Modello predefinito**: Anthropic `claude-sonnet-5-5` (provider `anthropic` di pi-ai). Supportati anche `openai` e `faux`.
- **Telegram senza librerie**: Bot API via `fetch`, niente grammy. Una dipendenza in meno, l'adapter è circa 150 righe.
- **Audit solo metadati**: mai testo di messaggi o risposte nell'audit.
- **TypeScript 7 / vitest 5**, ESM, `strict` più `noUncheckedIndexedAccess`.

## Cosa manca

- **Lock tra processi**: Pi Durable non impedisce a due processi di aprire lo stesso storage. Serve un lock file per istanza prima di qualunque deploy.
- **Segreti cifrati a riposo**: oggi JSON con permessi 0600.
- **Token Telegram per tenant**: oggi un token di processo, quindi un bot per processo.
- **Allowlist utenti Telegram**: oggi chiunque trovi il bot può scrivergli e consumare la chiave del modello del tenant.
- **Test con modello reale**: il provider Anthropic non è stato provato con una chiave vera (nessuna chiave disponibile in questa sessione). Il cablaggio delle credenziali è verificato sul codice di pi-ai e con un test sul passaggio della chiave, non con una chiamata reale.
- **Streaming e risposte parziali** verso i canali, **azioni strutturate** (pulsanti di approvazione), **dashboard owner**, altri canali: progettati in `architettura.md`, non implementati.
- **Upgrade di Pi Durable**: nessuna procedura di migrazione dello storage oltre al test crash-resume come gate.
- **Warning `node:sqlite` sperimentale** a runtime su Node 22.

## Comandi

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev:telegram   # richiede .env, vedi README
```
