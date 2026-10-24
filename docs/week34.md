# Settimana 34: Owni guarda le pagine scansionate

Branch `week-34`. Una ricevuta passata allo scanner, un contratto firmato e scansionato, un bando pubblicato come immagine: PDF senza testo, che Owni finora non poteva leggere senza il computer. Ora `image_view` con il percorso del PDF e `page` le mostra la pagina e Owni legge da sola quello che c'è scritto, tabelle e scrittura a mano comprese. Niente OCR, chiavi o dipendenze nuove. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0028](adr/0028-pagine-scansionate.md).

## Cosa cambia per chi usa Owni

- **Manda una scansione e chiedi**: «quanto è il totale di questa ricevuta?». Owni prova a leggerla, vede che non ha testo e guarda la pagina.
- **Più pagine**: Owni le guarda una alla volta, annotando quello che serve.
- **Scansioni dal web**: un bando scansionato trovato con `web_read` si salva con `web_download` e si guarda allo stesso modo.
- **Quando non si può** (formati JBIG2 e JPEG 2000, pagine disegnate come figure): Owni usa il computer se c'è, altrimenti chiede una foto della pagina.

## Cosa funziona (verificato dai test)

- Scansioni JPEG, fax gruppo 4 e gruppo 3 (identiche pixel per pixel all'originale, anche a 2.600 pixel di larghezza), RGB, tavolozze, un solo inchiostro, immagini inline, LZW, RunLength, predittori su pixel di tre byte (`test/scans.test.ts`).
- Una pagina in strisce arriva intera, dall'alto in basso; una pagina girata lo dice; righe salvate dal basso rimesse a posto; un logo su una pagina di testo riconosciuto come tale.
- File costruiti per consumare memoria o tempo rifiutati subito: dimensioni enormi su un byte di dati, righe fax che non vanno avanti, colori che un PNG non può tenere.
- `image_view` nel worker: il testo che accompagna la pagina, la pagina che non c'è, una pagina senza immagini e un JBIG2 con il comando per il computer e la foto come alternativa.
- Nel browser: un PDF scansionato caricato nella chat della console, `image_view` della seconda pagina, nessun errore in console.

## Review indipendente

Due revisori (sicurezza e standard; specifiche e uso, con 21 PDF costruiti apposta). Corretti:

- **Alta (sicurezza).** Un PDF di 440 byte con un'immagine di 7.745×7.745 pixel e un solo byte di dati faceva allocare più di un gigabyte fuori dal limite del worker (che vale solo per il heap). Ora ogni dimensione è controllata prima di creare buffer, i dati mancanti non si riempiono, i lati sono al massimo 8.000 pixel.
- **Alta (sicurezza).** RGB sotto gli 8 bit dava PNG non validi; immagini oltre 8.000 pixel per lato avrebbero fatto fallire ogni turno successivo della conversazione.
- **Media (sicurezza).** Il decodificatore fax poteva restare fermo sulla stessa posizione: tempo quadratico (20 secondi con un file di 3 KB, bloccando la lettura dei documenti di tutti) e mezzo gigabyte di memoria. Ora ogni passo va avanti o la riga è rovinata. Parametri fax negativi davano un errore generico.
- **Uso.** Una scansione in strisce mostrava solo la striscia più grande; immagini inline, LZW e RunLength non si leggevano; pagine girate e capovolte ignorate; una pagina senza immagini rimandava a `file_read`, che rimandava a `image_view`; senza computer non c'era alternativa (ora la foto); il comando per il computer era vago; un PDF misto dal web non diceva di salvarlo prima; `page` non valido mostrava la pagina 1; un logo veniva presentato come la pagina.

Lasciati, scritti nell'ADR: JBIG2 e JPEG 2000 (al computer o con una foto), la rotazione dei JPEG (il modello la legge dal testo), i JPEG CMYK passati come sono.
