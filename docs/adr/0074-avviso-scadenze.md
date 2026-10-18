# Avviso delle scadenze

Con le scadenze ([ADR 0073](0073-scadenze-delle-schede.md)) la board mostra in rosso una scheda in ritardo, ma solo a chi la apre. L'agente che ci lavora la legge una volta, nel messaggio iniziale, e poi può non pensarci più; chi l'ha affidata se ne accorge quando guarda la board.

## Decisione

- **Il giorno della scadenza, dalle 9 a Roma**, Annie avvisa una volta per ogni scheda aperta che scade oggi o è già in ritardo. Se Annie era spenta, avvisa al primo giro dopo.
- **All'agente che ci lavora** (scheda In corso), nella conversazione della scheda: «[Scheda #12] Scade oggi (scadenza lunedì 26 ottobre)…», con l'invito a finirla o a dire cosa manca.
- **Alla console della persona** che ci lavora con l'agente; se nessuno ci lavora, a chi l'ha creata; se l'ha creata un agente, agli owner. Arriva come gli avvisi delle schede da rivedere ([ADR 0051](0051-board-trascinare-e-avvisi.md)).
- **Una volta per scadenza**: la scheda ricorda quale scadenza ha già avvisato (`dueNoticed`), senza una riga nella storia. Se la scadenza si sposta, al nuovo giorno avvisa di nuovo. Una scheda in «Fatto» non avvisa.

## Alternative scartate

- **Avvisare ogni giorno finché è in ritardo**: diventa rumore, e la board la mostra già in rosso.
- **Avvisare il giorno prima**: la board mostra «scade domani» in giallo; un avviso in più per ogni scheda è troppo per ora.
- **Un messaggio su Telegram o WhatsApp**: gli avvisi della board restano nella console, come quelli delle schede da rivedere; se servirà, si aggiungerà per entrambi insieme.
