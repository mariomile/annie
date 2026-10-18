# Settimana 46: partita IVA nella segreteria

Branch `week-46`. La segreteria ora controlla la partita IVA che trova nelle mail dei clienti, senza rete: se è sbagliata non la salva e nella bozza chiede al cliente di ricontrollarla. Le scelte sono nell'[ADR 0049](adr/0049-partita-iva-nella-segreteria.md).

## Cosa cambia per chi usa Annie

- **Un cliente scrive «P.IVA: IT 012 345 609 01» con una cifra sbagliata**: la bozza aggiunge «Le segnaliamo che la partita IVA indicata non risulta corretta: può cortesemente ricontrollarla e inviarcela di nuovo?», e la scheda su Telegram dice «P.IVA sbagliata: non l'ho salvata, nella bozza chiedo al cliente di ricontrollarla.».
- **Una partita IVA giusta scritta con spazi, punti o «IT»**: salvata pulita.
- **Un numero IVA tedesco o svizzero**: controllato nella forma, salvato con il prefisso.
- **«Budget 15.000 + VAT 20000»** o un cellulare dopo «P.IVA»: non scambiati per una partita IVA.
- **Le domande della bozza** cominciano con la minuscola dopo «Per prepararle un preventivo accurato,».

## Cosa funziona (verificato dai test)

`test/segreteria-vat.test.ts` e `test/vat.test.ts`: etichette e separatori, importi, date e cellulari scartati, numero giusto preferito a quello sbagliato, risposte strane del modello, codici fiscali ignorati, paesi fuori dal VIES, bozza che non ripete il numero, scheda e nota HubSpot, testi lunghi ostili in tempi brevi. Eval della segreteria con 37 casi: i numeri finti dei casi ora passano il controllo, due casi nuovi con partita IVA sbagliata, e l'eval confronta la partita IVA letta con l'atteso.

## Revisioni

Prima revisione, corretta: parole del modello come «None» o «N/A» prese per numeri o per numeri sbagliati, importi e date scambiati per partite IVA, etichette comuni non lette («P.IVA/C.F.», «VAT No.»), il numero che la bozza del modello poteva ripetere, la frase della bozza attaccata a «Per prepararle un preventivo accurato», la riga per il titolare troppo tecnica, il codice fiscale sbagliato detto «partita IVA», il generatore dei casi dell'eval non allineato.

Seconda revisione, corretta: la pulizia delle bozze toglieva anche numeri d'ordine, codici prodotto e date (ora toglie solo numeri dopo un'etichetta IVA o con il prefisso di un paese), telefoni scambiati per partite IVA sbagliate, la lettura della mail che ora corregge una cifra sbagliata dal modello, cifre di controllo per Svizzera e Norvegia, altre etichette europee (MWST, UID, TVA, NIF, BTW), testo pulito dopo aver tolto il numero.

## Da fare

- Console (pagina Segreteria): mostrare «P.IVA da ricontrollare» invece del nome del campo `vatNumberInvalid`.
