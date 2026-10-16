# Settimana 10: Annie legge il web

Branch `week-10`. Decisione: [ADR 0009](adr/0009-navigazione-web-in-sola-lettura.md). Mario ha scelto di iniziare la Fase 3 dalla navigazione web.

## Cosa funziona (verificato dai test)

- **`web_read`** (`test/web-tools.test.ts`): legge una pagina http(s) e restituisce titolo e testo (al massimo 12.000 caratteri, pagine fino a 2 MB, 15 secondi), marcati come dati con un'etichetta casuale.
- **`web_screenshot`**: apre la pagina in Chromium headless (1280×800, o intera), senza download, e salva un PNG nel workspace (`screenshot/…`), da mandare con `file_send`. Provato con un Chromium vero: l'immagine che la pagina carica da un host non consentito viene bloccata (il server di quell'host non riceve richieste).
- **Siti consentiti**: in Impostazioni l'owner li elenca per istanza; vuoto vuol dire nessuno, `*` tutti i siti pubblici. Il cambio finisce nell'audit (quanti siti, se c'è `*`, mai l'elenco).
- **Mai dentro una rete**: loopback, reti private, link-local, CGNAT, multicast, metadati del cloud e le loro forme IPv6 sono rifiutati, sull'indirizzo a cui ci si connette davvero e dopo ogni redirect (un redirect verso `169.254.169.254` è rifiutato anche con `*`). Solo http e https, niente credenziali nell'indirizzo.
- **Immagine Docker**: Chromium facoltativo con `--build-arg WITH_BROWSER=1`; senza, gli screenshot rispondono che non sono disponibili.
- **Ordine dei messaggi nella console** (`test/web-channel.test.ts`). Bug trovato dalla suite sotto carico: il messaggio di una persona veniva scritto dopo averlo passato ad Annie, e una risposta molto veloce poteva finire nella conversazione prima della domanda. Ora le scritture di un thread vanno una alla volta; il test fallisce senza la correzione.
- **CI**: l'immagine si pubblica su GHCR senza artifact (la quota di spazio degli artifact dell'account era piena), e il report notturno dei giudizi resta 14 giorni senza far fallire le valutazioni.

## Limiti

| Cosa | Limite |
|---|---|
| Azioni | niente moduli, clic o invii: arrivano con le micro-VM e l'approvazione |
| DNS negli screenshot | il nome è controllato da noi prima che Chromium si connetta: un DNS che cambia risposta in mezzo è un rischio residuo (non per `web_read`) |
| Pagine dinamiche | `web_read` legge l'HTML che arriva, non quello che JavaScript costruisce dopo: per quelle c'è lo screenshot |
