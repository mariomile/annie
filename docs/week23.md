# Settimana 23: le sentinelle

Branch `week-23`. Decisione: [ADR 0018](adr/0018-sentinelle.md). Owni tiene d'occhio una pagina da sola e scrive nella conversazione quando cambia, quando un prezzo passa una soglia o quando un prodotto non si vede più. Si chiede in chat («avvisami quando scende sotto 50 €») o si crea dalla console, in «Task e sentinelle». Non servono chiavi: legge dai siti che l'owner consente.

## Cosa funziona (verificato dai test)

- **Lettura dei prezzi** (`test/watches.test.ts`): «1.299,00 €», «€ 49,99», «$1,299.99», «49.90 EUR», «49 euro», prezzi spezzati come «49 ,99€»; i numeri attaccati (il modello «270», «Confezione da 6», le date) non si incollano al prezzo; dopo la frase vale anche un numero senza valuta. Una pagina di cifre non rallenta niente.
- **Cosa conta come novità**: orari, date e contatori non contano; la pagina intera solo se cambiata due volte di fila (un banner che ruota non scrive mai); vicino a una frase solo le poche parole che la seguono; il prezzo una volta quando passa la soglia, con un margine dell'1%, e di nuovo dopo essere tornato; da una soglia all'altra con due soglie; esaurito detto una volta, senza contarlo come errore, e il ritorno detto anche lui.
- **In chat**: la prima lettura subito, con il prezzo letto e il testo guardato; errori chiari per sito non consentito, frase che non c'è, prezzo che non si trova, gruppi e telefono; ogni conversazione vede e cancella solo le sentinelle della sua persona; nota su WhatsApp e la finestra di 24 ore.
- **Nel passaggio dello scheduler**: scrive nella conversazione giusta una volta per cambiamento; dopo 6 errori di fila si ferma e lo dice; si ferma senza scrivere se la persona non è più consentita o il canale è chiuso; un messaggio non preso riparte dopo 5 minuti senza rileggere la pagina; dopo un crash tra invio e salvataggio non scrive due volte; 8 messaggi in un giorno la fermano; al più 20 pagine per passaggio.
- **Console** (Chromium, nessun errore): elenco con stato, ultimo errore e prezzo letto, Riattiva ed Elimina; creazione con la prima lettura subito, soglie scritte all'italiana («49,90»), soglia sopra e sotto; l'elenco non contiene il testo della pagina; serve essere tra le persone dell'istanza.
- **Audit**: `watch.created`, `watch.deleted`, `watch.fired` con ID e sito, mai il testo della pagina.

## Review indipendente

Due revisori separati (standard e sicurezza, spec). Corretti:

- **Alta.** Prezzi sbagliati: lo spazio era un separatore delle migliaia, quindi «Air Max 270 129,99 €» diventava 270129,99; il primo prezzo della pagina era spesso la spedizione o un banner (ora serve la frase e conta il numero subito dopo). Pagine con orari, contatori o banner che cambiano facevano scrivere a ogni controllo. Un prodotto esaurito contava come errore e dopo 6 controlli fermava la sentinella proprio quando serviva.
- **Media.** Un messaggio rifiutato faceva rileggere la pagina ogni 30 secondi (ora riparte lo stesso messaggio dopo 5 minuti; canale chiuso ferma la sentinella). Un passaggio lento teneva fermi i task (ora 4 pagine alla volta, 10 secondi e 3 redirect per pagina, un minuto per passaggio, e il prezzo si cerca solo all'inizio del testo). Errori con l'host di un redirect finivano fuori dalla recinzione (ora frasi fisse). La console non faceva la prima lettura, non aveva la soglia «sopra», perdeva «49,90» in un campo numerico, nascondeva l'errore in un tooltip e non permetteva di riattivare. Il messaggio di stop chiedeva al modello di dire «cosa è cambiato». In chat si vedevano e cancellavano le sentinelle degli altri. `schedule_create` diceva di usarlo per i controlli.
- **Bassa.** Una cancellazione durante un controllo poteva far rinascere la sentinella (ora una modifica alla volta per istanza, e niente invio se è stata cancellata); salto da una soglia all'altra non detto; prezzo che oscilla sulla soglia; nessun tetto ai messaggi; audit solo dalla console; motivi di stop in inglese; commenti fuori posto; ADR mancante.

Lasciato com'è, e scritto nell'ADR: il turno che nasce da una sentinella ha gli stessi strumenti di una conversazione normale (come `web_read`); gli strumenti che inviano chiedono già un'approvazione.

## Limiti

| Cosa | Limite |
|---|---|
| Sentinelle | 20 per istanza |
| Frequenza | da 30 minuti a una settimana |
| Pagine per passaggio | 20, 4 alla volta, un minuto in tutto |
| Errori prima di fermarsi | 6 di fila |
| Messaggi | 8 in 24 ore, poi si ferma |
| Pagine solo JavaScript | non lette (la prima lettura lo dice) |
