# Stato del progetto e cose da fare

Aggiornato al 15 ottobre 2026. Lo sviluppo è in pausa per decisione di Mario e riparte solo quando lui lo riapre.

## Dove siamo

Su `main` ci sono le settimane 1, 2 e 3, e la CI controlla ogni PR con typecheck, test ed eval deterministiche.

- Settimana 1: nucleo durevole su Pi Durable dietro un adapter, multi-tenant, canale Telegram ([week1.md](week1.md)).
- Settimana 2: allowlist degli utenti per istanza, lock dell'istanza e outbox persistente delle risposte ([week2.md](week2.md)).
- CI: typecheck, test ed eval su ogni PR, con la regola di un PR per settimana ([contributing.md](contributing.md)).
- Settimana 3: segreteria commerciale su Telegram con approvazione obbligatoria prima di ogni invio, adapter per mail e CRM, routing dei modelli e tetti di spesa, 35 eval ([week3.md](week3.md), [spec](spec-segreteria-commerciale.md)).

Documenti di riferimento: [piano iniziale](piano-iniziale.md), [architettura](architettura.md).

## Cose da fare

### Per la prova reale (servono i segreti di Mario)

- [ ] Token del bot Telegram (da @BotFather)
- [ ] Chiave del modello (Anthropic o OpenAI)
- [ ] OAuth di Gmail
- [ ] Token di HubSpot
- [ ] User ID Telegram di Mario in `ANNIE_TELEGRAM_ALLOWED_USERS`
- [ ] Misurare dal vivo l'estrazione dei lead e il costo per pratica (stima da verificare: 1-2 centesimi di dollaro)

### Settimana 4

- [ ] Avviso su Telegram quando una risposta potrebbe arrivare doppia dopo un crash (consegna at-least-once)
- [ ] Adapter live di Gmail e HubSpot al posto degli stub
- [ ] Eval con giudice notturno, oltre ai controlli deterministici

### Prima di rendere pubblico il repo

- [ ] Aggiungere LICENSE
- [ ] Scrivere un runbook per installazione e operatività
- [ ] Aggiornare le action della CI oltre Node 20 (oggi danno solo avvisi)

## Chi fa cosa

Craft segue prodotto ed esperienza, Ship codice, PR, CI e merge (su `main` solo con l'ok di Mario), AI Guru stack agenti, Pi Durable, modelli ed eval.
