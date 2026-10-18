# Scadenze delle schede

Una scheda della board ([ADR 0050](0050-board.md)) dice cosa fare e a chi, ma non entro quando. «Il preventivo per Rossi entro venerdì» finiva nella descrizione, dove la board non lo vede: niente dice che è in ritardo, e l'agente lo legge solo se ci fa caso.

## Decisione

- **Una scheda può avere una scadenza**: un giorno, senza ora, nel fuso di Roma (`due`, `YYYY-MM-DD`). Si mette alla creazione, si cambia o si toglie dalla scheda; ogni cambio resta nella sua storia («ha messo la scadenza a venerdì 30 ottobre», «ha tolto la scadenza»). Un giorno che non esiste è rifiutato con il formato giusto.
- **Sulla board**: sulle schede aperte un'etichetta dice «scade oggi», «scade domani», «scade ven 30 ott» o «in ritardo di 3 giorni», in rosso se è in ritardo e in giallo se scade oggi o domani. Nelle colonne vengono prima le priorità alte, poi le scadenze più vicine, poi le altre per numero. Su una scheda in «Fatto» la scadenza non si mostra più.
- **L'agente la sa**: nel messaggio con cui riceve la scheda c'è «Scadenza: venerdì 30 ottobre (scade domani)». `board_list` la mostra e mette prima le schede con la scadenza più vicina; `board_create` accetta `due`, solo quando la persona ne ha data una.
- **I giorni si contano a Roma**: alle 23:30 del 25 ottobre una scheda del 26 «scade domani», anche se in UTC è già il 26.

## Alternative scartate

- **Data e ora**: per le schede di un'azienda basta il giorno; l'ora complica il modulo e i conti con l'ora legale senza aiutare.
- **Un avviso quando una scheda va in ritardo**: utile, ma prima serve vedere quanto si usano le scadenze; per ora la board e l'agente bastano.
- **La scadenza sulle schede che si ripetono** ([ADR 0069](0069-schede-ricorrenti.md)): la data cambierebbe ogni volta; servirebbe «entro N giorni», una scelta in più che oggi nessuno ha chiesto.
