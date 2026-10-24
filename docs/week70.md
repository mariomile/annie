# Settimana 70: prezzi d'acquisto

Branch `week-70`. Owni legge le righe delle fatture dei fornitori: quanto paghi ogni prodotto, chi te lo vende meno caro, quali prezzi sono aumentati, e la fattura del fornitore che carica la merce in magazzino dopo il sì della persona. Le scelte sono nell'[ADR 0090](adr/0090-prezzi-d-acquisto.md).

## Cosa cambia per chi usa Owni

- **«Quanto pago la carta A4 da Beta?»**: l'ultimo prezzo senza IVA, con gli sconti della fattura già divisi sulle righe.
- **«Chi me la vende meno cara?»**: tutti i fornitori che l'hanno venduta, nella stessa unità, ognuno con la sua descrizione.
- **«Quali prezzi sono aumentati quest'anno?»**: «ora costa 4,86 € a risma, l'8% in più del 3 marzo, quando costava 4,50 €». E nel brief, una volta.
- **«La fattura di Beta di ieri: carica la merce in magazzino»**: la proposta riga per riga, poi il carico dopo il sì; «carica solo le righe 1 e 3», «la riga 2 è il toner nero», «la riga 4 è un articolo nuovo».

## Cosa funziona (verificato dai test)

`test/purchase-prices.test.ts`: righe con sconti, maggiorazioni, spese, quantità mancanti, natura, righe rotte e più di 2000 righe; sigle delle unità; storico, confronto e aumenti calcolati esatti; brief una volta per riga, tre al giorno e uno per fornitore; proposta di carico con codici e descrizioni imparati, conversioni di unità, articoli nuovi, controllo della proposta cambiata, stessa riga mai caricata due volte, codici doppi, numeri di riga ripetuti, merce già vista; risposte agli agenti con soli conteggi; audit senza dati; CSV con celle ostili; fatture realistiche di due fornitori con sconti e trasporto. Il test delle stanze che falliva ogni tanto sotto carico ora aspetta l'ordine giusto senza togliere nessun controllo.

## Revisioni

Prima revisione, corretta: sigle come RS, NR e CF non erano unità e niente si caricava; «Beta» chiedeva sempre quale fornitore; lo stesso prodotto scritto in due modi da due fornitori non si confrontava; gli sconti di fine anno non entravano nei prezzi; «la fattura di ieri» non si poteva dire; gli aumenti senza la data di prima; due righe con lo stesso codice bloccavano il carico; il sì poteva caricare una proposta diversa da quella vista; un codice già imparato poteva caricare un articolo sbagliato senza avviso; il numero della fattura fuori dal recinto.

Verifica finale, corretta: uno sconto scritto sia come riga sia nell'intestazione si contava due volte (ora gli sconti si controllano con il riepilogo IVA della fattura); un agente chiamato in una stanza riceveva prezzi e nomi, perché il controllo guardava il canale e non da dove nasce il turno: ora un solo controllo (`isAgentTurn`) vale per tutti gli strumenti.
