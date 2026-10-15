# Prodotto finito: definizione e stato

Annie è «pronta al 100%» quando ognuna di queste voci è vera e verificata da un test o da una prova documentata. Vocabolario: [`GLOSSARY.md`](../GLOSSARY.md). Decisioni: [`adr/`](adr/).

## 1. Un solo processo

- [ ] `pnpm start` avvia tutto per un tenant: istanze, Telegram, interfaccia web, task programmati, segreteria se configurata.
- [ ] Configurazione da `.env` per il bootstrap; il resto (connettori, task, persone) dalla console web o dalla riga di comando.
- [ ] Docker Compose con volume dati, healthcheck e riavvio automatico.

## 2. Agente generale

- [ ] Tool per istanza, ricalcolati e applicati riaprendo l'istanza quando cambiano (ADR 0004).
- [ ] **Connettori MCP** (Streamable HTTP e stdio) configurabili per istanza, con segreti nel secret store ed egress per host; i loro tool arrivano al modello (ADR 0003).
- [ ] **Workspace**: l'istanza crea, legge, elenca e invia file; le persone li caricano e scaricano da web e Telegram.
- [ ] **Task programmati**: una volta o a ripetizione, creati dalle persone o dall'istanza stessa; eseguiti anche dopo un riavvio; risultato consegnato al thread.
- [ ] **Tool proposti**: l'istanza scrive un tool, un approvatore lo approva su Telegram o web, gira in sandbox con egress dichiarato (ADR 0002).
- [ ] **Approvazioni** in un unico posto, visibili su Telegram (pulsanti) e web.

## 3. Interfaccia web

- [ ] Accesso con link personale creato dall'owner, sessione con cookie `HttpOnly`, chi non è autorizzato non vede nulla.
- [ ] Chat con l'istanza, risposte in tempo reale, storico dei thread.
- [ ] Segreteria: elenco pratiche, scheda con bozza, Approva, Modifica, Scarta.
- [ ] Connettori, task programmati, file, tool proposti e approvazioni.
- [ ] Spesa del giorno e audit.
- [ ] Funziona da telefono; tema chiaro e scuro; nessuna risorsa esterna (ADR 0005).

## 4. Qualità e operatività

- [ ] CI verde: typecheck, test, eval deterministiche; giudice notturno.
- [ ] Review indipendente su ogni blocco, problemi corretti o documentati.
- [ ] Runbook: installazione, aggiornamento, backup e ripristino, rotazione dei segreti.
- [ ] LICENSE.

## Fuori dal perimetro (scelte esplicite)

- WhatsApp (piano iniziale: non in questa fase).
- Invio di mail o azioni irreversibili senza approvazione.
- Multi-tenant cloud con billing: il deployment di riferimento è un processo per tenant.
