# Board

Con più agenti ([ADR 0041](0041-agenti.md)) che si scrivono ([ADR 0042](0042-agenti-che-si-scrivono.md)) mancava un posto dove vedere il lavoro: cosa c'è da fare, chi ci sta lavorando, cosa aspetta di essere controllato. Mario l'ha chiesto «stile multica.ai»: issue con un assegnatario che può essere un agente, che le prende, le porta avanti e le chiude.

## Decisione

- **Una board per tenant**, nella console (pagina **Board**), con quattro colonne: Da fare, In corso, Da rivedere, Fatto. Una per tenant e non per agente, perché una scheda passa da un agente all'altro. Sta in `tenants/<id>/board.json`, scritto con il lock fra processi (`updateJsonFile`).
- **Una scheda** ha un numero (#12, corto da dire in chat), titolo, descrizione, priorità (bassa, normale, alta), l'agente a cui è affidata e la cronologia: creazione, spostamenti, assegnazioni, commenti. I numeri non si riusano.
- **Una persona che affida una scheda a un agente fa partire il lavoro**: si apre una conversazione di quell'agente con la persona che l'ha affidata, intitolata «#12 titolo», e il brief (titolo, descrizione, cosa fare alla fine) entra come se l'avesse scritto quella persona. Si riusa il canale web e tutto quello che una conversazione ha già: approvazioni, file, memoria, modello per chat, browser. La persona vede il lavoro dalla chat («Apri la conversazione») e ci scrive come in ogni chat. Se l'agente non si raggiunge, la scheda resta in Da fare e la persona lo vede subito. **Avvia** fa partire una scheda che aspetta in Da fare, una volta sola anche con due clic; «In corso» si ottiene solo così, non scegliendo la colonna.
- **La board non dà a nessuno un agente che non poteva già usare**: si affida una scheda solo a un agente a cui si può scrivere dalla console. Un membro vede le schede che ha creato, quelle su cui lavora e quelle degli agenti a cui può scrivere; l'owner le vede tutte. Elimina una scheda chi l'ha creata o l'owner. Gli strumenti degli agenti seguono la stessa regola: un agente vede le schede che vede la persona con cui parla nella console, e da Telegram o WhatsApp solo le sue.
- **L'agente sposta le sue schede, una persona le chiude.** Con `board_update` l'agente le mette In corso, le ridà (Da fare) o le manda in Da rivedere con un riassunto; «Fatto» è solo di una persona, dopo averla rivista: lo rifiuta lo schema dello strumento e lo rifiuta anche la board. Non riapre una scheda chiusa. Le schede di altri agenti le può solo commentare.
- **Revisione**: da Da rivedere la persona approva (Fatto) o la rimanda indietro con un commento. Se la rimanda la persona con cui l'agente lavora, il commento arriva nella stessa conversazione («[Scheda #12] Anna l'ha rimandata indietro: …») e la scheda torna In corso. Se la rimanda qualcun altro (l'owner che rivede la scheda di un membro), torna in Da fare con il commento, e chi preme Avvia ci lavora con l'agente: nessuno scrive nella conversazione di un altro. Anche un commento mentre l'agente ci lavora arriva lì, se lo scrive la persona con cui lavora e se può ancora scrivere all'agente.
- **Dalla chat**: con `board_create` un agente crea una scheda quando la persona lo chiede («mettilo in board per Ricercatore»), anche per un altro agente. La scheda resta in Da fare con l'agente scelto e parte quando una persona preme **Avvia**: un agente può aver letto l'idea in una mail o in una pagina, e quello che scrive non deve arrivare a un altro agente come se l'avesse scritto la persona. Per lo stesso motivo la descrizione di una scheda scritta da un agente arriva nel brief recintata come dati. `board_list` e `board_show` mostrano le schede come dati recintati: le scrivono persone e agenti, non sono istruzioni.
- **Passata a un altro agente**, la scheda riparte in una conversazione nuova del nuovo agente; tolta l'assegnazione mentre era In corso, torna in Da fare. Un agente eliminato ([ADR 0046](0046-eliminare-un-agente.md)) lascia le sue schede senza nessuno, e quelle In corso tornano in Da fare.
- **Limiti**: 300 schede aperte, le 200 «Fatto» più recenti (le più vecchie se ne vanno), titolo 120 caratteri, descrizione 4000, commento 2000, gli ultimi 100 eventi per scheda.
- **Audit**: `board.card_created`, `board.card_changed`, `board.card_started`, `board.card_deleted`, con chi l'ha fatto.

## Alternative scartate

- **Un esecutore che prende le schede da solo, in coda** (come i daemon di multica): avrebbe bisogno di una persona per conto di cui lavorare, per approvazioni, connettori e costi. Con la conversazione della persona che affida la scheda ogni regola che c'è già vale anche qui.
- **Una board per agente**: una scheda non potrebbe passare da un agente all'altro, e la persona dovrebbe guardare in più posti.
- **Trascinare le schede fra le colonne** era rimandato: aggiunto con [ADR 0051](0051-board-trascinare-e-avvisi.md).

## Da fare

- ~~Trascinare le schede fra le colonne sul computer~~ e ~~avvisare quando una scheda arriva in Da rivedere~~: fatti, [ADR 0051](0051-board-trascinare-e-avvisi.md).
