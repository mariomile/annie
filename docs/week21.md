# Settimana 21: Annie vede foto e immagini

Branch `week-21`. Decisione: [ADR 0016](adr/0016-immagini-al-modello.md). È la prima funzione dopo le fasi del [piano cloud](piano-cloud.md): una foto mandata ad Annie su Telegram, WhatsApp o nella console web arriva al modello, che la vede. Le immagini del workspace (un grafico fatto con il computer, una foto di ieri) le riapre con il tool `image_view`.

## Cosa funziona (verificato dai test)

- **Cos'è un'immagine** (`test/images.test.ts`): JPEG, PNG, GIF e WebP riconosciuti dai byte; SVG, PDF e file vuoti no; oltre 20 MB no.
- **Al modello**: una foto con il messaggio; da 7, il modello ne vede 4 e sa quali sono rimaste fuori e perché; l'audit conta le immagini e non contiene i loro byte; una foto troppo grande per il modello arriva rimpicciolita; solo i 2 messaggi più recenti con foto le mostrano, gli altri hanno una riga al loro posto.
- **Telegram**: la dimensione più grande entro il limite; la foto di uno sconosciuto non si scarica; un album è un messaggio solo, in polling e via webhook; un documento che è un'immagine si vede; una foto che non si può scaricare è detta, con la sua didascalia.
- **WhatsApp** (`test/whatsapp.test.ts`): foto con didascalia, sticker fermi sì, animati no.
- **Web** (`test/web.test.ts`): messaggio con sole foto (titolo «Foto»); percorsi solo da `uploads/`, al massimo 4, solo immagini vere; immagini in pagina solo se i byte lo sono, SVG sempre da scaricare; due caricamenti con lo stesso nome non si sovrascrivono.
- **`image_view`**: mostra un'immagine del workspace, rifiuta un file che non lo è e i percorsi fuori dal workspace.
- **Console** (Chromium, nessun errore in console): foto allegata, anteprima, invio, miniatura nella conversazione anche dopo aver ricaricato la pagina.

## Nella console

Il pulsante File accetta più file; le foto si possono anche trascinare sulla chat o incollare (uno screenshot). Restano sopra la casella finché il messaggio non parte, anche se si cambia conversazione, e l'invio aspetta che siano caricate. Se l'invio fallisce tornano nella casella. Una foto cancellata dal workspace diventa una riga «non c'è più» invece di un'immagine rotta. Il suggerimento «Cosa c'è in questa foto?» apre una conversazione che invita ad allegarla.

## Review indipendente

Due revisori separati (standard e sicurezza, spec). Corretti:

- **Alta.** La storia mandava di nuovo ogni foto a ogni turno: costo crescente e, dopo un paio di messaggi con 4 foto grandi, richieste oltre i 32 MB e una chat rotta per sempre. Ora solo gli ultimi 2 messaggi con foto le mostrano. Un caricamento web sovrascriveva un file con lo stesso nome (i telefoni le chiamano tutte `image.jpg`), e le miniature vecchie mostravano la foto nuova: ora il nome diventa unico. Le foto dei telefoni (4-8 MB) erano rifiutate: ora si rimpiccioliscono.
- **Media.** Una foto Telegram non scaricabile faceva perdere il messaggio con la didascalia. Sceglieva la dimensione più grande anche se oltre il limite. Un album diventava un messaggio per foto. Nessun incolla, nessun trascina, e Invio durante il caricamento mandava il testo senza la foto. Il server leggeva i file prima di controllare di chi è la conversazione.
- **Bassa.** Un invio fallito lasciava il messaggio doppio; le foto in attesa si perdevano cambiando conversazione; miniature rotte per file cancellati; sticker ignorati; cache delle immagini dopo il logout; `images` fuori dal tipo dei messaggi in ingresso.

## Limiti

| Cosa | Limite |
|---|---|
| Foto per messaggio | 4 |
| Dimensione | 20 MB come file; al modello al più 4,5 MiB in base64 e 2000×2000 pixel |
| Foto mostrate al modello | quelle dei 2 messaggi più recenti che ne hanno |
| Album Telegram via webhook | le foto arrivate entro 1,5 secondi dalla prima |
| Sticker animati, video | non ancora |
