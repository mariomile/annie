# 0105: Stato, Stop e storico del lavoro

La conversazione mostrava un indicatore d'attesa basato sull'ultimo messaggio. Dopo un reload non distingueva lavoro ancora attivo, errore e risposta mancata; le automazioni contavano le chiamate ammesse senza registrare il loro esito.

## Decisione

Ogni richiesta ammessa ha un record persistente nella sua istanza: `queued`, `running`, `succeeded`, `failed` o `cancelled`. `succeeded` significa che il motore ha prodotto una risposta. La consegna al canale è registrata separatamente; il record non certifica il successo di un'azione esterna né l'approvazione delle bozze.

`delivery: not_applicable` identifica un esito terminale senza ammissione al motore né risposta nell'outbox. Non equivale a una consegna riuscita. Un nuovo tentativo riporta la consegna a `pending`.

Il record conserva origine e identificatore del task, del brief, della sentinella o dell'automazione. Non duplica prompt, argomenti o risultati degli strumenti. I progressi contengono solo il tipo di passaggio e il nome dello strumento; la console li presenta con etichette in italiano. Lo storico conserva fino a 1.000 esecuzioni concluse e 32 passaggi per esecuzione, oltre ai lavori ancora attivi.

La stessa identità di messaggio riutilizza la stessa esecuzione. Lo stato proviene dal motore durevole, attraverso le API pubbliche di Pi, e viene riconciliato alla ripresa. Gli eventi live vengono pubblicati dopo il salvataggio; la console rilegge lo storico alla riconnessione. Ogni aggiornamento ha un timestamp monotono per non sostituire uno stato recente con una lettura precedente.

## Stop

Stop riguarda il lavoro attivo e gli input già in coda della singola conversazione. L'intenzione di interrompere viene salvata prima di chiedere al motore di annullare: Un arresto del processo in quella finestra non deve far ripartire il lavoro al riavvio. Una risposta già completata mantiene il proprio esito.

L'interruzione viene propagata agli strumenti e impedisce l'inizio dei passaggi successivi. Non annulla gli effetti già prodotti da un servizio esterno e non può ritirare una richiesta che il servizio abbia già ricevuto. Il messaggio di conferma dice esplicitamente che le azioni già completate restano.

Se il motore rifiuta Stop per un errore temporaneo, l'intenzione resta salvata e il blocco dei passaggi rimane fino all'annullamento riuscito. Il pulsante consente di riprovare; anche il messaggio successivo ritenta l'interruzione prima di essere ammesso. Dopo un riavvio, un annullamento fallito resta confinato alla propria conversazione: Non impedisce l'avvio o il lavoro delle altre. Uno strumento già in esecuzione deve rispettare il segnale di annullamento o usare `ctx.step`; codice esterno che li ignora può continuare fino al proprio timeout. Le deleghe in background non vengono annullate automaticamente.

Un'interruzione del motore senza intenzione persistente della persona viene presentata come errore. Un fallimento provocato dal blocco di Stop conserva invece lo stato e il messaggio di interruzione. Una risposta già completata non viene riclassificata.

Se sia l'ammissione sia la verifica del suo esito falliscono, il record resta in coda con un errore generico di incertezza. La ripresa esplicita o il successivo invio alla stessa chat riconciliano l'identità stabile della richiesta; non viene creata una seconda esecuzione. Non c'è un timer di riconciliazione in background.

Un errore di lettura durante l'ascolto dei progressi viene registrato senza terminare l'ascolto. Un problema nell'apertura dell'ascolto non impedisce l'annullamento del motore. Uno stream chiuso viene rimosso e riaperto al successivo accesso; non esiste un timer di riapertura. Resta al massimo un ascolto per conversazione aperta fino alla chiusura dell'istanza.

## Console e riservatezza

- Nella chat: Stato, passaggi e pulsante Stop, anche dopo un reload.
- In Attività: Storico delle proprie conversazioni della console.
- In Task e Automazioni: Storico filtrato per origine, con collegamento alla chat del risultato.

Il filtro delle conversazioni autorizzate precede il limite dei risultati. Anche l'owner non può leggere lo storico delle chat private di un altro membro. Gli eventi live ricontrollano sessione, accesso all'istanza e proprietà della chat. Le esecuzioni di altri canali sono registrate dal core, ma non vengono esposte nella console senza un collegamento verificato all'identità della persona.

## Verifica

Le regressioni usano il motore Pi reale con un modello deterministico e strumenti controllati: Progressi prima della risposta, input duplicati, interruzione di lavoro attivo e in coda, altra conversazione indipendente, ripresa dopo arresto, finestre di crash con SIGKILL, esito che precede Stop, consegna differita e filtri dello storico.

I test HTTP verificano inoltre autorizzazioni, riservatezza degli eventi, revoca della sessione e messaggio di interruzione. La verifica nel browser copre Stop, reload, storico e layout mobile. La qualità della pianificazione di un modello esterno resta una verifica distinta.
