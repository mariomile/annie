# Settimana 6: istanze dalla console

Branch `week-6` (parte da `main` dopo il merge delle settimane 4 e 5). Vocabolario: [`GLOSSARY.md`](../GLOSSARY.md).

## Perché

Fino alla settimana 5 una nuova Istanza si creava solo da configurazione o nel codice. Per un owner che vuole un'Annie per reparto (acquisti, vendite, amministrazione) serviva un passaggio tecnico. Era il primo punto della lista «Dopo» in [`stato-e-todo.md`](stato-e-todo.md).

## Cosa funziona (verificato dai test)

- **Nuova istanza dalla console** (`test/app.test.ts`). L'owner preme «Nuova istanza» nella barra laterale, sceglie nome, ID (proposto dal nome) e istruzioni facoltative. L'istanza nasce con lo stesso modello dell'istanza principale, egress limitata al modello e al canale web, e solo chi l'ha creata può scriverle; il resto si decide in Impostazioni. La chat risponde subito, senza riavviare, e dopo un riavvio. ID non valido, nome vuoto o ID già usato vengono rifiutati con un messaggio. Solo l'owner può creare istanze (`POST /api/instances`).
- **Task programmati dell'istanza nuova** (`test/app.test.ts`). Lo scheduler rilegge l'elenco delle istanze a ogni giro: i task di un'istanza appena creata partono senza riavvio. Prima l'elenco era fissato all'avvio.
- **Risposte in tempo reale** (`test/app.test.ts`). Uno stream di eventi aperto prima della creazione riceve anche le risposte dell'istanza nuova. Prima i canali venivano agganciati solo all'apertura dello stream, quindi nel browser la risposta compariva solo ricaricando.

- **Ritentativi delle risposte nello stesso processo** (`test/outbox.test.ts`). Una risposta che il canale non prende per un problema di rete riparte dopo 5 secondi, poi 30 secondi, 2 minuti e ogni 10 minuti, finché il canale non la conferma. Prima restava nell'outbox fino al riavvio. Ogni nuovo tentativo porta l'avviso «Possibile doppione», perché il tentativo fallito potrebbe essere arrivato comunque. Un rifiuto esplicito del canale (per esempio un utente che ha bloccato il bot) non viene ritentato a raffica: resta nell'outbox per il prossimo avvio e finisce nell'audit (`reply.refused`). Lo spegnimento annulla i ritentativi in sospeso. Le schede della segreteria si ritentano già a ogni giro di polling dalla settimana 4.

- **Pulizia dell'outbox** (`test/outbox.test.ts`). All'apertura di un'istanza le risposte consegnate da più di 30 giorni vengono tolte dall'outbox (evento `outbox.pruned` nell'audit); quelle recenti e quelle non ancora consegnate restano. Senza pulizia l'outbox cresceva di un file per risposta e ogni avvio li rileggeva tutti. I file del workspace invece non si cancellano da soli: sono dati delle persone.

## Verifica

- `pnpm typecheck`: ok. `pnpm test`: 25 file, 153 test, 0 fallimenti (146 a fine settimana 5). `pnpm eval:segreteria`: 35 casi ok.
- Chromium headless: l'owner crea «Ufficio acquisti» dal dialogo, l'istanza viene selezionata, la chat risponde in tempo reale. Nessun errore in console.

## Limiti

| Cosa | Limite |
|---|---|
| Modello | l'istanza nuova usa il modello dell'istanza principale; cambiarlo resta un'operazione da configurazione |
| Telegram | l'istanza nuova parla solo dal web; un bot Telegram resta legato all'istanza principale |
| Cancellazione | la console non cancella istanze |
