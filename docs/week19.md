# Settimana 19: il browser con clic, nel Chromium della cella

Branch `week-19`. Decisione: [ADR 0014](adr/0014-browser-con-clic-nella-cella.md). È il browser della Fase 3 del [piano cloud](piano-cloud.md). Il piano lo metteva nel computer della settimana 18; è finito nel Chromium della cella, che legge e basta, così funziona anche in Owni Cloud e non serve aprire la rete del computer.

## Cosa funziona (verificato dai test)

- **I tool** (`test/web-browse.test.ts`, su un Chromium vero): `web_browse` apre un indirizzo di un sito consentito, torna indietro (`back`) o rilegge la pagina; `web_click` clicca un elemento numerato; `web_type` scrive in un campo o sceglie un valore in un menu, e con `submit` preme Invio. Ogni risposta porta indirizzo, titolo, testo visibile ed elementi numerati, recintati come dati; con `screenshot` anche l'immagine, salvata nel workspace sotto `screenshot/`.
- **Siti costruiti in JavaScript**: menu che compaiono al clic, ricerche, filtri, schede, paginazione, contenuti caricati dopo il primo caricamento (Owni aspetta che la pagina smetta di caricare).
- **Legge e basta**: una POST da script o da modulo non parte, la pagina resta dov'è e Owni sa che per inviare serve `web_submit` con approvazione. Le password e i caricamenti di file non si toccano.
- **Una sessione per conversazione**, con i suoi cookie; un'altra conversazione ha un browser suo. Si chiude dopo 5 minuti senza azioni; al massimo 4 per server, e non si chiude mai una sessione al lavoro per farne posto a un'altra.
- **Pagine ostili**: metodi inventati, beacon verso siti non consentiti, pagine da 5 milioni di caratteri, pagine che non rispondono (chiuse dopo il tempo massimo, poi si riaprono), iframe, link a PDF, menu da centinaia di voci: tutto finisce in una nota recintata o in un limite, mai in un blocco del server.
- **Dove non gira**: nella chat del brief del mattino. Dove gli screenshot sono spenti (senza Chromium o senza sandbox) il tool lo dice e Owni legge con `web_read`.

## Review indipendente

Due revisori separati (standard e sicurezza, spec). Corretti:

- **Alta.** Le stringhe della pagina arrivavano intere fino al server: ora sono tagliate dentro la pagina. Un'azione su una pagina che non risponde poteva bloccare la sessione per sempre: ora ogni passo ha un tempo massimo. Note scelte dalla pagina finivano fuori dal recinto. WebRTC poteva aprire connessioni fuori dal fetch controllato: ora è spento, con DNS di Chromium che non risolve niente.
- **Media.** Una sessione al lavoro poteva essere chiusa per farne posto a un'altra, e la chiusura di una sessione vecchia poteva chiudere quella nuova con la stessa chiave. Il tetto di richieste non ripartiva a ogni pagina. I cookie erano condivisi. Un elemento poteva essere sostituito dalla pagina fra la vista e il clic. Mancavano: la strada verso `web_submit`, il limite agli elementi con `find`, l'attesa delle pagine lente, Chromium nella CI, etichette da `aria-labelledby`, `alt` e `title`, le note per file, beacon, iframe e `from`, le istruzioni nel prompt di sistema e nella console.
- **Bassa.** Lo screenshot fuori dalla coda della sessione; nessun rifiuto fuori da una conversazione; testi di errore tecnici mostrati al modello.

## Limiti

| Cosa | Limite |
|---|---|
| File | i link a PDF e altri file non si scaricano: Owni li legge con `web_read` |
| Iframe | segnalate, non lette |
| Account | nessun accesso con credenziali, niente password |
| Pagina | 400 richieste e 40 MB, 8.000 caratteri di testo per vista, 80 elementi |
| Sessioni | 4 per server, chiuse dopo 5 minuti, perse al riavvio |
| Scorrimento | non si scorre: i contenuti che si caricano scorrendo non arrivano |
