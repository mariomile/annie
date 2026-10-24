# Board: trascinare le schede e l'avviso «da rivedere»

La board ([ADR 0050](0050-board.md)) cambiava colonna solo dalla scheda aperta, e chi aveva affidato una scheda scopriva che era finita solo guardando la board o la chat dell'agente.

## Decisione

- **Sul computer le schede si trascinano fra le colonne**, anche in Firefox. Trascinare fa le stesse mosse dei pulsanti, con le stesse regole del server:
  - da Da fare a In corso è **Avvia**: parte solo se la scheda è affidata a un agente a cui la persona può scrivere;
  - da Da rivedere a In corso è **Rimanda indietro**: si apre la scheda con il cursore nel commento, perché all'agente serve sapere cosa cambiare;
  - le altre mosse cambiano solo la colonna (per esempio Da rivedere a Fatto è Approva).

  Sul telefono resta la scheda aperta, che funziona uguale.
- **Quando un agente sposta una scheda in Da rivedere, lo sa chi deve rivederla**: la persona con cui l'agente ci ha lavorato, o gli owner se nessuno l'aveva avviata. Una persona che la sposta lì da sola non manda avvisi, e non li manda nemmeno un commento mentre la scheda aspetta.
  - **Nella console**: un messaggio («Scheda #12 da rivedere: …») e il numero accanto a **Board** nella barra laterale, che conta le schede da rivedere per quella persona. Se la board è aperta si aggiorna da sola.
  - **Nella chat dell'owner**: se chi deve rivederla è un owner, arriva anche un messaggio agli approvatori dell'agente principale su Telegram e WhatsApp, con il titolo, l'agente e il suo riassunto (al più 300 caratteri). Non ha pulsanti: si approva o si rimanda dalla console, dove si legge il lavoro. I membri hanno solo la console, perché non hanno una chat collegata a Owni.

## Alternative scartate

- **Approva e Rimanda come pulsanti nel messaggio Telegram**: il lavoro sta nella conversazione della console, e approvare senza averlo letto è proprio quello che la revisione deve evitare.
- **Un avviso a ogni commento dell'agente**: troppi messaggi; conta il momento in cui la scheda aspetta una persona.
