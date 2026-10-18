# Automazioni: un indirizzo che fa lavorare l'agente

Un agente lavorava quando una persona gli scriveva, a un'ora fissa (task programmati) o quando una pagina cambiava (sentinelle). Mancava il caso più comune in un'azienda: «quando arriva un ordine dal sito», «quando qualcuno compila il modulo», «quando Stripe incassa un pagamento». MausBot e Codync lo fanno con le automazioni da webhook (confronto del 18 ottobre 2026 sulle alternative open source a Grok Bot).

## Decisione

- **Un'automazione è un indirizzo segreto** di un agente, `POST /hooks/automazione/<agente>/<id>`, con un nome, un'istruzione («Riassumi l'ordine e dimmi se c'è da spedire oggi»), la conversazione dove risponde e la persona per cui lavora. Ogni chiamata fa partire l'agente con l'istruzione e i dati ricevuti, come un task programmato che scatta: la persona deve poter ancora parlare con l'agente, e la risposta va nella conversazione dove l'automazione è nata.
- **Il token** va in `Authorization: Bearer`, in `X-Annie-Token` o, per i servizi che non permettono intestazioni, in `?token=`. Se ne tiene solo l'hash; un token sbagliato, un'automazione o un agente che non esistono rispondono tutti 404. Per cambiarlo si cancella e se ne crea un'altra.
- **I dati sono dati**: il corpo (al più 64 KB) arriva al modello come JSON indentato, campi di un modulo o testo, al più 12.000 caratteri, dentro i marcatori di dati non fidati con le loro imitazioni rese inerti, come le pagine web.
- **Una volta per consegna**: con `Idempotency-Key` la stessa chiamata ripetuta dal servizio parte una volta sola, e non conta né per il limite né fra le chiamate. Molti servizi (Stripe compreso) non mandano l'intestazione ma un id dell'evento nel corpo: per loro ogni consegna ripetuta parte di nuovo, e l'istruzione può dire all'agente di ignorare un evento già visto. Al più 30 chiamate l'ora per automazione (`429` oltre), così un ciclo fra servizi non diventa un conto del modello. `409` quando la persona non può più parlare con l'agente o il canale della conversazione è spento: il servizio dovrebbe smettere. `503` per un errore nostro: il servizio riprova.
- **Si crea dalla chat** con `automation_create`, in una conversazione scritta con una persona sola (non in una chiamata, dove il token verrebbe letto a voce, né da un altro agente), o **dalla console** (`GET`, `POST`, `DELETE /api/instances/:id/automations`), per una propria chat. Dalla chat l'indirizzo e il token arrivano alla persona in un messaggio a parte, dalla outbox, e il modello non li vede mai: niente di quello che l'agente legge dopo può farglieli ripetere. Il messaggio ripete l'istruzione, così la persona vede cosa sta consegnando. Una volta consegnato, nella outbox ne resta la chiave ma non il testo; resta nella cronologia della chat, come ogni messaggio. Se il messaggio non parte, l'automazione si cancella. Dalla console il token si vede una volta, nella risposta alla creazione. Ognuno vede e cancella le sue, l'owner tutte.
- Gli errori del server sull'indirizzo si scrivono nel log senza la query, che può contenere il token.
- L'audit scrive `automation.created`, `automation.fired`, `automation.limited` e `automation.deleted`, mai i dati.

## Sicurezza

- L'indirizzo non chiede la sessione né l'intestazione `X-Annie` della console: è fatto per servizi esterni, e il token è l'unica chiave. Chi ha il token fa lavorare l'agente per quella persona, con i suoi strumenti; il messaggio con il token lo dice.
- Un testo letto dall'agente (anche i dati di un'altra automazione) potrebbe fargli creare un'automazione: il token però va alla persona, non all'agente né a chi ha scritto il testo. Potrebbe anche fargliene cancellare una della stessa persona: si ricrea.
- In Annie Cloud la cella si sveglia anche per `/hooks/`, come per Telegram e WhatsApp.

## Alternative scartate

- **Firma HMAC del corpo** (come Stripe e GitHub): ogni servizio firma a modo suo, mentre un token in un'intestazione lo mandano tutti, Zapier e Make compresi. Si può aggiungere per un servizio preciso.
- **Il token nel risultato del tool**: più semplice, ma il token resterebbe nella conversazione mandata al modello.

## Da fare

- Pagina «Automazioni» nella console sulle API di questo ADR, con il pulsante per copiare indirizzo e token.
