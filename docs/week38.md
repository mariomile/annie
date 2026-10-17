# Settimana 38: registrazioni lunghe trascritte con i tempi

Branch `week-38`. Annie capiva i vocali fino a cinque minuti; una riunione registrata, una chiamata o un video restavano un file. Ora `audio_transcribe` trascrive registrazioni di qualunque durata (fino a 180 minuti di default), a pezzi di dieci minuti, con il minuto di ogni passaggio e, con Mistral, le voci distinte. La trascrizione va in `trascrizioni/` e Annie ne fa il riassunto o il verbale. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0033](adr/0033-registrazioni-lunghe.md).

## Cosa cambia per chi usa Annie

- **«Fammi il verbale»** con l'MP3 o l'M4A della riunione: Annie trascrive, legge tutto e scrive decisioni, chi fa cosa e scadenze, citando i minuti.
- **Un vocale di venti minuti** su Telegram o WhatsApp non è più rifiutato: diventa una registrazione, Annie lo trascrive e risponde.
- **Il video della riunione** mandato dalla chat o dalla console: Annie trascrive solo il sonoro, che pesa una frazione del video.
- **«Cosa ha detto il cliente sul prezzo?»**: la frase con il suo minuto, [12:40].
- **Chi parla**: con Mistral le voci sono distinte (Voce 1, Voce 2); il servizio non sa i nomi, e in una registrazione lunga le numera di nuovo in ogni pezzo, cosa che il file e Annie dicono.
- **Oltre i 20 MB** che una chat lascia scaricare, Annie dice come mandarla (M4A o MP3 a qualità più bassa, o divisa).

## Cosa funziona (verificato dai test)

- Formati: MP3 (anche VBR con frame Xing), M4A, video MP4, WAV (anche con la dimensione sbagliata), Ogg Opus e Vorbis, FLAC, AMR (durata contata frame per frame), WebM (senza durata: contata dalla dimensione); immagini HEIC e documenti non scambiati per registrazioni (`test/recordings.test.ts`).
- Divisione: pezzi di durata simile, uno dopo l'altro senza buchi, ognuno un file valido; pagine Ogg numerate da zero, CRC giusti, fine del flusso segnata; WAV diviso anche per dimensione; con ffmpeg (dove c'è) ogni pezzo si decodifica senza errori.
- File rovinati o contraffatti: indici MP4 che girerebbero all'infinito o moltiplicherebbero i byte, tempi Ogg che tornano indietro, WAV con una velocità che non torna, intestazioni troppo corte: sempre un errore chiaro, mai un crash; 300 file rovinati a caso danno solo `AudioError`.
- Trascrizione: tempi nella registrazione intera, voci per pezzo, minuti riservati prima e restituiti se il servizio fallisce, un nuovo tentativo solo per gli errori temporanei, niente rifatto né ricontato dopo un riavvio, file mai sovrascritto, inizio mostrato con l'offset da cui leggere il resto.
- Servizio: Mistral con `timestamp_granularities` e `diarize`, OpenAI `whisper-1` con `verbose_json`, gli altri solo testo; la chiave mai negli errori.
- Canali: il vocale lungo e l'audio lungo di Telegram, il video e la nota video, il vocale lungo e il video di WhatsApp diventano file nel workspace con formato e durata; senza servizio di trascrizione un vocale resta un vocale.
- In un'istanza vera: la trascrizione rifiutata finché l'owner non la consente, poi fatta dalla chat.
- Nel browser: un M4A caricato dalla console e trascritto, alla larghezza di un computer e di un telefono; nessun errore in console.

## Review indipendente

Due revisori: sicurezza e standard, con file costruiti apposta e ffmpeg; specifiche e uso. Corretti:

- **Alta (sicurezza).** Un indice MP4 con zero campioni per blocco faceva girare il parser per minuti; campioni sovrapposti o tempi Ogg alternati moltiplicavano un file da 1 MB in centinaia di MB di pezzi a durata zero, fuori dai limiti e dai minuti del giorno. Ora indici, somme, tempi e velocità sono controllati contro il file, le intestazioni ripetute hanno un tetto e i pezzi non possono essere più di quanti dimensione e durata ne chiedono.
- **Media (sicurezza).** Due letture oltre la fine davano `RangeError` invece di `AudioError`; WebM e AMR senza durata passavano gratis; i minuti erano dell'intero server e non dell'account; due trascrizioni insieme passavano lo stesso controllo; il testo d'errore del servizio arrivava al modello fuori dal recinto (ora solo il codice).
- **Bassa (sicurezza).** Un nuovo tentativo anche per gli errori definitivi; l'attesa non si fermava se la persona annullava; il WAV perdeva i chunk prima del suono.
- **Alta (uso).** Le voci di pezzi diversi si mescolavano (il servizio le numera di nuovo a ogni richiesta); il limite vero è di 20 MB e non era detto; senza servizio di trascrizione un vocale lungo diventava un file che nessuno poteva trascrivere.
- **Media (uso).** I video su Telegram e WhatsApp erano ignorati; la descrizione prometteva i tempi anche ai servizi che non li danno; «l'ora» sembrava un orario; il resto della trascrizione si rileggeva dall'inizio (ora c'è l'offset); mancava come mandare la trascrizione (`file_send`) e di avvisare che ci vuole qualche minuto.
- **Bassa (uso).** «1 minuti», il prefisso del messaggio nel titolo, «pezzo di dieci minuti» anche quando il pezzo è più corto, messaggio d'errore in inglese.

Lasciato: la nota con formato e durata nella casella della console la scrive la console (`app.js`), che riceve già `recording` dal caricamento e la userà con il lavoro sulla console; fino ad allora lì il file arriva come «File caricato» e Annie lo riconosce dall'estensione.
