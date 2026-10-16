# Settimana 6: istanze dalla console, affidabilità e sicurezza

Branch `week-6` (parte da `main` dopo il merge delle settimane 4 e 5). Vocabolario: [`GLOSSARY.md`](../GLOSSARY.md).

## Perché

Fino alla settimana 5 una nuova Istanza si creava solo da configurazione o nel codice. Per un owner che vuole un'Annie per reparto (acquisti, vendite, amministrazione) serviva un passaggio tecnico. Era il primo punto della lista «Dopo» in [`stato-e-todo.md`](stato-e-todo.md).

## Cosa funziona (verificato dai test)

- **Nuova istanza dalla console** (`test/app.test.ts`). L'owner preme «Nuova istanza» nella barra laterale, sceglie nome, ID (proposto dal nome) e istruzioni facoltative. L'istanza nasce con lo stesso modello dell'istanza principale, egress limitata al modello e al canale web, e solo chi l'ha creata può scriverle; il resto si decide in Impostazioni. La chat risponde subito, senza riavviare, e dopo un riavvio. ID non valido, nome vuoto o ID già usato vengono rifiutati con un messaggio. Solo l'owner può creare istanze (`POST /api/instances`).
- **Task programmati dell'istanza nuova** (`test/app.test.ts`). Lo scheduler rilegge l'elenco delle istanze a ogni giro: i task di un'istanza appena creata partono senza riavvio. Prima l'elenco era fissato all'avvio.
- **Risposte in tempo reale** (`test/app.test.ts`). Uno stream di eventi aperto prima della creazione riceve anche le risposte dell'istanza nuova. Prima i canali venivano agganciati solo all'apertura dello stream, quindi nel browser la risposta compariva solo ricaricando.

- **Ritentativi delle risposte nello stesso processo** (`test/outbox.test.ts`). Una risposta che il canale non prende per un problema di rete riparte dopo 5 secondi, poi 30 secondi, 2 minuti e ogni 10 minuti, finché il canale non la conferma. Prima restava nell'outbox fino al riavvio. Ogni nuovo tentativo porta l'avviso «Possibile doppione», perché il tentativo fallito potrebbe essere arrivato comunque. Un rifiuto esplicito del canale (per esempio un utente che ha bloccato il bot) non viene ritentato a raffica: resta nell'outbox per il prossimo avvio e finisce nell'audit (`reply.refused`). Lo spegnimento annulla i ritentativi in sospeso. Le schede della segreteria si ritentano già a ogni giro di polling dalla settimana 4.

- **Pulizia dell'outbox** (`test/outbox.test.ts`). All'apertura di un'istanza le risposte consegnate da più di 30 giorni vengono tolte dall'outbox (evento `outbox.pruned` nell'audit); quelle recenti e quelle non ancora consegnate restano. Senza pulizia l'outbox cresceva di un file per risposta e ogni avvio li rileggeva tutti. I file del workspace invece non si cancellano da soli: sono dati delle persone.

- **Container con privilegi minimi** (`docker-compose.yml`). Filesystem in sola lettura tranne `/data` e `/tmp`, nessuna capability Linux, niente escalation di privilegi (`no-new-privileges`). I tool proposti girano in un processo figlio dentro lo stesso container e ne ereditano i limiti. Verificato con un'immagine costruita da questo branch e avviata con le stesse opzioni: healthcheck `healthy`, utente 1000, `/app` non scrivibile, `/data` sì; login, file, tool proposto approvato ed eseguito in sandbox (con `node:sqlite` bloccato), tutto ancora lì dopo `docker restart`.

- **Verifica in due passaggi** (`test/totp.test.ts`, `test/web.test.ts`). Ognuno, dal dialogo «Il tuo account» (clic sul proprio nome), può attivarla: aggiunge la chiave all'app di autenticazione del telefono e conferma con un codice. Da quel momento il link personale da solo non basta: al login serve il codice di sei cifre. Ogni codice vale una volta sola; dopo cinque codici sbagliati il login aspetta dieci minuti; i tentativi respinti finiscono nell'audit (`web.login_denied`). Per disattivarla serve un codice. L'owner può toglierla a chi ha perso il telefono (Persone → Reset 2FA, oppure `pnpm annie person reset-2fa <id>`). TOTP standard (RFC 6238, verificato sui vettori della RFC), senza dipendenze nuove.

## Verifica

- `pnpm typecheck`: ok. `pnpm test`: 26 file, 163 test, 0 fallimenti (146 a fine settimana 5). `pnpm eval:segreteria`: 35 casi ok.
- Chromium headless: l'owner crea «Ufficio acquisti» dal dialogo, l'istanza viene selezionata, la chat risponde in tempo reale. Poi attiva la verifica in due passaggi, esce, rientra: il link da solo viene respinto, un codice sbagliato pure, quello giusto entra. Nessun errore in console oltre ai 401 attesi.

## Limiti

| Cosa | Limite |
|---|---|
| Modello | l'istanza nuova usa il modello dell'istanza principale; cambiarlo resta un'operazione da configurazione |
| Telegram | l'istanza nuova parla solo dal web; un bot Telegram resta legato all'istanza principale |
| Cancellazione | la console non cancella istanze |
| Verifica in due passaggi | la chiave TOTP sta in `people.json` nella cartella dati, come il resto dei dati delle persone: i backup vanno conservati cifrati. Il blocco dopo cinque codici sbagliati vale per il processo e si azzera al riavvio |
