# Il contesto del turno: l'ora e la memoria a ogni richiesta

L'agente non sapeva che giorno fosse: «domani», «venerdì prossimo», «fra due ore» li leggeva a caso, o chiamava uno strumento per saperlo. La nota della memoria (ADR 0062) si attaccava al testo della persona quando il messaggio entrava nella conversazione: restava nella storia per sempre, una copia per messaggio, con le memorie com'erano allora, e una memoria cambiata a metà di un lavoro lungo non arrivava al modello fino al messaggio dopo.

## Decisione

- **L'ora e la memoria si aggiungono a ogni richiesta al modello, non al messaggio salvato.** Prima di ogni richiesta l'adapter di Pi Durable (`beforeRequest` di `GenerationTask`) chiede al runtime il contesto del turno della conversazione e lo mette in fondo all'ultimo messaggio della persona, solo per quella richiesta. La storia tiene le parole della persona così come le ha scritte.
- **L'ora**: «[Ora] giovedì 22 ottobre 2026 alle ore 16:40, ora italiana.», con il fuso di Roma (`src/core/turn-context.ts`). Al minuto: dentro lo stesso minuto la richiesta è identica e la cache del prompt regge; il prompt di sistema non cambia mai per l'ora.
- **La memoria**: la stessa nota di prima (`memoryNote`, le essenziali, le liste visibili e quante ne ha l'archivio), letta a ogni richiesta, anche a metà di un lavoro lungo. Di chi si parla viene dalle persone della conversazione (`participants`): la persona in una conversazione privata e in un'automazione di quella persona da sola, nessuno in un gruppo, che riceve solo le memorie condivise.
- **Anche i turni senza persona** (avvisi, automazioni) ricevono il contesto, con la stessa regola su chi è: prima non avevano né l'ora né la memoria.
- Il modello di prova (`faux`) non ripete l'ora quando fa l'eco, perché non è quello che la persona ha scritto e cambia ogni minuto. La memoria la ripete ancora, come prima.

## Sicurezza

- Niente cambia su chi vede cosa: la persona della conversazione si sceglie come prima, e in un gruppo le memorie personali non arrivano mai.
- Il contesto non si salva da nessuna parte: non c'è niente di nuovo da cancellare o da esportare.

## Conseguenze

- Le conversazioni lunghe non portano più una nota vecchia a ogni messaggio: meno token e nessuna memoria superata nella storia.
- Le conversazioni già esistenti tengono le note che avevano. Non si riscrivono.
- Il contesto costa qualche decina di token a richiesta, anche nei passi con gli strumenti di uno stesso turno.
