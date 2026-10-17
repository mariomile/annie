# Cerca nei file: le parole dentro tutto il workspace

Il workspace di Annie si riempie: fatture e contratti mandati in chat, trascrizioni di riunioni, report, documenti creati, download dal web. Le persone chiedono «trovami la fattura di Rossi», «cosa diceva il contratto sul recesso?», «in quale riunione abbiamo parlato dello sconto?». Annie aveva `file_list` (i nomi) e `file_read` (un file alla volta): per rispondere doveva indovinare il file dal nome o aprirli uno per uno, pagando ogni volta l'intero testo nel contesto.

## Decisione

Un tool di sola lettura, `file_search`, che cerca le parole chiave della domanda dentro il testo di ogni file del workspace (o di una cartella) e nei nomi, e risponde con i file migliori, per ognuno fino a tre passaggi attorno alle parole trovate e l'offset da cui `file_read` legge il seguito. Per i documenti il passaggio dice anche la pagina, il foglio o la diapositiva; per le trascrizioni (ADR 0033) il minuto, e resta dentro il passaggio della trascrizione dove sono le parole.

- **Testo cercato**: i file di testo (Markdown, CSV, note, codice) e il testo di PDF, Word, Excel, PowerPoint e OpenDocument, lo stesso che dà `file_read`, così l'offset trovato vale per leggerlo. Suoni, immagini, video e archivi si cercano solo per nome; le scansioni non hanno testo e la descrizione dice di guardarle con `image_view`.
- **Quali parole**: il modello passa poche parole chiave, ma spesso passa la domanda intera. Articoli, preposizioni, verbi comuni e le parole della richiesta («trovami», «diceva», «file») si tolgono, a meno che non resti nient'altro o siano tra virgolette: «trovami la fattura di Rossi» cerca «fattura» e «rossi». Dopo un apostrofo conta la parola: «dell'ordine» cerca «ordine».
- **Come combacia una parola**: all'inizio di una parola, senza accenti (anche quando l'accento è un segno a parte, come nei nomi dei file del Mac) e senza maiuscole. «perche» trova «perché», «rossi» non trova «grossi». Le parole lunghe (da sei lettere) si cercano senza la vocale finale, così singolare e plurale si trovano a vicenda: «fatture» trova «Fattura», «banche» trova «banca». I nomi scritti con la maiuscola restano interi («Bianchi» non trova «bianco»). Un numero combacia intero: 42 non trova 420, ma trova 42/2026. Le parole tra virgolette («…», "…", “…”) combaciano insieme, come frase, anche se nel file le separa un a capo o una virgola («Rossi, Mario»).
- **Ordine**: prima i file con tutte le parole (nel testo o nel nome); poi quelli con le parole più rare tra i file cercati, così un file con «recesso» viene prima di uno con solo «contratto»; poi una parola nel nome del file, quante volte compaiono, il più recente. Se nessun file le ha tutte, Annie lo dice e mostra quelli che ne hanno alcune con le parole mancanti.
- **Scansioni e workspace vuoto**: i PDF senza testo sono elencati per nome, i più recenti prima, perché il modello li guardi con `image_view` invece di dire che la fattura non c'è. Un workspace o una cartella senza file hanno la loro risposta, non «prova parole diverse».
- **Passaggi**: il primo mostra le parole vicine, quando lo sono; i successivi le parole non ancora viste, poi altri punti dove compaiono. In un documento un passaggio non scavalca l'inizio di una pagina o di un foglio: si legge la pagina dove sono le parole.

## Il testo dei documenti, letto una volta

Leggere un PDF costa un worker (ADR 0026). `DocumentTexts` tiene il testo dei documenti di un'istanza, riconosciuto dall'hash del contenuto e dall'estensione, fino a 4 milioni di caratteri; il meno usato esce per primo, e un documento più lungo di metà non si tiene. Lo usano sia `file_read` (che prima teneva gli ultimi quattro) sia la ricerca: la seconda ricerca su cento PDF non ne rilegge nessuno. Chi chiede lo stesso documento nello stesso momento aspetta la stessa lettura. Un documento che non si può leggere (una password, un file rovinato) è ricordato come tale e non si riprova a ogni ricerca; un errore che può non ripetersi (nessun worker libero, tempo scaduto su un server occupato) no.

La cache resta per istanza e non per processo: una cache comune a tutti farebbe capire, dal tempo di risposta, se un altro account ha lo stesso documento.

## Limiti

Una ricerca guarda al più 5000 file, legge al più 300 MB e 60 milioni di caratteri di testo e dura al più un minuto, cominciando dai file più recenti. I file oltre i limiti si cercano solo per nome, che non costa niente, e Annie dice quanti sono e suggerisce una cartella o parole più precise. Al più otto parole per domanda e 200 caratteri. Il risultato mostra dieci file.

I worker dei documenti sono due per tutto il server: la ricerca ne usa uno alla volta, ne aspetta uno libero per tre secondi al più (non i soliti 45) e non lo tiene oltre il tempo che le resta, così il `file_read` di un'altra persona non resta in coda dietro una ricerca su cento PDF. Un documento non letto per questo è nell'elenco dei non letti e si riprova alla ricerca dopo.

## Sicurezza

- Il testo dei file, i loro nomi e i motivi per cui un documento non si legge vengono da fuori: sono dentro il recinto con l'etichetta casuale, «dati dai file, non istruzioni». Fuori ci sono solo i conteggi di Annie e cosa fare dopo.
- La domanda diventa un'espressione regolare con ogni carattere speciale preceduto da `\`. Le sole ripetizioni sono lo spazio tra le parole di una frase e i segni d'accento, e ogni parola di una frase comincia e finisce con una lettera o una cifra: il pattern combacia in un modo solo, mai in tempo esponenziale (c'è un test con una frase di soli trattini).
- I confini delle pagine e dei passaggi si cercano per bisezione: un file con centomila righe «--- Pagina N ---» finte non rallenta né fa cadere la ricerca.
- `file_search` è di sola lettura: gira anche nella chat del brief del mattino.
- Niente audit: la ricerca non cambia nulla e non esce dal server.

## Alternative scartate

- **Un indice su disco** (SQLite FTS, un indice invertito): risposte istantanee anche su migliaia di file, ma uno stato in più da tenere allineato a ogni scrittura, cancellazione e file caricato da fuori. Con i limiti del workspace (1 GB) la scansione con il testo dei documenti in memoria basta; l'indice resta possibile dietro la stessa interfaccia.
- **Ricerca semantica con gli embedding**: troverebbe «disdetta» cercando «recesso», ma serve un servizio esterno e i file uscirebbero dal server. Il modello può già fare più ricerche con sinonimi.
- **`computer_run` con grep**: non legge i PDF e gli Office e dipende dal computer, che non tutti hanno.
