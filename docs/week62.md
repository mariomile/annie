# Settimana 62: ritenute d'acconto e Certificazione Unica

Branch `week-62`. Per chi è in regime ordinario Annie tiene il conto delle ritenute d'acconto che i clienti trattengono, controlla che abbiano pagato al netto, confronta le Certificazioni Uniche che arrivano con le fatture e dice quanto credito c'è per la dichiarazione dei redditi. Lo scadenzario ora aspetta il netto dalle fatture XML con ritenuta. Le scelte sono nell'[ADR 0082](adr/0082-ritenute-d-acconto.md).

## Cosa cambia per chi usa Annie

- **«Quanto mi hanno trattenuto quest'anno?»**: le ritenute per cliente, per cassa, e quanto è credito.
- **«Quanto credito ho per la dichiarazione?»**: il credito dell'anno della dichiarazione che si sta preparando, detto con il suo anno.
- **«Rossi mi ha pagato al netto?»**: il netto atteso e cosa è arrivato secondo l'estratto conto; chi ha pagato il lordo non dà credito.
- **«Mi è arrivata la CU di Rossi: 10.000 di compensi, 2.000 di ritenute»**: salvata e confrontata con le fatture, con le fatture che spiegano una differenza.
- **«Chi mi deve ancora mandare la CU?»**: i clienti con ritenute senza CU, e dopo il 16 marzo quelli in ritardo; nel brief di fine marzo.
- **«Mandami il riepilogo delle ritenute per il commercialista»**: un CSV in `ritenute/`.
- **Nell'andamento dell'attività**: le ritenute trattenute nel periodo.

## Cosa funziona (verificato dai test)

`test/withholding.test.ts`: ritenute dalle fatture fatte con Annie e dagli XML contate una volta, tipi di ritenuta e contributi, cassa previdenziale, fatture pagate fra due anni, rate e pagamenti parziali, note di credito, totale già al netto e righe negative, pagamenti al netto, al lordo e mancanti con e senza estratto conto, CU che torna e che non torna con la spiegazione, CU dell'anno in corso rifiutata, cliente simile e sconosciuto, sostituzione e rimozione, scadenza spostata al giorno lavorativo e finestra del brief, forfettario, canale agenti, CSV con celle ostili e totale del credito, file rovinato, audit senza dati. Restano verdi i test di scadenzario, estratto conto, previsione di cassa, tasse e andamento dell'attività, con le rate al netto per le fatture emesse e i contributi trattenuti negli incassi del forfettario.

## Revisioni

Prima revisione, corretta: le fatture ricevute con ritenuta contate al netto, con la ritenuta versata dall'azienda sparita da cassa e spese; l'ENASARCO trattenuto tolto dagli incassi del forfettario, che abbassava le tasse stimate; la ritenuta di una fattura pagata fra dicembre e gennaio messa tutta a gennaio; un totale già scritto al netto da cui la ritenuta veniva tolta due volte; il brief che parlava di CU mancanti prima della scadenza spostata; la ripetizione di una chiamata dopo una CU sostitutiva; CU salvate per nomi sbagliati e mai più cancellabili; il contributo della cassa nei compensi; «la CU di Rossi» rifiutata con «ce ne sono 1»; la CU 2026 presa per i compensi del 2026; il credito per la dichiarazione dell'anno sbagliato; un CSV che diceva «al netto» senza averlo controllato.

Seconda revisione, corretta: una CU dettata con un nome solo simile («Uno Srl», «Cliente Uno Sas») che sostituiva quella di un altro cliente; una riga negativa nella fattura che rimetteva la rata al lordo; i contributi trattenuti dal mandante contati nelle tasse ma non detti, con la percentuale da mettere da parte un po' bassa; il CSV per il commercialista senza la colonna del credito; qualche frase da sistemare.

Terza revisione: niente da correggere.
