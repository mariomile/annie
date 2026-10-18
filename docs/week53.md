# Settimana 53: ore di lavoro

Branch `week-53`. Annie tiene il conto delle ore lavorate per cliente, con il timer, le tariffe, il report da mandare al cliente e il preventivo fatto dalle ore. Le scelte sono nell'[ADR 0058](adr/0058-ore-di-lavoro.md).

## Cosa cambia per chi usa Annie

- **«Ho lavorato 3 ore per Rossi sul sito»**, **«ieri dalle 9 alle 13 con un'ora di pausa»**: la voce è registrata, con l'avviso se sembra un doppione.
- **«Avvia il timer per Beta»** e poi **«ferma il timer»**: le ore si registrano da sole; se il timer è rimasto acceso tutta la notte Annie chiede quante ore erano davvero.
- **«La mia tariffa per Rossi è 50 euro più IVA, arrotonda al quarto d'ora»**.
- **«Quante ore ho fatto questa settimana?»**, **«quanto devo fatturare a Rossi?»**: ore e importi per cliente e progetto, da fatturare, nel preventivo e fatturate.
- **«Manda a Rossi il riepilogo ore di ottobre»**: un PDF con la carta intestata, che parte allegato alla mail dopo l'approvazione.
- **«Fai il preventivo con le ore di ottobre di Rossi»**: un preventivo vero, numerato, e le ore passano «nel preventivo»; quando hai fatto la fattura, «segna fatturate con la fattura 12» chiude il giro.
- **Nel brief**: ore da fatturare da più di un mese, o un timer dimenticato acceso.

## Cosa funziona (verificato dai test)

`test/timesheet.test.ts`: durate in tutte le forme (anche «8.30», «due ore e mezza», pause e intervalli), date come «ieri pomeriggio» e «stamattina», settimane, timer con riavvio, avvii contemporanei, gruppi e notti, tariffe con e senza IVA e arrotondamenti solo in fattura, importi al centesimo, clienti con grafie diverse e forme giuridiche diverse, riepiloghi con le ore arrotondate, report PDF, Word e CSV anche senza tariffe, preventivo dalle ore senza doppioni anche con due richieste insieme o ripetute, stati nel preventivo e fatturate con il riferimento, voci protette, canale agenti e brief, audit senza dati. Spese e preventivi passano dagli stessi moduli condivisi (`periods.ts`, `day-input.ts`, `name-keys.ts`, `currency-words.ts`) e i loro test restano verdi.

## Revisioni

Prima revisione, corretta: due preventivi per le stesse ore con due richieste insieme, voce fatturata cancellabile in un momento sfortunato, riferimento della fattura cancellato da un secondo «segna fatturate», preventivo trattato come fattura, «8.30» letto come 8 ore e 18, clienti come «Mario Rossi» e «Rossi» contati in un modo nel riepilogo e in un altro nel report, «Rossi SpA» unito a «Rossi Srl», timer dimenticato di notte registrato come ore da fatturare, timer condiviso nei gruppi, ore scritte come «3:00 ore», «0,00 €» quando manca la tariffa anche nel documento per il cliente, «1 ore» e accordi sbagliati, pause, numeri in lettere, «ieri pomeriggio», settimane e «più IVA» non capiti, «quanto devo fatturare» limitato al mese, istruzioni per il modello mescolate alle frasi per la persona, righe del preventivo poco leggibili, report senza data, collegamento con i preventivi fatto per nome dello strumento invece che con una funzione tipizzata.

Seconda revisione, corretta: una prenotazione scaduta permetteva di mettere le stesse ore in un secondo preventivo o le lasciava da fatturare anche se erano già in un preventivo, durate come 8.3 date come numero lette senza chiedere, timer condiviso nelle conversazioni senza persona, «stanotte» letto come oggi, «2 ore di pomeriggio» rifiutato, «al 11» invece di «all'11».
