# Schede che vengono dopo altre

Sulla board ([ADR 0050](0050-board.md)) il lavoro vero arriva spesso a tappe: «raccogli i dati», poi «scrivi il report», poi «mandalo ai clienti». Finora la seconda scheda andava avviata a mano quando la prima era chiusa, e l'agente che la prendeva non sapeva com'era finita la prima se non andandola a cercare.

## Decisione

- **Una scheda può venire dopo altre schede**, fino a 5: si scrive alla creazione (nella nuova scheda «Viene dopo la scheda», dall'API con `after`, dall'agente con `board_create after`) e si cambia nella scheda («Viene dopo: #3, #5»). Una scheda non viene dopo sé stessa, e due schede non possono aspettarsi a vicenda, nemmeno passando per altre. Ogni cambio resta nella storia.
- **Avviata mentre aspetta, resta in «Da fare» e parte da sola**: chi preme Avvia (o la crea già affidata a un agente) la mette in coda con sé; quando tutte quelle prima sono in «Fatto», parte con quella persona, come se avesse premuto Avvia allora, anche «da sola» se l'aveva chiesto. Si controlla quando una scheda va in «Fatto» o viene eliminata, e a ogni giro del pianificatore per quello che fosse sfuggito.
- **L'agente riceve com'è finita ciascuna scheda prima**: titolo, colonna e l'ultimo commento (di solito il riassunto con cui è andata in «Da rivedere»), recintati come dati.
- **Se non può partire** (la persona non può più scrivere a quell'agente), resta in «Da fare» con un commento che dice perché.
- **Tolta l'assegnazione o spostata a mano**, la coda si annulla: la si riavvia quando serve. Togliere le schede da aspettare la fa partire subito, se era in coda.
- **Sulla board** la scheda mostra «dopo #3» finché quelle prima sono aperte; `board_list` dice «(dopo #3, parte da sola)», `board_show` elenca le schede prima con la loro colonna.
- **Per gli agenti**: un agente che lavora a una scheda con una persona può dividerla in sotto-schede ([ADR 0066](0066-sotto-schede.md)) una dopo l'altra; la prima parte subito, le altre in coda con la stessa persona.

## Alternative scartate

- **Bloccare lo spostamento in «In corso» senza coda**: la persona dovrebbe ricordarsi di tornare; il senso è proprio non doverlo fare.
- **Far partire la seguente già a «Da rivedere»**: il risultato non è ancora approvato, e una scheda rimandata indietro farebbe partire lavoro su basi sbagliate. Parte a «Fatto».
