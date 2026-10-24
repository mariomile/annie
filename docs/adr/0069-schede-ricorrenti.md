# Schede che si ripetono

Molto del lavoro affidato agli agenti torna uguale: il report vendite del lunedì, il controllo delle fatture scadute a inizio mese, la rassegna dei bandi ogni mattina. Con la board ([ADR 0050](0050-board.md)) bisogna ricreare la scheda ogni volta. I task programmati tornano da soli, ma sono un messaggio in una chat: non hanno una colonna, un «Da rivedere» né un commento per rimandarli indietro.

## Decisione

- **Nella nuova scheda, se la affidi a un agente, «Si ripete»**: ogni giorno, dal lunedì al venerdì, ogni settimana (un giorno) o ogni mese (dall'1 al 28), a un'ora, nel fuso di Roma, con l'ora legale (un'ora fra le 2 e le 3 salta il giorno in cui l'ora legale comincia, perché quell'ora non esiste). Al posto della scheda nasce una scheda che si ripete; la prima volta è alla prossima ora scelta.
- **Ogni volta nasce una scheda nuova**, con titolo, descrizione, priorità e agente della ricorrente, e parte subito con la persona che l'ha impostata, come se avesse premuto Avvia: stessa conversazione nuova, stessi controlli (la persona deve poter scrivere all'agente). Con «Lavora da solo» spuntato, ogni scheda lavora da sola ([ADR 0061](0061-agenti-da-soli.md)).
- **Le imposta solo una persona**, dalla board. Un agente non può: un agente che si dà lavoro da solo ogni settimana è proprio quello che Avvia evita.
- **Finché l'ultima scheda non è in «Fatto», non ne nasce un'altra**: sulla scheda aperta un commento dell'agente (nessuna persona l'ha scritto) dice che doveva ripartire, e la ricorrente lo mostra. Così le schede non si accumulano se nessuno le rivede.
- **Owni spenta**: al riavvio nasce una scheda sola per le volte perse, e la prossima è dopo adesso. La prossima ora si segna prima di creare la scheda, e la scheda si segna come ultima appena nata, prima di partire: un crash nel mezzo salta una volta o lascia la scheda in «Da fare», non ne crea due. Una scheda che non riesce a partire resta in «Da fare» con un commento che dice perché, e si avvia a mano.
- **Sopra le colonne, «Si ripetono»**: titolo, agente, quando, la prossima volta, l'ultima scheda e, se l'ultima volta non è partita, il perché. Si mette in pausa (ripresa, conta da adesso), o si toglie; le schede già nate restano. Le vede e le cambia chi le ha impostate, e l'owner, che vede anche chi l'ha impostata. Una pausa premuta mentre la ricorrente sta per partire vale: quel giro non parte.
- **Agente eliminato, persona tolta, o persona che non può più scrivere all'agente**: la ricorrente va in pausa con il motivo, come un task programmato che perde l'accesso. Si riprende solo se il motivo è passato. Al più 50 ricorrenti per tenant. Audit `board.routine_created`, `board.routine_changed`, `board.routine_deleted`; le schede nate hanno `board.card_created` e `board.card_started` con `routineId`.

## Alternative scartate

- **Una scheda sola che torna in «Da fare» a ogni volta**: si perde la storia di ogni giro (commenti, conversazione, revisione), e una scheda ferma blocca le successive senza che si veda.
- **Un'espressione cron libera**: quattro scelte coprono quasi tutto e si spiegano in una riga; il cron resta sotto, scritto da Owni.
- **Usare i task programmati**: parlano in chat, non sulla board; mischiarli avrebbe dato ai task una revisione che non serve e alla board messaggi senza colonna.
