# Settimana 55: previsione di cassa

Branch `week-55`. Annie mette in fila sul conto i soldi che devono entrare e uscire, da fatture, rinnovi, preventivi accettati, spese e voci della persona, e dice quanti ce ne saranno, quando si rischia di andare in rosso e cosa succede se si compra qualcosa o un cliente paga tardi. Le scelte sono nell'[ADR 0065](adr/0065-previsione-di-cassa.md).

## Cosa cambia per chi usa Annie

- **«Ho 8.400 euro sul conto»**: il punto di partenza. Se il saldo è di qualche giorno fa, Annie lo porta a oggi con le fatture incassate e le spese registrate dopo, e lo dice.
- **«Quanti soldi avrò a fine mese?»**: il saldo finale, il punto più basso e il giorno, le entrate e le uscite più grandi, e da dove vengono i numeri.
- **«F24 a giugno 2.300»**, **«stipendio il 27»**, **«rata del prestito 350 euro ogni mese»**, **«ogni 15 giorni»**: le voci che non stanno altrove. Se assomiglia a un rinnovo o a una voce già registrata, Annie chiede prima di aggiungerla.
- **«Se compro un computer da 2.000 € a novembre ce la faccio?»**: la risposta prudente, senza contare fatture in ritardo e preventivi.
- **«Se Rossi paga con 60 giorni di ritardo?»**, **«se Gamma non paga?»**: come cambia il punto più basso.
- **«Avvisami se vado sotto i 2.000»**: lo dice il brief del mattino.
- **«Mandami la previsione per il commercialista»**: un CSV in `cassa/`.

## Cosa funziona (verificato dai test)

`test/cashflow.test.ts`: saldi detti e portati a oggi per istanti, voci una volta, ogni N mesi, ogni N giorni e ogni lunedì, importi come «8.400», «1,5k» e «8 mila», orizzonti fino a un anno con il passaggio al periodo dopo l'ultimo giorno, fatture da incassare e da pagare con ritardi e scadute da troppo, rinnovi con e senza addebito automatico, preventivi accettati e vecchi, spesa media senza doppioni, probabili doppioni fra rinnovi, fatture e voci, ipotesi, ritardi e mancati pagamenti con il caso prudente, modifiche contemporanee, brief e suggerimento che non scrive, canale agenti, CSV con celle ostili e un solo recinto per risposta, audit senza dati. Rinnovi, spese e preventivi passano dai moduli condivisi (`recurrence.ts`, `italian-format.ts`, `format-words.ts`) e i loro test restano verdi.

## Revisioni

Prima revisione, corretta: fatture dei fornitori contate due volte, nella spesa media e fra le fatture da pagare; rinnovi e fattura del fornitore contati due volte; soldi mossi fra il giorno del saldo e oggi persi; fatture dei fornitori scadute da anni tolte oggi; spesa media sottostimata per chi ha appena cominciato; verdetto «te lo puoi permettere» che contava le fatture in ritardo come incassate e dava la colpa del rosso all'ipotesi anche quando c'era già; nessun modo di chiedere «se Rossi paga in ritardo?»; preventivi accettati ignorati; voci senza modifica e senza frequenza settimanale; «8.400» rifiutato; accordi, preposizioni («del 8», «a Alfa») e nomi dei parametri nelle frasi per la persona; risposte troppo lunghe e CSV con una riga al giorno; ipotesi che cambiavano gli argomenti ricevuti; canale agenti con una lista di divieti invece che di permessi.

Seconda revisione, corretta: incassi contati due volte quando la fattura veniva segnata come pagata dopo aver detto il saldo, e persi quando era segnata oggi; voci tolte due volte insieme alla spesa registrata; intere categorie tolte dalla spesa media, che rendevano la previsione troppo ottimista; doppioni fra rinnovi e fatture trovati per prefisso («Sky» e «Skyline») o fra periodi diversi; preventivi accettati vecchi che restavano sempre a 30 giorni; due modifiche insieme di cui una andava persa; ritardi per numero di fattura che toccavano fatture di altri; il brief che scriveva il segnale del suggerimento; F24 di saldo e acconto presi per doppioni; «Il 8» nei rinnovi.

Terza revisione, corretta: un saldo detto oggi per un giorno passato che ignorava i movimenti in mezzo, una voce mensile tolta per tutto l'orizzonte dopo un solo doppione, orari con fuso orario confrontati come testo, rinnovi senza fornitore mai confrontati con le loro fatture (ora segnalati come «forse doppioni», senza togliere niente).
