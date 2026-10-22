# La console in un modulo per pagina

Tutto il front end della console stava in un solo file, `src/web/ui/app.js`, di circa 5.900 righe. Ogni modifica a una pagina toccava lo stesso file e rendeva difficile trovare le cose e rivedere le PR.

## Decisione

- **Un modulo ES per pagina.** `app.js` resta il punto d'ingresso e avvia l'app. Le pagine sono in `src/web/ui/pages/` (chat, board, impostazioni, e così via); le parti della console che non sono una pagina (`shell.js`, `login.js`, `account.js`, `palette.js`, `pwa.js`, `listen.js`, `session.js`) stanno accanto a `app.js`.
- **Un modulo comune.** `common.js` tiene gli strumenti usati da tutte le pagine: costruzione del DOM, client API, stato, percorsi, volti degli agenti.
- **Nessun cambio di comportamento.** Il codice è stato spostato così com'è: cambiano solo le righe `import` in testa e `export` davanti a quello che altre pagine usano.
- **Nessun passaggio di build e nessuna dipendenza.** La pagina caricava già `app.js` come `type="module"`, quindi il browser carica i moduli da solo.
- **Il server serve ogni modulo.** L'elenco dei file serviti in `src/web/server.ts` ha una riga per modulo. Il service worker (`sw.js`) li tiene nella shell offline e la sua cache passa a `annie-shell-v4`.

## Conseguenze

- Una pagina nuova richiede un file in `pages/`, una riga in `STATIC` (`server.ts`) e una in `SHELL` (`sw.js`). Se ne manca una, il file non viene servito o non funziona offline.
- Il primo caricamento fa più richieste (25 file invece di uno), tutte dalla stessa origine e in cache.
- I moduli si importano a vicenda (la shell conosce le pagine, le pagine conoscono la shell): vale solo per funzioni chiamate dopo il caricamento, non per codice eseguito all'import.
