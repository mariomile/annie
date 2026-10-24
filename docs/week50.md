# Settimana 50: preventivi

Branch `week-50`. Owni fa i preventivi: numerati, con l'IVA calcolata senza errori, in PDF o Word con la carta intestata dell'azienda. Le scelte sono nell'[ADR 0055](adr/0055-preventivi.md).

## Cosa cambia per chi usa Owni

- **«Fammi un preventivo per Rossi Srl: 3 giornate a 500 €, trasferta 120 €, IVA 22%»**: il PDF pronto con totali, validità e riquadro per l'accettazione, mandato in chat da inoltrare.
- **«Rifai il 12 con lo sconto del 10%»** o **«aggiungi 2 ore»**: una revisione con lo stesso numero.
- **«Quali preventivi sono ancora aperti?»**: i primi 15 con la scadenza e il totale aperto.
- **«Il 12 è stato accettato»**: annotato, e Owni propone di ricordare la fattura.
- **Forfettario, ritenuta, rivalsa INPS o cassa, acconto, prezzi IVA inclusa**: gestiti quando la persona li dice; l'aliquota la sceglie sempre lei.
- **«La mia azienda è in via Roma 1, tel. …, regime forfettario»**: i dati vanno nella carta intestata.

## Cosa funziona (verificato dai test)

`test/quotes.test.ts`: importi italiani e ambigui, totali esatti con aliquote miste, sconti, prezzi ivati, ritenuta, cassa INPS e contributo integrativo, bollo, acconto, numerazione tra anni e revisioni, preventivo tolto se il file non si scrive, ripetizione dopo un riavvio, validità e scaduti, elenco e filtri, stato solo su richiesta, canale agenti e brief, archivio rovinato e limiti, nomi di file, documento riletto in PDF e Word, recinto con nomi ostili, audit senza dati, e una prova dall'app vera.

## Revisioni

Prima revisione, corretta: «1.250» letto come mille e duecentocinquanta, preventivi salvati senza file dopo un errore, revisioni fallite che riaprivano un preventivo rifiutato, tetto totale che bloccava per sempre, note IVA ignorate, prezzi a zero, titoli iniettabili nel documento, azienda senza nome. Aggiunti carta intestata completa, forfettario, prezzi IVA inclusa, acconto e consegna, cassa previdenziale, riquadro per l'accettazione, dati del cliente ripresi, elenco corto per il telefono, righe aggiunte in revisione, preventivi in scadenza nel brief.

Seconda revisione, corretta: una revisione ripetuta dopo un riavvio che rifaceva i conti sulla versione nuova, preventivi accettabili mentre il documento era ancora in preparazione, IVA su un preventivo forfettario senza avviso, aliquota di una riga aggiunta che cambiava le altre, grassetto rotto nel PDF, link con barre in più, file doppi dopo un riavvio, dati di una vecchia azienda rimasti cambiando partita IVA.
