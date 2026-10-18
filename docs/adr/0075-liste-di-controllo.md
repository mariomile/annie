# Liste di controllo sulle schede

Molte schede della board ([ADR 0050](0050-board.md)) sono fatte di passi: «chiedere le misure, calcolare i costi, mandare il preventivo». Scritti nella descrizione, nessuno vede a che punto è il lavoro finché l'agente non lo mette in «Da rivedere», e l'agente stesso li ritrova solo rileggendo.

## Decisione

- **Una scheda può avere una lista di controllo**: fino a 30 voci di al massimo 200 caratteri. Si scrive alla creazione (dall'agente con `board_create checklist`, o dall'API) e si cambia nella scheda: aggiungere, spuntare, togliere la spunta, togliere una voce. Ogni modifica si salva subito e resta nella storia («ha spuntato "Chiedere le misure"»).
- **L'agente la riceve** nel messaggio con cui gli arriva la scheda, numerata, e la spunta mentre lavora con `board_update check_done` (o ne aggiunge una con `check_add`). Lo fa solo sulle schede assegnate a lui, come gli spostamenti di colonna; sulle altre può solo commentare. `board_list` mostra «lista 2/5», `board_show` le voci.
- **Le voci scritte da un agente** arrivano all'agente che lavora la scheda recintate come dati, come la descrizione.
- **Sulla board**, la scheda mostra «☑ 2/5», in verde quando sono tutte spuntate.
- **Nessuna regola sulla chiusura**: una scheda può andare in «Da rivedere» o in «Fatto» anche con voci non spuntate; la lista aiuta a vedere, non blocca.

## Alternative scartate

- **Sotto-schede per ogni passo** ([ADR 0066](0066-sotto-schede.md)): sono lavoro affidato a un altro agente, con la sua conversazione; per tre passi dello stesso lavoro sono troppo.
- **Bloccare «Da rivedere» finché la lista non è completa**: un passo può diventare inutile strada facendo; meglio che la persona lo veda e decida.
