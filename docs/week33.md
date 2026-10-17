# Settimana 33: Annie legge PDF e documenti dal web

Branch `week-33`. Con la settimana 32 Annie leggeva i documenti che le mandano; un link a un PDF sul web però restava muto: `web_read` rispondeva «non è una pagina di testo», la ricerca approfondita teneva solo l'estratto del motore di ricerca. Ora un bando, una circolare, un listino o un rapporto annuale in PDF si leggono come una pagina, si salvano nel workspace e finiscono nei report. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0027](adr/0027-documenti-dal-web.md).

## Cosa cambia per chi usa Annie

- **«Cosa dice questo PDF?»** con un link: Annie ne legge il testo, a pezzi se è lungo, anche quando il sito lo manda con il tipo sbagliato.
- **Una pagina elenca i documenti collegati**: chiedi «c'è un bando su questa pagina?» e Annie vede il link al PDF e lo apre.
- **«Scaricami il listino e mandamelo»**: `web_download` salva il file in `download/` (nome dal sito, accenti compresi, estensione giusta) e Annie lo manda con `file_send`. Un altro file con lo stesso nome non cancella quello di prima.
- **Report con i PDF**: la ricerca approfondita usa il testo dei documenti che trova, con la pagina o il foglio da cui viene ogni passaggio.
- **Quando non si può**, Annie dice perché: PDF con password, scansione senza testo, file oltre 20 MB (offre il link), vecchi formati Office, una pagina di login al posto del file.

## Cosa funziona (verificato dai test)

- `web_read` su un PDF, un Excel mandato come `octet-stream` e un PDF mandato come `text/plain`; un'immagine, un vecchio `.xls`, un PDF protetto o rovinato danno il motivo (`test/web-documents.test.ts`).
- Un documento lungo a pezzi: il secondo pezzo dice dove riprende, dentro il recinto, e non scarica di nuovo il file.
- I link ai documenti di una pagina, assoluti e senza `javascript:`.
- `web_download`: nome dall'indirizzo, da `Content-Disposition` (con `filename*` in UTF-8) o da `name`; estensione dai byte; `.exe` senza contenuto riconoscibile salvato come `.exe.txt`; pagina HTML rifiutata; stesso file allo stesso percorso, file diverso con suffisso; riga nell'audit senza indirizzo; siti non consentiti rifiutati.
- La ricerca approfondita legge un PDF tra i risultati e ne cita il totale con la pagina.
- Un nome di una parte di un archivio scelto da chi ha fatto il file non compare mai negli errori (`test/web-documents.test.ts`); il lettore condiviso dà «riprova tra poco» a chi aspetta troppo (`test/documents.test.ts`); il limite di tempo vale per tutti i redirect insieme (`test/web-tools.test.ts`).
- Nel browser: in chat della console, `web_download` di un PDF e `web_read` dello stesso indirizzo; il file compare in «File». Nessun errore in console.

## Review indipendente

Due revisori (sicurezza e standard; specifiche e uso, con siti e documenti costruiti apposta). Corretti:

- **Media (sicurezza).** I messaggi di errore di un archivio rovinato contenevano il nome della parte, scelto da chi ha fatto il file, fuori dal recinto: una via per istruzioni nascoste da qualunque sito consentito. Tolti i nomi dai messaggi; anche il punto dove riprende un documento, testo del file, ora è dentro il recinto (pure in `file_read`).
- **Media (risorse).** Un documento da 19 MB costava circa 90 MB di memoria (copie e il testo UTF-8 mai usato), moltiplicati per le letture in parallelo della ricerca. Ora un solo buffer, il testo solo se serve, 100 MB in tutto il processo per i corpi grandi, 10 MB e 5 secondi per i documenti della ricerca, e chi aspetta un lettore libero più di 45 secondi riceve «riprova tra poco» invece di aspettare senza fine.
- **Media (uso).** `web_read` buttava i link ai documenti; il server che manda un PDF come testo vinceva sui byte; leggere il pezzo dopo riscaricava tutto; i download con lo stesso nome si sostituivano; il nome ignorava `Content-Disposition`; una pagina di login si salvava come `.pdf`.
- **Bassa.** Il tempo massimo valeva per ogni redirect (fino a 6 minuti); nessuna riga di audit per i download; un nome con un carattere Unicode spezzato faceva fallire il salvataggio; estensioni pericolose tenute; frase del prompt di sistema sbagliata; commenti fuori posto e funzioni duplicate con `file_read`.

Lasciato, scritto nell'ADR: niente worker riservato a `file_read` (bastano i limiti di tempo e di attesa); niente OCR delle scansioni.
