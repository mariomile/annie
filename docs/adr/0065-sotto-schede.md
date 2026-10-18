# Board: sotto-schede e passaggi tra agenti

Con la board ([ADR 0050](0050-board.md)) un agente lavora a una scheda da solo. Spesso una parte del lavoro spetta a un altro agente: il Ricercatore raccoglie i dati, ma il testo lo scrive meglio lo Scrittore. Finora l'agente poteva solo creare una scheda per l'altro, che aspettava in «Da fare» che qualcuno la avviasse, e il risultato non gli tornava indietro.

## Decisione

- **Una scheda può far parte di un'altra**: è una sotto-scheda. C'è un solo livello, quindi una sotto-scheda non ha sotto-schede sue, e ce ne possono essere al massimo 10 aperte sotto una scheda. Non se ne aggiungono sotto una scheda chiusa. Se si elimina la scheda, le sue sotto-schede restano sulla board, da sole.
- **L'agente che lavora a una scheda la può dividere** con `board_create` e `parent`. Se la scheda è In corso con lui, la sotto-scheda parte subito con la stessa persona e con l'agente a cui la affida, ed è da sola se lo è la scheda ([ADR 0061](0061-agenti-da-soli.md)). Quella persona aveva già avviato il lavoro, quindi non serve che prema di nuovo Avvia. Vale solo se la persona può scrivere a quell'agente: altrimenti la sotto-scheda aspetta in «Da fare», come ogni scheda scritta da un agente. Il brief resta recintato come dati, perché l'ha scritto un agente.
- **Il risultato torna indietro**: quando l'altro agente sposta la sotto-scheda in «Da rivedere», l'agente della scheda lo legge nella sua conversazione, con il riassunto recintato come dati, e va avanti da lì. La sotto-scheda la rivede e la chiude la persona, come sempre, e l'avviso arriva a lei ([ADR 0051](0051-board-trascinare-e-avvisi.md)).
- **Nella console** la scheda mostra le sue sotto-schede, quante sono fatte e dove sono; ogni sotto-scheda mostra «parte di #12». Anche una persona può creare una sotto-scheda, scegliendo «Fa parte di» nella nuova scheda.

## Alternative scartate

- **Più livelli**: un agente che divide e un altro che divide ancora moltiplica conversazioni e spesa senza che nessuno guardi. Un livello copre il passaggio di una parte del lavoro.
- **L'agente della scheda che chiude la sotto-scheda**: la chiusura resta di una persona, come per ogni scheda; all'agente basta sapere che il lavoro è pronto.
- **Messaggi diretti tra agenti** ([ADR 0042](0042-agenti-che-si-scrivono.md)): restano per le domande veloci. Una sotto-scheda si vede sulla board, ha una persona che la segue e un risultato da rivedere.
