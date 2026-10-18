# Settimana 51: allegati nelle mail

Branch `week-51`. Le mail che Annie prepara possono portare file del workspace: il preventivo, le fatture di un sollecito, un report o un contratto. Partono sempre dopo la card di approvazione. Le scelte sono nell'[ADR 0056](adr/0056-allegati-nelle-mail.md).

## Cosa cambia per chi usa Annie

- **«Manda il preventivo 12 a Rossi»**: la card con il PDF allegato e una lettera pronta; dopo l'invio il preventivo risulta «inviato per mail».
- **«Manda il sollecito a Gamma con la fattura allegata»**: il sollecito con l'XML e, se c'è, il PDF della fattura.
- **«Mandami per mail il report»**: va al tuo indirizzo Gmail.
- **«Rispondi a Marco allegando il contratto»**: Annie trova il file, chiede se ce n'è più d'uno, e risponde nella stessa conversazione.
- **Dal telefono**: il file arriva in chat con il testo da copiare e un link che apre la posta.

## Cosa funziona (verificato dai test)

`test/mail-attachments.test.ts`, `test/mail-attachments-flows.test.ts` e `test/google-write.test.ts`: messaggio MIME riletto byte per byte, nomi non ASCII, limiti e tipi (anche file rinominati, zip finti, macro), percorsi fuori dal workspace e link simbolici, file cambiato o sparito all'approvazione, card che non si può falsificare, preventivo scaduto, rifiutato o sostituito, una card per preventivo, indirizzo salvato solo dopo l'invio, solleciti con fatture e PDF di cortesia, invio grande con l'upload di Gmail, canale agenti e brief, audit senza dati, e il percorso intero dall'app fino a Gmail finto.

## Revisioni

Prima revisione, corretta: righe degli allegati falsificabili nel motivo della card e senza cartella, soglia dell'upload calcolata prima della codifica, indirizzo salvato anche con la card rifiutata, troppa memoria con file grandi, HTML rinominato in .txt o .xml e zip qualunque accettati, possibile scambio con un link simbolico, PDF di cortesia presi solo dal nome, preventivi scaduti o rifiutati mandati senza conferma, card doppie, «mandami» senza indirizzo, nomi di strumenti nel testo per la persona, lettera del preventivo poco formale.

Seconda revisione, corretta: vecchi file Office con macro e RTF con oggetti incorporati accettati, PDF di cortesia di un'altra fattura con lo stesso numero corto, letture di PDF senza limite di tempo, un invio lento che bloccava gli altri clienti, caratteri invisibili e lettere simili per imitare la riga degli allegati, nomi lunghi che perdevano l'estensione, margine troppo stretto sui 25 MB di Gmail (ora 17 MiB), file con più collegamenti fisici, preventivo rifiutato dopo la richiesta, card di una versione vecchia che bloccava la revisione.
