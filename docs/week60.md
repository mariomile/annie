# Settimana 60: estratto conto

Branch `week-60`. Owni legge l'estratto conto che la persona le manda (CSV, Excel o CAMT.053), spiega ogni movimento con le fatture, le spese, i rinnovi, gli F24 e i giroconti, e dopo un sì segna le fatture incassate o pagate nel giorno della banca, registra le spese e aggiorna il saldo della previsione di cassa. Le scelte sono nell'[ADR 0078](adr/0078-estratto-conto.md).

## Cosa cambia per chi usa Owni

- **«Ti mando l'estratto conto di ottobre»**: i movimenti caricati, quanti sono abbinati, quanti aspettano un sì e quanti non hanno una spiegazione. Se le colonne non sono chiare Owni le mostra e chiede.
- **«Sì, quelle di Rossi»**: le fatture segnate incassate nel giorno del bonifico, elencate. Quelle dove coincide solo l'importo Owni le chiede una per una.
- **«Quali movimenti non hanno una spiegazione?»** e **«ci sono addebiti strani?»**: movimenti senza spiegazione, addebiti doppi, commissioni.
- **«Quanto è entrato a ottobre sul conto?»**: entrate e uscite per mese secondo la banca, senza i giroconti fra i tuoi conti.
- **«Registra le commissioni fra le spese»**: le spese dai movimenti, chiedendo prima se una uguale c'è già.
- **«Usa il saldo dell'estratto»**: il saldo di chiusura nella previsione di cassa.
- **«Ho caricato il file sbagliato»**: l'importazione tolta, se nessun movimento è confermato.
- **Nel brief**: il resto del mese da caricare e i movimenti che aspettano un sì.

## Cosa funziona (verificato dai test)

`test/bank.test.ts`: CSV con importo unico o Dare e Avere, separatori e decimali italiani e inglesi, date ambigue chieste, Excel, CAMT con valute diverse, colonne chieste con i primi valori, IBAN e carte mascherati anche nelle intestazioni, file troppo grandi e celle ostili, stesso file caricato due volte con e senza saldo progressivo, CSV e CAMT dello stesso mese, righe uguali nello stesso file, abbinamenti con partita IVA, nomi in ordine diverso e troncati, numeri di fattura, rate uguali, acconti, F24 solo dalle parole della banca, giroconti, prelievi, conferme forti e deboli, rifiuti, spese con doppioni, commissioni, saldo nella previsione di cassa con fatture segnate a mano, brief che non scrive, canale agenti, CSV con celle ostili, file rovinato, audit senza dati. Restano verdi i test di scadenzario, spese, previsione di cassa e liquidazione IVA, che ora leggono il giorno del pagamento della banca.

## Revisioni

Prima revisione, corretta: un numero qualsiasi nella causale («TRN 0012») che bastava per un abbinamento sicuro; la «rivalsa INPS» di un cliente presa per un F24; lo stesso estratto caricato con e senza saldo progressivo, o in CSV e CAMT, contato due volte; fatture segnate a mano contate due volte dopo il saldo dell'estratto; valori negativi in Avere presi per entrate; saldi in dollari salvati come saldo; date mese/giorno lette al contrario; IBAN attaccati a lettere non mascherati; descrizioni divise su più colonne perse; nomi in ordine diverso o troncati non riconosciuti; giroconti nei totali; abbinamenti deboli confermati insieme ai sicuri; risposte troppo lunghe; il brief che chiedeva l'estratto di un mese non ancora finito.

Seconda revisione, corretta: un movimento vero scartato come «già caricato» perché somigliava a un altro per una parola come «bonifico»; fatture segnate a mano dopo il saldo tolte dalla previsione anche quando l'estratto non le conteneva; «Mario Rossi» abbinato a «Rossini Mario» e «Costa» a «Costantini» come sicuri; nessun modo di togliere una copia o un file sbagliato; le commissioni che rubavano le bollette e le spedizioni alle loro categorie; date americane lette come italiane; acconti suggeriti su fatture già abbinate; la domanda finale uguale per ogni dubbio.

Terza revisione, corretta: una copia tolta con «è lo stesso movimento» che tornava ricaricando il file; un file tolto che si portava via movimenti presenti anche in un file caricato dopo; una descrizione cambiata dalla banca nello stesso formato contata due volte senza avviso; due movimenti dello stesso importo nello stesso giorno scambiati fra loro secondo l'ordine delle righe; un abbinamento solo proposto che toglieva dalla previsione di cassa l'incasso di un'altra fattura.
