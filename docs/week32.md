# Settimana 32: Owni legge PDF, Word, Excel e PowerPoint

Branch `week-32`. Fino a ieri un preventivo in PDF o un listino in Excel mandato a Owni finiva nel workspace e lei rispondeva «è un file binario». Ora `file_read` ne legge il testo: PDF, Word, Excel, PowerPoint e OpenDocument, senza chiavi, servizi esterni o dipendenze nuove. Chi manda un documento su Telegram, WhatsApp o nella console vede Owni leggerlo e rispondere sul contenuto. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0026](adr/0026-documenti.md).

## Cosa cambia per chi usa Owni

- **Manda un documento e chiedi**: «quanto è il totale?», «riassumi il contratto», «quali clienti hanno ordinato più di 1.000 €?». Il modello riceve il testo con pagine, fogli, diapositive e tabelle distinte.
- **I valori come li vede la persona**: in Excel 12,50 €, 10%, 01/07 e 09:30, non 12.5, 0.1 e 46204. In Word intestazione, piè di pagina (spesso c'è la partita IVA), note, elenchi e link. In PowerPoint le tabelle per righe e i numeri dei grafici.
- **Estratti conto e bollette**: i PDF protetti contro la copia ma che si aprono senza password si leggono. Quelli con una password di apertura no, e Owni lo dice.
- **Scansioni**: Owni dice quali pagine non hanno testo e propone il computer (pagine in immagini, poi le guarda) o una foto.
- **Documenti lunghi**: a pezzi, tagliati a fine riga, con il punto dove riprendono (il foglio e la sua prima riga, la pagina).
- **Vecchi formati**: per `.doc`, `.xls`, `.ppt` e RTF una risposta che dice cosa fare.

## Cosa funziona (verificato dai test)

- Documenti veri fatti con LibreOffice, Chrome, reportlab, python-docx, openpyxl e python-pptx: testo, accenti, €, pagine, fogli, diapositive, tabelle (`test/documents.test.ts`).
- PDF con object stream e xref stream, escape, stringhe esadecimali e kerning; PDF protetti con RC4 40 e 128, AES-128 e AES-256 (revisioni 5 e 6); il PDF con password rifiutato con il motivo.
- File troncati e con byte casuali danno sempre un motivo, mai un errore diverso; zip bomb, bombe di decompressione riusate da mille font, migliaia di delimitatori, lunghe file di spazi finiscono in pochi millisecondi.
- La lettura nel worker: un tempo scaduto e un file che non è un documento danno il motivo, un documento vero il testo.
- `file_read`: intestazione, recinto dei dati, pezzi con `offset` che finiscono a fine riga e dicono dove riprendono, fine del file, vecchi formati (`test/workspace-tools.test.ts`).
- Un PDF mandato su Telegram è annunciato come documento; il caricamento nella console dice al modello che è un Word (`test/web.test.ts`).
- Nel browser: un PDF caricato nella chat della console diventa la nota «Documento PDF … Leggilo con file_read» e Owni ne legge le due pagine, senza errori in console.

## Review indipendente

Due revisori (sicurezza e standard; specifiche e uso, con documenti generati apposta). Corretti:

- **Critica.** Una regex per pulire gli spazi a fine riga impiegava 28 secondi su un Word di 377 byte con 160.000 spazi, bloccando tutte le istanze. Riscritta senza backtracking; nessuna regex su testo lungo con quantificatori sovrapposti.
- **Alta.** I limiti di memoria dei PDF si aggiravano: una bomba di decompressione usata come mappa di caratteri da mille font veniva decompressa mille volte, e l'errore del limite era ingoiato. Ora ogni stream è decodificato una volta, un limite superato ferma tutta la lettura, i font sono in cache per numero d'oggetto. Le mappe di caratteri hanno un tetto di voci. Soprattutto, la lettura gira in un worker thread con 20 secondi e 512 MB: quello che resta di sconosciuto costa al massimo quello.
- **Alta.** Il testo dei documenti andava al modello senza recinto: ora è recintato come le pagine web. Date di Excel scritte da LibreOffice come numeri, formati ignorati (percentuali, euro, decimali), OpenDocument con la dichiarazione XML nel testo, celle su righe diverse, colonne spostate, tabelle contate come diapositive, note a metà frase; tabelle di PowerPoint senza righe; PDF protetti solo contro la copia rifiutati; scansioni con una nota che diceva «non so leggere».
- **Media.** Errori diversi da quello previsto (stack esaurito su delimitatori sparsi); la cache del testo condivisa tra istanze (ora per istanza); PDF riconosciuti da `%PDF-` ovunque nel primo KB (ora vicino all'inizio); pezzi tagliati a metà riga senza contesto; vecchi formati e RTF; Word senza intestazione, piè di pagina, note, link ed elenchi; righe e colonne lontane perse in Excel; etichette OpenDocument goffe; un errore del worker presentato come file rovinato.
- **Funzionale.** Il caricamento di un file non immagine nella console falliva per una variabile sbagliata: trovato anche dal controllo nel browser.

Lasciati, scritti nell'ADR: l'ordine del testo nei PDF è quello del file (un modulo con etichette e valori disegnati separatamente li dà separati; riordinare per posizione rovinerebbe i testi su due colonne); i numeri dei fogli OpenDocument come li ha scritti il programma; niente OCR; un link a un PDF trovato sul web dà ancora solo l'estratto (nuova voce in [stato-e-todo](stato-e-todo.md)).
