# Annie

Piattaforma agenti open source di Buildrs: un agente sempre attivo, sul modello di Hermes Agent, per aziende attente a privacy e controllo dei processi. Self-host/on-prem, multi-tenant (un Owner, più Tenant, più Instance per tenant), egress default deny. Nucleo durevole: Pi Durable (`@earendil-works/pi-durable` 1.3.0, sperimentale), dietro un'interfaccia nostra. Telegram è il primo canale.

- Architettura: [`docs/architettura.md`](docs/architettura.md)
- Stato della settimana 1: [`docs/week1.md`](docs/week1.md)
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
# compila TELEGRAM_BOT_TOKEN (da @BotFather) e ANTHROPIC_API_KEY
pnpm dev:telegram
```

Al primo avvio crea il tenant `default` e l'istanza `telegram` in `data/`, con una egress policy che consente solo il provider modello configurato e il canale `telegram`, e salva la chiave del modello nel secret store del tenant. Agli avvii successivi riprende le conversazioni rimaste a metà.

Se manca una variabile il processo esce con il nome esatto, ad esempio:

```text
annie: Missing environment variable: ANTHROPIC_API_KEY. Set it in .env (see .env.example).
```

Per provare senza chiave del modello: `ANNIE_MODEL_PROVIDER=faux` usa il modello locale deterministico (risponde con un'eco; "conta fino a 5" chiama il tool `slow_counter`). Il token Telegram resta necessario.

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

## Struttura

```text
src/core/                     nucleo: runtime, tenant/instance registry, segreti, audit, egress policy
src/core/engine.ts            interfaccia DurableEngine
src/core/adapters/pi-durable* unico punto che importa Pi Durable / pi-ai
src/core/tools/               tool di esempio (slow_counter)
src/channels/types.ts         interfaccia ChannelAdapter
src/channels/telegram.ts      adapter Telegram (long polling, fetch)
src/gateway.ts                collega canali e nucleo
src/main/telegram.ts          entry point di pnpm dev:telegram
test/                         crash-resume, isolamento, egress, Telegram, confini dei moduli
```
