# Memoria con archivio

La memoria di una persona (fase 2 del [piano cloud](../piano-cloud.md)) arrivava tutta con ogni suo messaggio, con un tetto di 50: al cinquantunesimo fatto Annie rifiutava, e ogni dettaglio salvato (il compleanno di un cliente, i termini di un fornitore) costava in ogni richiesta. Le alternative open source a Grok Bot che abbiamo guardato dividono la memoria in due: OpenBot una memoria essenziale con un budget nel prompt e una memoria salvata che si cerca, Rakazo e Codync memorie per agente con ricerca a testo (confronto del 18 ottobre 2026).

## Decisione

- **Due livelli**: le memorie **essenziali**, che arrivano con ogni messaggio come prima (al più 50 per persona), e l'**archivio**, che si cerca con `memory_search` (al più 1000 per persona e per le condivise).
- **L'agente sceglie dove** con `memory_remember`: essenziale quello che serve in quasi ogni conversazione (come vuole le risposte, il suo ruolo), in archivio (`essential: false`) i dettagli che servono ogni tanto. Dalla console una persona può salvare in archivio con `archived: true`.
- **Pieno non vuol dire rifiutare**: quando le essenziali di una persona sono 50, la più vecchia passa in archivio e la nuova entra. Si rifiuta solo con l'archivio pieno.
- **La nota dice che l'archivio c'è**: in fondo alle memorie del messaggio, «Altre N in archivio: ... cercale con memory_search», così l'agente sa quando cercare senza ricevere il testo.
- **La ricerca usa le parole di `file_search`** (`text-match.ts`: parole vuote tolte, «fatture» trova «fattura», frasi fra virgolette): prima le memorie che hanno più parole della domanda, poi le più nuove, al più 10. Le stesse regole di sempre su chi vede cosa: in una conversazione con una persona le sue e le condivise, in un gruppo solo le condivise.

## Alternative scartate

- **Ricerca semantica con embedding** (Supermemory in Rakazo): serve un servizio o un modello in più per ogni tenant; le parole bastano per nomi, date e fornitori, che sono quasi tutto quello che si salva.
- **Un «custode» che dopo ogni conversazione salva da sé cosa ricordare** (l'Engram di Codync): utile, ma costa una chiamata al modello per conversazione e salva cose che la persona non ha chiesto. Da valutare dopo, come proposta che la persona approva.

## Console

Nella pagina «Memoria» le essenziali restano in elenco e l'archivio sta sotto, chiuso, con quante sono e, oltre le 8, un campo per filtrarle. Aggiungendo una memoria a mano, la casella «In archivio» la salva lì.
