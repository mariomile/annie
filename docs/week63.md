# Settimana 63: agenda fiscale

Branch `week-63`. Owni mette insieme in un'agenda sola tutte le scadenze di chi ha la partita IVA: gli F24 di tasse e IVA, le CU, i rinnovi, le fatture da pagare e le scadenze di legge che prima non diceva nessuno (dichiarazioni, LIPE, diritto camerale, bollo). Le può esportare in un file .ics per il calendario. Le scelte sono nell'[ADR 0083](adr/0083-agenda-fiscale.md).

## Cosa cambia per chi usa Owni

- **«Cosa devo pagare a novembre?»**: le scadenze del mese in ordine, con gli importi stimati dove ci sono.
- **«Qual è la prossima scadenza fiscale?»**: la prima scadenza fiscale in apertura, poi il resto dei prossimi 30 giorni.
- **«Mettimi le scadenze nel calendario»**: un file .ics in `agenda/` da aprire sull'iPhone o importare in Google Calendar dal computer; con «avvisami tre giorni prima» ogni evento ha il suo avviso.
- **Nel brief**: una riga per le scadenze dei prossimi 7 giorni che nessun altro strumento dice già.
- **Per un'agenda più completa**: Owni dice cosa le manca (il regime, il numero REA per il diritto camerale).

## Cosa funziona (verificato dai test)

`test/fiscal-agenda.test.ts`: scadenze di legge per forfettario, ordinario e senza profilo, spostate al giorno lavorativo, bollo per trimestre con il riporto e il trimestre in corso, LIPE, diritto camerale solo per le imprese, IVA mensile con saldo annuale e F24 di febbraio lo stesso giorno, rate di una fattura, scadute solo dove si sa se sono pagate, ordine e recinto dei nomi, apertura con la prossima scadenza fiscale, periodi detti, file .ics con escape, righe piegate, caratteri di controllo, UID stabili, SEQUENCE e avvisi, brief senza doppioni, canale agenti, audit senza dati. Restano verdi i test di tasse, IVA, ritenute, rinnovi, scadenzario e previsione di cassa.

## Revisioni

Prima revisione, corretta: il saldo IVA annuale di chi versa ogni mese che spariva perché cadeva con l'F24 di febbraio; le righe con un nome stampate fuori ordine; il messaggio dell'export che prometteva cose non vere su Google Calendar e sui reimport; titoli nel calendario lunghi e con il nome in fondo; righe con catene di due punti e doppie parentesi; «la prossima scadenza fiscale» che dava trenta giorni di fatture; caratteri di controllo C1 nel file; funzioni con lo stesso nome e alias da togliere.

Seconda revisione, corretta: un F24 del bollo che sembrava definitivo con i trimestri dopo ancora da venire, e la sua chiave che cambiava riempiendosi; «finora» detto due volte; la rata di una fattura ripetuta nel calendario; qualche frase da sistemare; il suggerimento del numero REA anche per le altre attività e per l'ordinario senza profilo.

Terza revisione: niente da correggere.
