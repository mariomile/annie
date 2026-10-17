# Documenti dal web

Con la settimana 32 Annie legge i documenti che le mandano (ADR 0026). Sul web però un PDF restava muto: `web_read` rispondeva «non è una pagina di testo», la ricerca approfondita teneva solo l'estratto del motore di ricerca e il browser diceva che un link portava a un file. Proprio le fonti migliori per un'azienda (un bando, una circolare, un listino, un rapporto annuale) sono spesso PDF.

## Come funziona

- **`web_read`** legge anche un documento: il contenuto decide, non il tipo che dichiara il server (molti mandano i PDF come `application/octet-stream`, alcuni come `text/plain`). Il testo è recintato come quello delle pagine, con `URL`, «Documento PDF, N pagine» e, dal secondo pezzo, il punto dove riprende (il foglio e la sua prima riga, la pagina) dentro il recinto: sono parole del documento. Fuori dal recinto solo quello che dice Annie: dove riprendere, le note, gli errori, che non contengono mai parti del file (i nomi delle parti di un archivio sono stati tolti dai messaggi). A pezzi di 40.000 caratteri con `offset`; le pagine lunghe a pezzi di 12.000. Il testo degli ultimi 4 documenti letti resta in memoria 10 minuti, per istanza: leggere il pezzo dopo non li scarica di nuovo (il controllo dei siti consentiti si rifà comunque).
- **Una pagina elenca i documenti a cui rimanda** («Documenti collegati», fino a 20 link a PDF, Office, OpenDocument e CSV), dentro il recinto: il modello vede che il bando è lì e lo apre con `web_read`.
- **`web_download`** salva un file dal web nel workspace, sotto `download/`, fino a 20 MB: per leggerlo tutto con `file_read` o mandarlo con `file_send` («scaricami il listino e mandamelo»). Il nome viene da `name`, poi da `Content-Disposition` (`filename*` prima di `filename`), poi dall'indirizzo, ripulito (lettere di ogni lingua, cifre, spazi, `.-_`). L'estensione è quella che dicono i byte: un PDF finisce in `.pdf` anche se l'indirizzo diceva altro. Un file che i byte non riconoscono e con un'estensione che si eseguirebbe o si aprirebbe in un browser (`.exe`, `.js`, `.html`, `.svg`…) prende `.txt` in fondo. Una pagina HTML non si salva: Annie dice di aprirla con `web_read` per trovare il link. Un file diverso con lo stesso nome non sostituisce mai quello di prima: prende un suffisso con l'hash del contenuto; lo stesso file torna allo stesso percorso, così rifare la chiamata dà lo stesso risultato. Ogni salvataggio scrive `web.download` nell'audit con percorso e byte, mai l'indirizzo.
- **La ricerca approfondita** legge i risultati che sono documenti, fino a 10 MB e con 5 secondi di lettura, e ne tiene i passaggi che servono a gruppi di tre righe, ciascuno con la pagina o il foglio (e la riga delle intestazioni del foglio) da cui viene, con «PDF, N pagine» in testa. Un documento senza testo dice «forse una scansione».
- **Il browser** continua a non scaricare file; la nota dice di usare `web_read` o `web_download` con l'indirizzo che elenca.
- **Stesse regole delle pagine**: solo i siti che l'owner consente, mai indirizzi interni, controllati a ogni redirect. Il limite di 2 MB resta per le pagine; un documento (tipi PDF, Office, OpenDocument, `octet-stream`, o un indirizzo che finisce in `.pdf`, `.docx`… e non è HTML) arriva fino a 20 MB, deciso dalle intestazioni prima di leggere il corpo.

## Limiti di risorse

- **Tempo**: il limite di `webFetch` vale per tutta la richiesta, redirect compresi (prima valeva per ogni passaggio). `web_download` ha 60 secondi, `web_read` e la ricerca 15.
- **Memoria**: il corpo arriva in un solo buffer della dimensione annunciata, senza la copia finale; il testo UTF-8 di un documento non si calcola più (si decodifica solo se qualcuno lo legge). In tutto il processo, i corpi più grandi di una pagina in arrivo insieme non superano 100 MB: oltre, la richiesta si ferma con «riprova tra poco».
- **Lettore**: i due worker della settimana 32 sono condivisi. Una richiesta che aspetta un worker libero più di 45 secondi (10 nella ricerca) riceve «riprova tra poco» invece di aspettare senza fine; la ricerca legge ogni documento con 5 secondi al massimo, così una ricerca con PDF pesanti non tiene fermi i file mandati dalle persone.

## Alternative scartate

- **Leggere i documenti solo dopo `web_download`.** Due passi per una domanda semplice («cosa dice questo PDF?»), e il modello non sempre li fa.
- **Aprire i PDF nel browser.** Chromium headless non mostra i PDF come testo; e il browser di Annie non scarica niente per scelta (ADR 0014).
- **Fidarsi del Content-Type.** Troppi server sbagliano; i byte sono la verità.
- **Sovrascrivere un download con lo stesso nome.** `download?id=1` e `download?id=2` diventavano lo stesso file, e un messaggio che citava il primo puntava al secondo.

## Conseguenze

- `web_download` scrive nel workspace senza approvazione: è una lettura, come `web_read`, e resta nei limiti di dimensione del workspace. Un file salvato può contenere istruzioni nascoste: `file_read` lo recinta come dati.
- Un documento più grande di 20 MB non si legge né si salva; Annie lo dice e offre il link.
- Un worker riservato alle persone non c'è: i limiti di tempo e di attesa bastano per ora. Se il carico cresce, il passo dopo è un worker riservato a `file_read`.
