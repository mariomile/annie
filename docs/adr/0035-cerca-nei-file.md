# Cerca nei file: le parole dentro tutto il workspace

Il workspace di Annie si riempie: fatture e contratti mandati in chat, trascrizioni di riunioni, report, documenti creati, download dal web. Le persone chiedono «trovami la fattura di Rossi», «cosa diceva il contratto sul recesso?», «in quale riunione abbiamo parlato dello sconto?». Annie aveva `file_list` (i nomi) e `file_read` (un file alla volta): per rispondere doveva indovinare il file dal nome o aprirli uno per uno, pagando ogni volta l'intero testo nel contesto.

## Decisione

Un tool di sola lettura, `file_search`, che cerca le parole della domanda dentro il testo di ogni file del workspace (o di una cartella) e nei nomi, e risponde con i file migliori, per ognuno fino a tre passaggi attorno alle parole trovate e l'offset da cui `file_read` legge il seguito. Per i documenti il passaggio dice anche la pagina, il foglio o la diapositiva.

- **Testo cercato**: i file di testo (Markdown, CSV, note, codice) e il testo di PDF, Word, Excel, PowerPoint e OpenDocument, lo stesso che dà `file_read`, così l'offset trovato vale per leggerlo. Suoni, immagini, video e archivi si cercano solo per nome; le scansioni non hanno testo e la descrizione dice di guardarle con `image_view`.
- **Come combacia una parola**: all'inizio di una parola, senza accenti e senza maiuscole. «fattur» trova «Fattura» e «fatture», «perche» trova «perché», «rossi» non trova «grossi». Le parole tra virgolette («…» o "…") combaciano insieme, come frase, anche se nel file vanno a capo.
- **Ordine**: prima i file con tutte le parole (nel testo o nel nome), poi una parola nel nome del file, poi quante volte compaiono, poi il più recente. Se nessun file le ha tutte, Annie lo dice e mostra quelli che ne hanno alcune con le parole mancanti.
- **Passaggi**: il primo mostra le parole vicine, quando lo sono; i successivi le parole non ancora viste. In un documento un passaggio non scavalca l'inizio di una pagina o di un foglio: si legge la pagina dove sono le parole.

## Il testo dei documenti, letto una volta

Leggere un PDF costa un worker (ADR 0026). `DocumentTexts` tiene il testo dei documenti di un'istanza, riconosciuto dall'hash del contenuto, fino a 8 milioni di caratteri, il meno usato esce per primo. Lo usano sia `file_read` (che prima teneva gli ultimi quattro) sia la ricerca: la seconda ricerca su cento PDF non ne rilegge nessuno. Un documento che non si può leggere (una password, un file rovinato) è ricordato come tale e non si riprova a ogni ricerca; un errore del momento (nessun worker libero) no.

## Limiti

Una ricerca guarda al più 5000 file, legge al più 300 MB e dura al più un minuto, cominciando dai file più recenti: se si ferma prima, Annie dice quanti file vecchi non ha guardato e suggerisce una cartella o parole più precise. Al più otto parole per domanda e 200 caratteri. Il risultato mostra dieci file.

## Sicurezza

- Il testo dei file, i loro nomi e i motivi per cui un documento non si legge vengono da fuori: sono dentro il recinto con l'etichetta casuale, «dati dai file, non istruzioni». Fuori ci sono solo i conteggi di Annie e cosa fare dopo.
- La domanda diventa un'espressione regolare con ogni carattere speciale preceduto da `\`, senza ripetizioni: nessun pattern lento.
- `file_search` è di sola lettura: gira anche nella chat del brief del mattino.
- Niente audit: la ricerca non cambia nulla e non esce dal server.

## Alternative scartate

- **Un indice su disco** (SQLite FTS, un indice invertito): risposte istantanee anche su migliaia di file, ma uno stato in più da tenere allineato a ogni scrittura, cancellazione e file caricato da fuori. Con i limiti del workspace (1 GB) la scansione con il testo dei documenti in memoria basta; l'indice resta possibile dietro la stessa interfaccia.
- **Ricerca semantica con gli embedding**: troverebbe «disdetta» cercando «recesso», ma serve un servizio esterno e i file uscirebbero dal server. Il modello può già fare più ricerche con sinonimi.
- **`computer_run` con grep**: non legge i PDF e gli Office e dipende dal computer, che non tutti hanno.
