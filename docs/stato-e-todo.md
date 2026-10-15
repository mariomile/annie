# Stato del progetto e cose da fare

Aggiornato al 15 ottobre 2026. Lavoro ripreso su richiesta di Mario dopo la pausa decisa da lui.

## Dove siamo

Su `main` ci sono le settimane 1, 2 e 3, e la CI controlla ogni PR con typecheck, test ed eval deterministiche. Le settimane 4 e 5 sono sui branch `week-4` e `week-5`, in attesa di PR e dell'ok di Mario.

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

- [ ] Licenza: proposta Apache-2.0 (già nel repo), da confermare
- [ ] Merge di `week-4` e `week-5` su `main` (oggi solo branch)

### Dopo (proposta)

- [ ] Ritentativi nello stesso processo, con backoff, per risposte e schede
- [ ] Pulizia delle outbox e dei file vecchi
- [ ] Sandbox sotto un utente di sistema separato, o in container
- [ ] Creare istanze dalla console (oggi da configurazione)
- [ ] 2FA per la console

### Prima di rendere pubblico il repo

- [x] LICENSE (Apache-2.0, da confermare)
- [x] Runbook per installazione e operatività ([runbook.md](runbook.md))
- [ ] Aggiornare le action della CI oltre Node 20 (oggi danno solo avvisi)

## Chi fa cosa

Craft segue prodotto ed esperienza, Ship codice, PR, CI e merge (su `main` solo con l'ok di Mario), AI Guru stack agenti, Pi Durable, modelli ed eval.
