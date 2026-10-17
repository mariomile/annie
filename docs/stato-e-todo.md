# Stato del progetto e cose da fare

Aggiornato al 17 ottobre 2026.

## Dove siamo

Su `main` ci sono le settimane da 1 a 28, e la CI controlla ogni PR con typecheck, test ed eval deterministiche. Le fasi del [piano cloud](piano-cloud.md) sono scritte tutte; dalla settimana 21 si aggiungono funzioni per chi usa Annie ogni giorno (sotto, «Funzioni»). I riassunti delle settimane dalla 6 in poi sono nei loro `weekN.md`.

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
- [x] Sandbox: container di Annie con privilegi minimi, che il processo del tool eredita (settimana 6). L'utente di sistema separato è scartato: richiederebbe di ridare ad Annie i privilegi per cambiare utente ([ADR 0002](adr/0002-tool-proposti-sandbox-e-approvazione.md))
- [x] Creare istanze dalla console (branch `week-6`, vedi [week6.md](week6.md))
- [x] 2FA per la console: verifica in due passaggi facoltativa con app di autenticazione (settimana 6)

### Annie Cloud (deciso il 16 ottobre 2026, [piano](piano-cloud.md), [ADR 0007](adr/0007-annie-cloud-a-celle.md))

- [ ] Fase 1: la cella. Fatti e su `main` (settimane 7 e 8): Telegram via webhook, celle che si spengono e si risvegliano, control plane con registrazione, link via SMTP, celle container (ADR 0008). Misure: circa 4 s dalla registrazione alla prima risposta e per il risveglio, circa 100 MB di memoria da accesa, 0,1 MB di disco da spenta. Mancano: la scelta del provider (Railway in valutazione, spike con `RAILWAY_API_TOKEN`), dominio con PSL, servizio SMTP, prova dal vivo
- [x] Fase 2: l'agente personale (memoria della persona, Google per persona in sola lettura, brief del mattino). Restano la verifica dell'app presso Google e la misura sul campo (`pnpm annie brief` dopo una settimana d'uso vero)
- [ ] Fase 3: il computer dell'agente. Fatte la navigazione web in sola lettura (settimana 10, ADR 0009), l'invio di moduli con approvazione (settimana 16, [ADR 0011](adr/0011-moduli-web-con-approvazione.md)) e il terminale in un computer per istanza senza rete (settimana 18, [ADR 0013](adr/0013-terminale-in-un-computer-senza-rete.md), per ora solo installando Annie su un proprio server), il browser con clic nel Chromium della cella (settimana 19, [ADR 0014](adr/0014-browser-con-clic-nella-cella.md), anche in Annie Cloud) e il computer su micro-VM Fly.io, che lo accende anche in Annie Cloud (settimana 20, [ADR 0015](adr/0015-computer-su-micro-vm.md)). Manca la prova dal vivo su Fly con un token vero (`FLY_API_TOKEN`, [chiavi](chiavi.md) §12)
- [ ] Fase 4: pagamento, voce, WhatsApp. Pronti la misura della spesa per tenant (`pnpm cloud status`), l'abbonamento Stripe con prova, quota fissa e consumo a contatore (settimana 12, ADR 0010) il canale WhatsApp (settimana 13) e i messaggi vocali trascritti (settimana 14). Mancano le cifre (decisione di Mario, si impostano su Stripe), le prove dal vivo con le chiavi di test di Stripe, Meta e Mistral, il template WhatsApp da far approvare a Meta (il codice c'è, settimana 15) e la prova dal vivo delle chiamate vocali (settimana 17, [ADR 0012](adr/0012-chiamate-vocali-con-numero-twilio.md)), che chiede un numero Twilio italiano

### Funzioni (dal 17 ottobre 2026, una PR per funzione)

- [x] Foto e immagini: Annie vede le foto mandate su Telegram, WhatsApp e web e riapre le immagini del workspace (settimana 21, [week21.md](week21.md), [ADR 0016](adr/0016-immagini-al-modello.md))
- [x] Ricerca sul web: Annie cerca con Brave Search e apre le pagine trovate dai siti consentiti (settimana 22, [week22.md](week22.md), [ADR 0017](adr/0017-ricerca-sul-web.md)). Serve la chiave `ANNIE_SEARCH_API_KEY` ([chiavi](chiavi.md) §13)
- [x] Sentinelle: Annie controlla una pagina da sola e scrive quando cambia o quando un prezzo passa una soglia (settimana 23, [week23.md](week23.md), [ADR 0018](adr/0018-sentinelle.md))
- [x] Primo avvio guidato («Primi passi») e console installabile come app (settimana 24, [week24.md](week24.md), [ADR 0019](adr/0019-primi-passi-e-console-come-app.md))
- [x] Risposte a voce: un vocale in risposta a un vocale su Telegram e WhatsApp, a scelta di ogni persona, e «Ascolta» nella console (settimana 25, [week25.md](week25.md), [ADR 0020](adr/0020-risposte-a-voce.md)). Serve `ANNIE_SPEECH_API_KEY` ([chiavi](chiavi.md) §14)
- [x] Scrivere su calendario e mail, con approvazione: mail, risposte, bozze ed eventi che la persona approva dalla card in chat (settimana 26, [week26.md](week26.md), [ADR 0021](adr/0021-google-scrivere-con-approvazione.md)). Serve `ANNIE_GOOGLE_WRITE=1` ([chiavi](chiavi.md) §4)
- [x] Ricerca approfondita con report: più ricerche insieme, le pagine migliori lette, un report Markdown con le fonti numerate e controllate (settimana 27, [week27.md](week27.md), [ADR 0022](adr/0022-report-di-ricerca.md))
- [x] Immagini su richiesta: crea e ritocca immagini, varianti, sfondo trasparente; le foto arrivano come foto su Telegram e WhatsApp (settimana 28, [week28.md](week28.md), [ADR 0023](adr/0023-immagini-su-richiesta.md)). Serve `ANNIE_IMAGE_API_KEY` ([chiavi](chiavi.md) §15)
- [ ] Connettori in un clic

### Prima di rendere pubblico il repo

- [x] LICENSE (Apache-2.0, confermata)
- [x] Runbook per installazione e operatività ([runbook.md](runbook.md))
- [x] Action della CI su Node 24 (`checkout`, `setup-node`, `upload-artifact` v5). Resta `pnpm/action-setup@v4`: da verificare alla prima PR se dà ancora l'avviso

## Chi fa cosa

Craft segue prodotto ed esperienza, Ship codice, PR, CI e merge (su `main` solo con l'ok di Mario), AI Guru stack agenti, Pi Durable, modelli ed eval.
