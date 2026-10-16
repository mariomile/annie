# Fase 3, quarto passo: il browser con clic, nel Chromium della cella

Annie apre una pagina in un browser che resta aperto per la conversazione (`web_browse`), clicca (`web_click`) e scrive nei campi (`web_type`), così usa i siti costruiti in JavaScript: menu, filtri, ricerche, schede, paginazione, pagine che senza clic non mostrano niente. Il browser è il Chromium della cella che già fa gli screenshot (ADR 0009), con le stesse regole: ogni richiesta della pagina passa dal fetch controllato, solo verso i siti che l'owner consente e mai verso un indirizzo interno.

Il browser **legge e basta**. Ogni richiesta che non è una GET (un modulo che invia, un `fetch` in POST, un upload) viene bloccata prima di partire, e Annie lo sa: per inviare usa `web_submit`, che passa dall'approvazione (ADR 0011). «Leggere è libero, scrivere o inviare si approva» resta vero anche con i clic.

## Perché nella cella e non nel computer dell'istanza

Il piano era di metterlo sul computer della settimana 18. Abbiamo cambiato idea:

- Il computer non ha rete per scelta, ed è quello che lo rende sicuro senza approvazioni. Un browser lì avrebbe bisogno di un canale verso la cella per ogni richiesta: lo stesso fetch controllato, più un protocollo in mezzo, più Docker su ogni installazione che vuole il browser.
- Il controllo che conta è già nella cella: Chromium non tocca la rete, ogni richiesta la fa il nostro fetch, un redirect alla volta, con il DNS risolto da noi. Il renderer gira nel sandbox di Chromium. Spostarlo nel computer non toglierebbe niente a ciò che la pagina può raggiungere.
- Così il browser funziona anche in Annie Cloud, dove il computer resta spento fino alle micro-VM, e su ogni installazione che ha già gli screenshot.

## Come funziona

- Una sessione per conversazione, con i suoi cookie, che si chiude dopo 5 minuti senza azioni. Al massimo 4 sessioni aperte per server; per aprirne un'altra si chiude quella ferma da più tempo. Una sessione ha un tetto di richieste e di byte.
- Dopo ogni azione Annie riceve indirizzo, titolo, il testo visibile (al più 8.000 caratteri) e gli elementi su cui può agire, numerati, recintati come dati. Con `screenshot` salva anche quello che si vede.
- Clic e testo agiscono sugli elementi numerati dell'ultima vista. I campi password e i caricamenti di file non si toccano: Annie non entra negli account e non carica file.
- Bloccati e riferiti ad Annie: le richieste non GET, quelle verso siti non consentiti, le finestre nuove (ne riceve l'indirizzo), i WebSocket, i service worker, i download.
- Nel brief del mattino, che legge mail di chiunque, nessuno strumento web gira.

## Alternative scartate

- **Clic che inviano dopo approvazione** (fermare la POST, chiedere, poi farla partire dalla stessa sessione): la sessione può essere chiusa quando arriva l'approvazione, e chi approva vedrebbe un corpo di richiesta grezzo invece di campi e valori. `web_submit` mostra campi e valori e rilegge il modulo al momento dell'invio.
- **Accesso con le credenziali della persona**: un browser con l'account di qualcuno può fare tutto quello che può fare lei. Non prima di un modello di approvazione per le sessioni autenticate.
- **Il browser nel computer dell'istanza**: vedi sopra.

## Conseguenze

- Una pagina con istruzioni nascoste può spingere Annie a cliccare o a scrivere in una ricerca: il testo scritto può arrivare al sito in una GET, come un indirizzo in `web_read`. Per questo i siti consentiti conviene elencarli uno per uno, e il testo della pagina arriva sempre recintato come dati.
- Il JavaScript delle pagine gira nel renderer di Chromium, nel suo sandbox; dove il sandbox non parte vale la scelta esplicita dell'operatore dell'ADR 0009 (`ANNIE_SCREENSHOTS_WITHOUT_SANDBOX=1`).
- Dopo un riavvio le sessioni sono perse: Annie riapre la pagina.
