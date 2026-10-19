# Settimana 67: fatture ricorrenti

Branch `week-67`. Per i canoni e gli abbonamenti dei clienti, Annie prepara da sola la bozza della fattura ogni mese, trimestre o anno e avvisa nella chat; l'emissione resta della persona. Le scelte sono nell'[ADR 0087](adr/0087-fatture-ricorrenti.md).

## Cosa cambia per chi usa Annie

- **«Canone mensile di manutenzione 300 € a Rossi srl dal 1° novembre»**: salvato, con la prossima bozza e quello che manca chiesto subito (l'aliquota IVA, il codice destinatario).
- **Ogni periodo**: «È pronta la bozza del canone di novembre 2026 per Rossi srl», da guardare ed emettere quando la persona lo dice.
- **«Quali canoni ho?»**, **«Fammi vedere quello di Rossi»**: importo, cadenza, prossima bozza, ultima bozza e mesi rimasti fuori.
- **«Metti in pausa l'hosting»**, **«Riprendilo»**, **«Togli il canone di Rossi»**: le bozze già fatte restano.
- **«Prepara anche quella di settembre»**: un periodo saltato o un mese rimasto fuori dopo un cambio di cadenza.
- **«Il 5 di ogni mese»**, **«a fine mese»**, **«per 12 mesi»**, **«fino a dicembre»**: capiti; il 31 si chiede se va bene l'ultimo giorno del mese.

## Cosa funziona (verificato dai test)

`test/recurring-invoices.test.ts`: cadenze con giorno 28, fine mese e febbraio, fuso di Roma, prenotazione del periodo con due giri insieme e dopo un riavvio, periodi saltati, pausa, fine e numero di fatture, bozza uguale a una fatta a mano in ordinario e forfettario, errore detto una volta, dati mancanti chiesti all'aggiunta, cambio di cadenza e di inizio senza mesi doppi, mesi rimasti fuori preparati uno per uno, fattura tolta e rimessa, un altro canone dello stesso cliente, bozza tolta e rifatta, bozza riscritta con `sales_invoices`, periodi futuri e parziali rifiutati, avvisi riprovati, canale agenti senza nomi, audit senza dati. Restano verdi i test delle fatture in uscita.

## Revisioni

Prima revisione, corretta: cambiare cadenza o inizio fatturava due volte un mese o ne saltava due; togliere e rimettere un canone rifaceva la bozza del mese; l'ultimo periodo perso a server fermo spariva; l'avviso dava al modello il comando per emettere; `run_now` preparava bozze di fatture in pausa; una bozza tolta bloccava il suo periodo; un canone senza aliquota falliva ogni mese; descrizioni lunghe accettate e poi rifiutate a ogni bozza; mesi saltati detti senza nominarli e senza modo di recuperarli; date come «dal 1° novembre» e «il 5 di ogni mese» non capite; frasi con «di 4º trimestre».

Seconda revisione, corretta: i mesi di un canone tolto bloccavano un altro canone dello stesso cliente; una bozza riscritta con `sales_invoices` sembrava tolta e si poteva rifare; dopo tre invii falliti l'avviso non si riprovava più; `run_now` preparava periodi futuri e parti di un periodo già coperto a importo pieno.

Verifica finale: niente da correggere. Restano da fare: spostare l'inizio oltre un mese già dovuto e mai preparato lo lascia fuori senza dirlo; la previsione di cassa non conta ancora le fatture ricorrenti; il runtime non dice agli strumenti se un turno viene da un avviso.
