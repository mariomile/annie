# Settimana 6: istanze dalla console

Branch `week-6` (parte da `main` dopo il merge delle settimane 4 e 5). Vocabolario: [`GLOSSARY.md`](../GLOSSARY.md).

## Perché

Fino alla settimana 5 una nuova Istanza si creava solo da configurazione o nel codice. Per un owner che vuole un'Annie per reparto (acquisti, vendite, amministrazione) serviva un passaggio tecnico. Era il primo punto della lista «Dopo» in [`stato-e-todo.md`](stato-e-todo.md).

## Cosa funziona (verificato dai test)

- **Nuova istanza dalla console** (`test/app.test.ts`). L'owner preme «Nuova istanza» nella barra laterale, sceglie nome, ID (proposto dal nome) e istruzioni facoltative. L'istanza nasce con lo stesso modello dell'istanza principale, egress limitata al modello e al canale web, e solo chi l'ha creata può scriverle; il resto si decide in Impostazioni. La chat risponde subito, senza riavviare, e dopo un riavvio. ID non valido, nome vuoto o ID già usato vengono rifiutati con un messaggio. Solo l'owner può creare istanze (`POST /api/instances`).
- **Task programmati dell'istanza nuova** (`test/app.test.ts`). Lo scheduler rilegge l'elenco delle istanze a ogni giro: i task di un'istanza appena creata partono senza riavvio. Prima l'elenco era fissato all'avvio.
- **Risposte in tempo reale** (`test/app.test.ts`). Uno stream di eventi aperto prima della creazione riceve anche le risposte dell'istanza nuova. Prima i canali venivano agganciati solo all'apertura dello stream, quindi nel browser la risposta compariva solo ricaricando.

## Verifica

- `pnpm typecheck`: ok. `pnpm test`: 25 file, 150 test, 0 fallimenti (146 a fine settimana 5). `pnpm eval:segreteria`: 35 casi ok.
- Chromium headless: l'owner crea «Ufficio acquisti» dal dialogo, l'istanza viene selezionata, la chat risponde in tempo reale. Nessun errore in console.

## Limiti

| Cosa | Limite |
|---|---|
| Modello | l'istanza nuova usa il modello dell'istanza principale; cambiarlo resta un'operazione da configurazione |
| Telegram | l'istanza nuova parla solo dal web; un bot Telegram resta legato all'istanza principale |
| Cancellazione | la console non cancella istanze |
