# Board: l'agente lavora da solo fino alla fine

Con la board ([ADR 0050](0050-board.md)) l'agente lavora su una scheda in una conversazione con chi gliel'ha affidata. Ogni sua risposta però aspetta la persona: se chiede «vado avanti?» o si ferma a metà, la scheda resta In corso finché qualcuno non torna a scrivergli. Per molte schede (una ricerca, una bozza, un confronto di preventivi) chi la affida vuole solo il risultato da rivedere.

## Decisione

- **Ogni scheda può avere «Lavora da solo fino alla fine»**, una casella che si spunta quando la si crea affidandola a un agente, accanto ad **Avvia**, o nella scheda aperta mentre è In corso. Lo decide la persona che ci lavora con l'agente: non l'agente, e non un'altra persona.
- **Dopo ogni risposta dell'agente nella conversazione della scheda, finché è In corso, Owni gli scrive di andare avanti** («Vai avanti da solo…»), come se lo scrivesse quella persona. Il brief iniziale gli dice che nessuno risponderà, di non fare domande e di decidere con buon senso. Quando ha finito, o gli manca qualcosa di indispensabile, sposta la scheda in «Da rivedere» con il suo riassunto, e arriva l'avviso di sempre ([ADR 0051](0051-board-trascinare-e-avvisi.md)).
- **Il tetto è di 10 risposte e 2 ore** da quando è partita. Superato uno dei due, alla risposta successiva la scheda va in «Da rivedere» da sola, con un commento che dice cosa è successo, e arriva lo stesso avviso. Il tetto tiene basso quello che un agente può spendere senza che nessuno guardi.
- **Rimandata indietro con un commento, riparte da zero**, sempre da sola. Se la persona toglie la spunta, l'agente torna ad aspettare le sue risposte; se la mette mentre l'agente aspetta, riparte subito.
- **Contano solo le risposte a quello che è scritto nella conversazione**, non i file o i messaggi che l'agente manda mentre lavora. Se l'agente non riesce a rispondere (il modello non risponde, il tetto di spesa) o non gli si può più scrivere (la conversazione eliminata, la persona tolta dall'agente), la scheda va in «Da rivedere» con il motivo, invece di restare In corso senza che nessuno se ne accorga. Una risposta consegnata di nuovo dopo un riavvio si conta una volta: la scheda ricorda l'ultima.
- **Tornata in «Da fare», o affidata a un altro agente, la scheda non lavora più da sola**: decide di nuovo chi la avvia.
- Sulla board la scheda mostra «da solo» e, aperta, quante risposte ha dato da sola.

## Alternative scartate

- **Un ciclo dentro l'agente, senza messaggi**: il lavoro deve restare leggibile nella conversazione, dove la persona lo rivede e può intervenire scrivendo.
- **Nessun tetto, o un tetto in euro**: il costo di una risposta dipende dal modello scelto per l'agente; risposte e tempo sono uguali per tutti e si spiegano in una riga.
- **Lasciar decidere all'agente se andare da solo**: chi paga e chi rivede è la persona; un agente che si dà il via da solo è proprio quello che la board evita con Avvia.
