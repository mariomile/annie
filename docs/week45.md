# Settimana 45: date e scadenze

Branch `week-45`. Ora `date_calc` fa i conti sulle date al posto del modello: giorni e giorni lavorativi, scadenze delle fatture a 30/60/90 giorni anche fine mese o a giorno fisso, festivi, età e settimane. Sempre attivo, senza rete né chiavi. Come funziona e le alternative scartate sono nell'[ADR 0048](adr/0048-date-e-scadenze.md).

## Cosa cambia per chi usa Owni

- **«Quanti giorni lavorativi ci sono fino al 31 dicembre?»**: il conto senza sabati, domeniche e festivi, con il 4 ottobre dal 2026.
- **«Fattura del 31 gennaio a 60 giorni fine mese, quando scade?»**: la data, e quella contata a mesi se un gestionale la conta diversa.
- **«Scade di domenica?»**: sì o no, e il primo giorno lavorativo dopo.
- **«Con il patrono di Milano?»**: il 7 dicembre conta come festivo solo se lo chiedi.
- **«Che giorno cade Pasqua l'anno prossimo?»**, **«Quanti anni ha chi è nato il 29/02/1980?»**, **«In che settimana siamo?»**.

## Cosa funziona (verificato dai test)

`test/dates.test.ts`: lettura delle date italiane, Pasqua, festivi con San Francesco, giorni lavorativi con e senza sabato e patrono, scadenze data fattura, fine mese e giorno fisso, mesi a fine mese, 29 febbraio, settimana ISO, limiti degli anni e degli importi, risposte del tool.

## Revisioni

Prima revisione (correttezza e risposte), corretta: giorno fisso nel mese giusto, «dffm» e altre abbreviazioni lette, tabella dei patroni corretta (L'Aquila il 10 giugno, Bolzano tolta), festivi limitati dal 2001, scadenze di fatture prima del 2001 rifiutate, date senza anno che passerebbero all'anno dopo rifiutate, testi delle risposte.

Seconda revisione, corretta: patrono scritto «07-06» letto come 7 giugno, quattro capoluoghi di regione aggiunti ai patroni, messaggi più chiari per età e giorno fisso, data «a mesi» tenuta dentro gli anni ammessi.

## Da fare

- Usare `date_calc` nella segreteria per le scadenze trovate nelle mail.
