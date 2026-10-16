# Stato del progetto e cose da fare

Aggiornato al 15 ottobre 2026. Lavoro ripreso su richiesta di Mario dopo la pausa decisa da lui.

## Dove siamo

Su `main` ci sono le settimane da 1 a 5 (la 4 e la 5 dal 16 ottobre 2026), e la CI controlla ogni PR con typecheck, test ed eval deterministiche. La settimana 6 è sul branch `week-6`.

- Settimana 1: nucleo durevole su Pi Durable dietro un adapter, multi-tenant, canale Telegram ([week1.md](week1.md)).
- Settimana 2: allowlist degli utenti per istanza, lock dell'istanza e outbox persistente delle risposte ([week2.md](week2.md)).
- CI: typecheck, test ed eval su ogni PR, con la regola di un PR per settimana ([contributing.md](contributing.md)).
- Settimana 3: logica della segreteria commerciale (pratiche, approvazione obbligatoria, routing dei modelli, tetti di spesa, 35 eval), provata solo con fake ([week3.md](week3.md), [spec](spec-segreteria-commerciale.md)).
- Settimana 5 (branch `week-5`, parte da `week-4`): agente generale (connettori MCP, file, task programmati, tool proposti in sandbox con approvazione), console web, processo unico `pnpm start`, Docker e runbook ([week5.md](week5.md), [prodotto finito](prodotto.md)).
- Settimana 4 (branch `week-4`): segreteria funzionante end-to-end. `pnpm dev:segreteria` con Gmail e HubSpot live, pulsanti su Telegram, estrazione con Haiku e bozza con Sonnet sotto i controlli della CI, avviso doppioni, giudice notturno sulla pipeline vera ([week4.md](week4.md)).

Documenti di riferimento: [piano iniziale](piano-iniziale.md), [architettura](architettura.md).

## Cose da fare

### Per la prova reale (servono i segreti di Mario)

- [ ] Un bot Telegram dedicato alla segreteria (da @BotFather), diverso da quello di `dev:telegram`
- [ ] Chiave Anthropic
- [ ] Client OAuth Google e refresh token con scope `gmail.readonly` e `gmail.send` (app in modalità «Testing»: il refresh token scade dopo 7 giorni)
- [ ] Token di una private app HubSpot con scope `crm.objects.contacts.read` e `crm.objects.contacts.write`
- [ ] User ID Telegram dei commerciali in `ANNIE_TELEGRAM_ALLOWED_USERS`; ognuno apre il bot e preme Start
- [ ] `ANNIE_JUDGE_MODEL_KEY` tra i secret del repo, per il giudice notturno
- [ ] Verifiche dal vivo: Gmail conserva il nostro `Message-ID`? Valori di `hs_lead_status` del portale (`GET /crm/v3/properties/contacts/hs_lead_status`). Costo per pratica (stima da verificare: 1-2 centesimi di dollaro). Primo report del giudice

### Decisioni che spettano a Mario

- [x] Licenza: Apache-2.0, confermata da Mario il 16 ottobre 2026
- [x] Merge di `week-4` e `week-5` su `main`, con l'ok di Mario il 16 ottobre 2026 (#3 `e5f9f4f`, #4 `a55e9f0`)

### Dopo (proposta)

- [x] Ritentativi nello stesso processo, con backoff, per risposte e schede (risposte: settimana 6; schede: a ogni giro dalla settimana 4)
- [x] Pulizia delle outbox: le risposte consegnate da più di 30 giorni si cancellano all'apertura dell'istanza (settimana 6). I file del workspace non si cancellano da soli: sono dati delle persone, li toglie chi li gestisce
- [ ] Sandbox sotto un utente di sistema separato, o in container. Fatto il primo passo (settimana 6): il container di Annie gira con filesystem in sola lettura, senza capability Linux e senza escalation di privilegi, e la sandbox eredita questi limiti. Resta un utente separato per i tool proposti
- [x] Creare istanze dalla console (branch `week-6`, vedi [week6.md](week6.md))
- [x] 2FA per la console: verifica in due passaggi facoltativa con app di autenticazione (settimana 6)

### Prima di rendere pubblico il repo

- [x] LICENSE (Apache-2.0, confermata)
- [x] Runbook per installazione e operatività ([runbook.md](runbook.md))
- [x] Action della CI su Node 24 (`checkout`, `setup-node`, `upload-artifact` v5). Resta `pnpm/action-setup@v4`: da verificare alla prima PR se dà ancora l'avviso

## Chi fa cosa

Craft segue prodotto ed esperienza, Ship codice, PR, CI e merge (su `main` solo con l'ok di Mario), AI Guru stack agenti, Pi Durable, modelli ed eval.
