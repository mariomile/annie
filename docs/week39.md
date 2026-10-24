# Settimana 39: cerca nei file

Branch `week-39`. Il workspace si riempie di fatture, contratti, trascrizioni e report, ma Owni poteva solo elencare i nomi o aprire un file alla volta. Ora `file_search` cerca le parole dentro tutti i file e nei loro nomi, e risponde con il passaggio trovato, la pagina, il foglio o il minuto, e il punto da cui `file_read` legge il seguito. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0035](adr/0035-cerca-nei-file.md).

## Cosa cambia per chi usa Owni

- **«Trovami la fattura di Rossi»**: Owni cerca «fattura» e «rossi» nei PDF, nei Word e nelle note, e indica il file e la pagina.
- **«Cosa diceva il contratto sul recesso?»**: il passaggio con le parole, e Owni legge il seguito dal punto giusto invece di tutto il contratto.
- **«In quale riunione abbiamo parlato dello sconto?»**: la trascrizione e il minuto («al minuto 04:10»).
- **«Dov'è il file del preventivo?»**: anche se il nome del file è solo in parte quello detto, e anche per foto, audio e video, che si cercano per nome.
- **Fatture scansionate**: se la fattura è una scansione senza testo, Owni la vede nell'elenco e la guarda con `image_view` invece di dire che non c'è.
- **Plurali, accenti, apostrofi**: «fatture» trova «Fattura», «perche» trova «perché», «l'IVA» trova «dell’IVA».

## Cosa funziona (verificato dai test)

- Domande: parole tra virgolette come frase (anche con a capo e virgole in mezzo), articoli, preposizioni e verbi della richiesta tolti, parola dopo l'apostrofo, singolare e plurale per le parole lunghe, nomi con la maiuscola interi, numeri interi (42 non è 420), accenti come segni a parte (`test/file-search.test.ts`).
- Ordine: prima i file con tutte le parole, poi quelli con le parole più rare, il nome, la frequenza, il più recente; le parole mancanti dette file per file.
- Passaggi: fino a tre, con le parole vicine, poi le altre, poi altri punti; dentro la pagina di un PDF, il foglio di un Excel, il passaggio di una trascrizione; offset che `file_read` usa per leggere il seguito.
- Risposte: conteggi in italiano corretto, nessun risultato con il consiglio di riprovare una volta, scansioni e documenti non letti per nome, workspace e cartelle vuoti, file oltre i limiti cercati per nome.
- Testo dei documenti letto una volta per contenuto, condiviso con `file_read`; letture contemporanee dello stesso documento unite; documenti protetti ricordati, errori del momento no; il meno usato esce.
- Sicurezza: tutto quello che viene dai file (passaggi, nomi, motivi) dentro il recinto; una frase di soli trattini in tempo lineare; duecentomila righe di pagina finte senza cadere; l'interruzione del turno ferma la ricerca.
- In un'istanza vera: da Telegram un file scritto e poi trovato per le sue parole (`test/workspace-tools.test.ts`).

## Review indipendente

Due revisori: sicurezza e standard; specifiche e uso, con domande vere provate a mano. Corretti:

- **Alta (sicurezza).** Una frase tra virgolette con parole fatte solo di punteggiatura dava un pattern lento in modo esponenziale (3,4 secondi con dieci trattini, il server fermo). Ora ogni parola di una frase comincia e finisce con una lettera o una cifra. Un documento con centinaia di migliaia di righe «--- Pagina N ---» faceva cadere la ricerca: i confini si cercano per bisezione.
- **Media (sicurezza).** Una ricerca prendeva entrambi i worker dei documenti del server per un minuto: ora uno, con un'attesa di tre secondi e mai oltre il suo tempo. Due letture contemporanee dello stesso documento lo contavano due volte nella cache. Un documento enorme restava in memoria. Il tempo scaduto su un server occupato era ricordato come errore per sempre.
- **Alta (uso).** La domanda intera («trovami la fattura di Rossi») rendeva obbligatori «la» e «di» e metteva prima il file sbagliato: ora si tolgono e conta la rarità delle parole. Errori di grammatica nei conteggi («2 file la contiene»). Le scansioni contavano come cercate senza dirlo. Le trascrizioni perdevano il minuto.
- **Media (uso).** Apostrofi curvi, singolare e plurale, virgolette curve, frasi con la virgola in mezzo, numeri che trovavano numeri più lunghi, workspace vuoto con il consiglio di cambiare parole.
- **Bassa.** Descrizione del tool (parole chiave, niente OR, il minuto, riprovare una volta), una sola frase per le parole singole, nomi dei file oltre i limiti, espressioni duplicate, «perché» che trovava «percorso».

Lasciato, scritto nell'ADR: niente indice su disco e niente ricerca per significato; la cache dei documenti resta per istanza.
