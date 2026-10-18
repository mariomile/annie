# Settimana 58: fatture in uscita

Branch `week-58`. Annie prepara la fattura elettronica: da un preventivo accettato, dalle ore non fatturate o da quello che le detti, con numerazione, IVA o forfettario, bollo, cassa e ritenuta, e la emette solo dopo il sì. Il file XML è pronto da caricare sul portale dell'Agenzia delle Entrate, con la copia di cortesia in PDF. Le scelte sono nell'[ADR 0072](adr/0072-fatture-in-uscita.md).

## Cosa cambia per chi usa Annie

- **«Fammi la fattura a Rossi per il preventivo 4»**: la bozza con le righe del preventivo; il preventivo poi risulta fatturato.
- **«Fattura a Beta le ore di ottobre»**: le ore non fatturate diventano righe, e dopo l'emissione sono segnate con la fattura.
- **«Fattura a Gamma: consulenza 1.500 €»**: dalle righe dette. Quello che manca (i tuoi dati, quelli del cliente, il bollo) è chiesto tutto in una volta.
- **«Va bene, emettila»**: il numero, l'XML in `fatture/emesse/`, il PDF, come caricarlo e la scadenza dei 12 giorni.
- **«Nota di credito per la fattura 12»**: tutta o in parte, anche per rifarla al cliente giusto.
- **«Le fatture che mi hai fatto quest'anno»**: l'elenco con i totali (per «quanto ho fatturato» resta `clients`, che conta anche le fatture fatte altrove).
- **Nel brief**: una bozza ferma da più di 7 giorni o una fattura da completare.

## Cosa funziona (verificato dai test)

`test/sales-invoices.test.ts`: forfettario con e senza bollo (77,47 e 77,48 €) e bollo a carico del cliente, ordinario con aliquote miste e nature, ritenuta, rivalsa INPS e cassa nell'ordine giusto, spese anticipate fuori da cassa e ritenuta, note di credito per riepilogo, numerazione negli anni, dal numero detto e dai file, emissioni contemporanee, bozze tolte, chiamate ripetute, fatture da completare, privati, estero e PA, testo ostile e limiti dei campi, rilettura con il lettore delle fatture, ore e preventivi segnati, scadenzario, canale agenti, audit senza dati, file rovinato e file mai sovrascritti. Dati finti in tutti i test.

## Revisioni

Prima revisione, corretta: numerazione che ripartiva sempre da 1; una bozza tolta mentre veniva emessa che cancellava la fattura; ore e preventivo mai segnati se l'emissione si fermava a metà; ritenuta e cassa calcolate anche sulle spese anticipate; ritenuta accettata verso un privato; note di credito su aliquote che la fattura non aveva; un telefono di 12 cifre che bloccava ogni fattura; cinque giri di domande al primo uso e l'IBAN mai chiesto; bozze da preventivo non modificabili; bozza troppo lunga e piena di codici; niente istruzioni per caricare il file; partite IVA di aziende vere nei test.

Seconda revisione, corretta: un XML qualsiasi nel workspace con la partita IVA del venditore che spostava la numerazione o la bloccava; una fattura da completare che non si poteva completare, e il rischio di emettere un'altra bozza al suo posto; ritenuta a zero su fatture di sole spese; l'audit contato a ogni ripresa; l'IBAN chiesto a ogni fattura; un cliente nuovo con un nome che contiene quello di un altro impossibile da fatturare; un nome di 16 lettere preso per un codice fiscale; numero promesso nella bozza diverso da quello dato senza spiegazione.

Terza revisione, corretta: due clienti con lo stesso nome e partite IVA diverse confusi, con il codice destinatario dell'uno sulla fattura dell'altro; un nome esatto con un'altra partita IVA che mescolava i dati di due aziende; l'audit di un'emissione perso dopo un riavvio a metà.
