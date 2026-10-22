# Quanto costa un turno: token, costo e strumenti di ogni risposta

Della spesa si sapeva solo quella della segreteria (ADR del registro dei costi, `src/core/usage.ts`). L'agente generale, quello che risponde in chat e lavora con gli strumenti, non scriveva niente: i tetti di spesa del tenant e `pnpm cloud status` contavano meno di quanto si spendeva davvero, e non c'era modo di vedere quali strumenti l'agente usasse, quante chiamate al modello facesse per rispondere o cosa costasse una risposta.

## Decisione

- **A ogni risposta l'adapter di Pi Durable somma il turno.** Dalla risposta torna indietro nella conversazione fino alla fine del turno prima (l'ultima risposta senza strumenti) e somma ogni chiamata al modello: token in entrata, in uscita, letti e scritti nella cache, costo secondo i prezzi di listino del provider, e i nomi degli strumenti chiamati, in ordine (`turnUsage` in `src/core/adapters/pi-durable.ts`). Arriva al runtime con la risposta (`EngineReply.usage`).
- **Il runtime lo scrive due volte, una volta sola per risposta.**
  - Nell'audit, come evento `turn.usage`: agente, canale, modello, chiamate, token, costo, quanti strumenti e quali. Mai il testo.
  - Nel registro dei costi del tenant, con il ruolo `agent`: così la spesa del giorno e del mese comprende anche l'agente.
  Si conta solo quando la risposta entra nell'outbox per la prima volta: una risposta consegnata di nuovo dopo un riavvio non si conta due volte. Un errore nello scrivere il conto non ferma mai la risposta.
- **`pnpm annie usage`** mostra gli ultimi 7 giorni: turni, token, costo, per agente, e gli strumenti più usati.
- Il registro dei costi scrive un record alla volta per tenant nello stesso processo: due turni che finiscono insieme non si perdono a vicenda il totale del giorno.

## Conseguenze

- I tetti di spesa del tenant ora contano anche l'agente: un tenant che prima stava sotto il tetto può superarlo, e allora `cost.warn` e `cost.denied` compaiono nell'audit a ogni turno oltre il tetto.
- L'agente generale non si ferma al tetto massimo: lo registra, non lo applica. Applicarlo è una decisione a parte.
- Il costo è quello che il provider dichiara con i prezzi di listino di pi-ai: niente sconti, niente abbonamenti. Con i provider locali (Claude Code, Codex) è zero.
- Le risposte date prima di questo cambio non hanno un conto.
