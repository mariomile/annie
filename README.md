# Annie

Piattaforma agenti open source di Buildrs: un agente sempre attivo, sul modello di Hermes Agent, per aziende attente a privacy e controllo dei processi. Self-host/on-prem, multi-tenant (un Owner, più Tenant, più Instance per tenant), egress default deny. Nucleo durevole: Pi Durable (`@earendil-works/pi-durable` 1.3.0, sperimentale), dietro un'interfaccia nostra. Telegram è il primo canale.

- Architettura: [`docs/architettura.md`](docs/architettura.md)
- Stato della settimana 1: [`docs/week1.md`](docs/week1.md)
- Stato della settimana 2 (allowlist, lock, outbox): [`docs/week2.md`](docs/week2.md)
- Stato della settimana 3 (segreteria commerciale): [`docs/week3.md`](docs/week3.md)
- Stato della settimana 4 (segreteria end-to-end): [`docs/week4.md`](docs/week4.md)
- **Stato del progetto e cose da fare: [`docs/stato-e-todo.md`](docs/stato-e-todo.md)**
- Come contribuire: [`docs/contributing.md`](docs/contributing.md)
- Piano iniziale: [`docs/piano-iniziale.md`](docs/piano-iniziale.md)

## Requisiti

- Node.js 22.19 o successivo (usa `node:sqlite`)
- pnpm 10

## Avvio

```bash
pnpm install
pnpm typecheck
pnpm test          # nessuna chiave, nessuna chiamata di rete
pnpm build         # compila in dist/
```

### Bot Telegram

```bash
cp .env.example .env
# compila TELEGRAM_BOT_TOKEN (da @BotFather), ANTHROPIC_API_KEY
# e ANNIE_TELEGRAM_ALLOWED_USERS (i tuoi user ID Telegram, separati da virgola)
pnpm dev:telegram
```

Al primo avvio crea il tenant `default` e l'istanza `telegram` in `data/`, con una egress policy che consente solo il provider modello configurato e il canale `telegram`, e salva la chiave del modello nel secret store del tenant. Agli avvii successivi riprende le conversazioni rimaste a metà.

Se manca una variabile il processo esce con il nome esatto, ad esempio:

```text
annie: Missing environment variable: ANTHROPIC_API_KEY. Set it in .env (see .env.example).
```

Per provare senza chiave del modello: `ANNIE_MODEL_PROVIDER=faux` usa il modello locale deterministico (risponde con un'eco; "conta fino a 5" chiama il tool `slow_counter`). Il token Telegram resta necessario.

### Segreteria commerciale

```bash
cp .env.example .env
# oltre alle variabili sopra: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
# HUBSPOT_ACCESS_TOKEN e i commerciali in ANNIE_TELEGRAM_ALLOWED_USERS
pnpm dev:segreteria
```

Legge la casella Gmail ogni minuto, prepara per ogni richiesta di preventivo una scheda con la bozza e la manda su Telegram ai commerciali con i pulsanti Approva, Modifica e Scarta. Nessuna mail parte senza Approva. Serve un bot Telegram diverso da quello di `dev:telegram`, e ogni commerciale deve aprire il bot e premere Start una volta. Dettagli in [`docs/week4.md`](docs/week4.md).

### Variabili d'ambiente

| Variabile | Obbligatoria | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | sì | |
| `ANNIE_MODEL_PROVIDER` | no | `anthropic` (anche `openai`, `faux`) |
| `ANNIE_MODEL_ID` | no | `claude-sonnet-5-5` (`annie-dev` per `faux`) |
| `ANTHROPIC_API_KEY` | se il provider è `anthropic` | |
| `OPENAI_API_KEY` | se il provider è `openai` | |
| `ANNIE_DATA_DIR` | no | `data` |
| `ANNIE_TENANT_ID` | no | `default` |
| `ANNIE_INSTANCE_ID` | no | `telegram` |
| `ANNIE_TELEGRAM_ALLOWED_USERS` | no, ma senza nessuno può scrivere al bot (sì per la segreteria) | nessuno (default deny) |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | per la segreteria | |
| `HUBSPOT_ACCESS_TOKEN` | per la segreteria | |
| `ANNIE_SEGRETERIA_MODEL` | no | `anthropic` (anche `faux`) |
| `ANNIE_SEGRETERIA_INSTANCE_ID` | no | `segreteria` |
| `ANNIE_MAIL_POLL_SECONDS` | no | `60` |
| `ANNIE_REQUIRE_VAT_NUMBER` | no | `false` |

## Struttura

```text
src/core/                     nucleo: runtime, tenant/instance registry, segreti, audit, egress policy
src/core/engine.ts            interfaccia DurableEngine
src/core/adapters/pi-durable* unico punto che importa Pi Durable / pi-ai
src/core/completion.ts        interfaccia ModelClient (chiamate one-shot al modello)
src/core/tools/               tool (slow_counter, mail, CRM, approvazione)
src/channels/types.ts         interfaccia ChannelAdapter
src/channels/telegram.ts      adapter Telegram (long polling, fetch, pulsanti)
src/connectors/               Gmail e HubSpot (REST, fetch con egress), fake per i test
src/segreteria/               pipeline, modello, callback, outbox delle schede, servizio
src/gateway.ts                collega canali e nucleo
src/main/telegram.ts          entry point di pnpm dev:telegram
src/main/segreteria.ts        entry point di pnpm dev:segreteria
evals/segreteria/             35 casi, controlli deterministici (CI), giudice notturno
test/                         crash-resume, isolamento, egress, Telegram, confini, allowlist, lock, outbox, connettori, segreteria
```
