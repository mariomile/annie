# 0106: Browser personale e controllo umano

Il browser della chat permetteva di aprire pagine e cliccare, ma rifiutava password e invii. I cookie vivevano soltanto per la breve durata della sessione. Un sito che richiedeva accesso interrompeva quindi il lavoro.

## Decisione

Nelle conversazioni private della console, la persona può prendere il controllo del browser, scrivere nel campo selezionato e inviare un modulo semplice. Durante il controllo umano gli strumenti dell'agente non possono guidare o leggere il browser. La persona restituisce esplicitamente il controllo; l'agente deve leggere una nuova vista prima di agire.

Il proprietario è la persona della conversazione, anche se ha il ruolo di membro. L'owner dell'installazione non può usare il browser o gli accessi di un'altra persona. Le stanze condivise e gli altri canali non usano questo profilo.

## Accessi e dati privati

Il profilo conserva soltanto cookie, separati per tenant, agente e persona. I dati restano sul server dell'installazione, in file riservati; il nome del file deriva dall'identificatore della persona, non dal suo nome o dalla sua email. La console mostra i siti associati, mai i cookie.

Il testo scritto dalla persona arriva direttamente al campo della pagina: Non viene inserito nei messaggi, nell'audit o negli eventi dell'agente. La casella della console è mascherata e si svuota prima della richiesta. La pagina può mostrare ciò che la persona scrive in un campo non mascherato. Alla restituzione del controllo i campi modificati vengono svuotati.

Le viste testuali oscurano i valori privati, i valori effettivi dopo le modifiche dei campi e le forme codificate dai moduli prima di troncare titoli, URL, etichette e pagine di testo. L'oscuramento avviene nel server: I valori scritti in precedenza non vengono inviati al JavaScript di una pagina visitata dopo. Non è una protezione da ogni trasformazione che un sito ostile possa fare dei dati già ricevuti dalla persona.

Un modulo può inviare la pagina durante la digitazione. Il valore effettivo viene quindi raccolto prima del gestore di input del sito; la navigazione attende che il server lo abbia conservato per l'oscuramento. La conferma deve appartenere alla sessione, al documento, al frame principale e alla modifica correnti. Conferme mancanti, valori fuori limite o errori chiudono la sessione: Leggere la pagina di destinazione non può sostituire il valore perso.

Dopo l'inserimento privato, gli strumenti dell'agente non possono ottenere schermate della stessa sessione: I pixel potrebbero mostrare dati che la vista testuale oscura. La persona continua a vedere il proprio pannello. Il browser può conservare l'accesso e restituire una vista testuale; questa scelta limita i compiti dell'agente che richiedono una schermata dopo il login.

«Esci dai siti» chiude i browser personali di quell'agente e cancella i relativi cookie. Rimuovere una persona dall'agente o dall'installazione elimina gli stessi accessi. La proprietà e l'accesso vengono ricontrollati durante l'uso, anche se la modifica arriva da un altro processo.

## Invii e limiti

Il controllo umano consente esclusivamente navigazioni POST da moduli URL-encoded della pagina principale. Restano i vincoli sui siti consentiti, sugli indirizzi pubblici, sui redirect e sulle dimensioni. Invii XHR/fetch, multipart, passkey, moduli dentro iframe e sessioni basate su localStorage non fanno parte di questa implementazione.

I redirect dopo un POST diventano navigazioni GET attraverso gli stessi controlli e lo stesso archivio di cookie. I redirect 307/308 che richiederebbero di ripetere il POST vengono rifiutati. Chromium non riceve redirect HTTP da seguire autonomamente fuori dal percorso controllato.

Senza una lista dei suffissi pubblici, un cookie con `Domain` superiore all'host viene conservato solo per quell'host. Gli accessi che richiedono cookie condivisi fra sottodomini possono quindi non funzionare. Restano al massimo 50 cookie per profilo; quelli senza scadenza esplicita durano al massimo 30 giorni, gli altri al massimo 400 giorni. I file sono privati ma non cifrati dall'applicazione.

Gli strumenti dell'agente continuano a non poter inviare POST dal browser. `web_submit` conserva il proprio percorso di approvazione e non eredita gli accessi del browser. Un sito può comunque attribuire effetti a una richiesta GET: Il vincolo sul metodo HTTP non certifica che qualsiasi sito autenticato sia privo di effetti.

I test usano un sito locale e credenziali sintetiche. Il supporto a un modulo di prova non dimostra compatibilità con i login di tutti i servizi esterni.
