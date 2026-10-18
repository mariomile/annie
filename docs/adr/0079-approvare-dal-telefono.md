# Approvare una scheda dal telefono

Quando un agente mette una scheda in «Da rivedere» e nessuno ci lavorava con lui, l'owner lo sa anche nella chat con l'agente principale, su Telegram o WhatsApp ([ADR 0051](0051-board-trascinare-e-avvisi.md)). Ma per chiuderla doveva aprire la console: il riassunto era già lì nel messaggio, e spesso basta per dire di sì.

## Decisione

- **Sotto l'avviso c'è un pulsante «Approva»**: toccarlo sposta la scheda in «Fatto», come Approva sulla Board, e la chat risponde «Scheda #3 approvata e chiusa.».
- **Solo chi approva per l'agente principale** su quel canale (gli stessi che approvano i tool e le azioni): un tocco di chiunque altro non fa nulla e resta nel registro come rifiutato. La modifica sulla scheda risulta fatta dall'owner, perché è lui che riceve l'avviso.
- **Solo se è ancora da rivedere**: se nel frattempo qualcuno l'ha rimandata indietro, chiusa o eliminata, il tocco non cambia nulla e la chat dice perché («La scheda #3 non è più in «Da rivedere»»). Un tocco consegnato due volte non la chiude due volte.
- **Rimandarla indietro resta sulla Board**: serve scrivere cosa cambiare, e un pulsante non basta.

## Alternative scartate

- **Un pulsante «Rimanda indietro» senza commento**: l'agente riceverebbe «rimandata indietro» senza sapere perché, e lavorerebbe a caso.
- **Approvare scrivendo «approva #3» all'agente**: un agente non sposta mai una scheda in «Fatto» (ADR 0050), e non deve poterlo fare perché un messaggio glielo chiede.
