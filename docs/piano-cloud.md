# Piano: Annie Cloud

Deciso con Mario il 16 ottobre 2026. Vocabolario in [`GLOSSARY.md`](../GLOSSARY.md), decisione di architettura in [ADR 0007](adr/0007-annie-cloud-a-celle.md).

## Perché

Annie deve funzionare anche come Grok Bot (xAI) e dots (OpenAI): un agente sempre attivo a cui ci si registra e si parla, che lavora anche a telefono spento, ricorda la persona, prende iniziative e usa le sue app. Annie ha già il nucleo (agente durevole, connettori MCP, task programmati, tool che scrive da sola con approvazione, file, audit, tetti di spesa); mancano il cloud, la memoria della persona, la proattività oltre il cron, i connettori con un clic e il computer dell'agente.

Posizionamento: **il tuo agente sempre attivo, per professionisti e piccoli team, dati in UE**, a 20-50 € al mese. Lo stesso prodotto resta installabile in self-host. Non inseguiamo il consumer generalista.

## Cosa c'è e cosa manca

| Capacità | Grok Bot / dots | Annie (main, 16 ottobre) |
|---|---|---|
| Registrazione, account, pagamento | sì | no: self-host, l'owner crea le persone |
| Agente sempre attivo e durevole | sì | sì |
| Connettori | MCP e app con un clic | MCP configurato dall'owner |
| Proattività | ricerca quando è inattivo (dots), routine (Grok Bot) | task programmati |
| Memoria della persona | sì (dots) | storico per thread |
| Computer dell'agente (browser, terminale) | sì (Grok Bot) | file e tool JavaScript in sandbox |
| Canali | app, voce, SMS in arrivo | Telegram, web |
| Approvazioni e controllo | parziali | sì, per tool e azioni della segreteria |

Fonti su Grok Bot e dots: articoli di settore di settembre e ottobre 2026 (non gli annunci ufficiali), da ricontrollare prima di usarli all'esterno.

## Fasi

Ogni fase finisce con una PR verde su `main` e una misura.

### Fase 1: la cella (2 settimane)

Una persona si registra e parla con la sua Annie, nel cloud, senza che nessuno di noi tocchi niente.

- Telegram anche via webhook, oltre al long polling: il messaggio arriva da fuori invece di essere chiesto.
- Interfaccia `CellProvider` (crea, sveglia, spegni, distruggi una cella) con un provider locale per i test e uno per il cloud scelto.
- Control plane minimo: registrazione con link via email, creazione della cella, sottodominio per tenant, smistamento dei webhook, risveglio per i task programmati.
- Misure: meno di 2 minuti dalla registrazione alla prima risposta; costo mensile di una cella inattiva; tempo di risveglio.

### Fase 2: l'agente personale (2-3 settimane)

- Memoria della persona: fatti e preferenze che l'istanza ricorda fra conversazioni, visibili e modificabili dalla persona.
- Connettori Google (Gmail, Calendar) con OAuth dal control plane; i token vivono nella cella.
- Brief proattivo del mattino con tool in sola lettura.
- Misura: quante persone usano il brief dopo una settimana.

### Fase 3: il computer dell'agente (2-3 settimane)

- Browser e terminale dentro la cella, con livelli di approvazione: leggere è libero, scrivere o inviare si approva.

### Fase 4: commerciale

- Pagamento a consumo (Stripe) sopra il registro della spesa che c'è già; voce e WhatsApp.

## Domande aperte

- Provider delle celle: Fly.io Machines in UE è il candidato; costi, tempi di risveglio e volumi vanno misurati con un esperimento prima di scegliere.
- Email per i link di accesso: quale servizio, con dominio di Buildrs.
- Dominio di Annie Cloud.
- Prezzo: dipende dal costo misurato di una cella e del modello per tenant.
