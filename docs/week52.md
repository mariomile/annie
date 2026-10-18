# Settimana 52: spese e prima nota

Branch `week-52`. Annie tiene il registro delle spese: basta la foto dello scontrino o una frase, poi riepiloghi, prima nota con incassi e uscite ed export per il commercialista. Le scelte sono nell'[ADR 0057](adr/0057-spese-e-prima-nota.md).

## Cosa cambia per chi usa Annie

- **Foto dello scontrino** o «ho speso 42 euro di benzina ieri»: Annie registra la spesa con data, totale, IVA, fornitore e categoria, e avvisa se sembra un doppione.
- **«Quanto ho speso a ottobre?»**, **«quanto ho speso di benzina quest'anno?»**: totale, IVA, categorie e confronto con il periodo prima. Nel forfettario niente IVA, una nota semplice.
- **«Fammi la prima nota del trimestre»**: entrate dalle fatture pagate e uscite dalle spese, giorno per giorno, con il saldo.
- **«Mandami le spese del trimestre scorso per il commercialista»**: un CSV in `spese/` che Excel apre bene, con tipo di documento, partita IVA del fornitore e totali; si può mandare per mail con gli allegati della settimana 51.
- **Nel brief del mattino**: quanto hai speso questo mese rispetto al mese scorso.

## Cosa funziona (verificato dai test)

`test/expenses.test.ts`: importi e date all'italiana (anche ieri, sabato, lunedì scorso, mesi senza anno e anni a due cifre), IVA da aliquota, categorie da parole intere, doppioni, numeri mai riusati, modifiche concorrenti e cambio d'anno rifiutato, limiti e file rovinato, riepilogo con confronto e nota del forfettario, prima nota con saldo e casi contati a parte, CSV con BOM, colonne, totali e celle ostili, percorso dell'export, canale agenti e brief, audit senza dati. I preventivi e le tabelle passano dagli stessi moduli condivisi (`json-book.ts`, `csv.ts`, `stored-fields.ts`) e i loro test restano verdi.

## Revisioni

Prima revisione, corretta: mesi senza anno finiti nel futuro, anni a due cifre ignorati, testo del periodo ripetuto senza recinto, «sabato» e «lunedì scorso» rifiutati, stesso scontrino registrato due volte senza avviso, preposizioni sbagliate («Spese di 2026»), errori con l'etichetta dei preventivi, valute estere e resi senza una via d'uscita, nota del forfettario in gergo, modifica che poteva cancellarne un'altra contemporanea, rimozione ripetuta che rispondeva con un errore, spesa che cambiava anno, categorie indovinate dall'indirizzo, aiuti copiati da preventivi e tabelle, prima nota muta su rate e note di credito, confronto del brief rumoroso a inizio mese, colonne del CSV poco utili al commercialista.

Seconda revisione, corretta: codici fiscali che iniziano con «CF» accorciati e partite IVA di 8 cifre accettate, testo di un periodo ripetuto anche senza date dentro, «assicurazione professionale» e «revisione bilancio» finite fra le spese dell'auto, «ad ottobre», anni a due cifre nel futuro, rate a zero contate come illeggibili, note di credito ricevute mescolate a quelle emesse, doppioni non visti per «Bar Sport» e «BAR SPORT srl», «l altro ieri», «venerdì 16» e «domenica scorsa» rifiutati, data senza anno finita un anno indietro senza avviso, modifiche che non cambiavano nulla scritte comunque.
