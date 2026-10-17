# Liste: la spesa, le cose da fare, i regali

Le persone usano un assistente per tenere a mente le cose: «aggiungi latte e pane alla spesa», «ho preso il latte», «cosa devo ancora fare?», la lista della spesa di casa che tengono in due. Annie aveva la memoria (fatti su una persona) e i task programmati (un messaggio a un'ora), ma nessun posto per un elenco che cambia ogni giorno: la memoria non è fatta per spuntare, e un file nel workspace non distingue chi lo vede.

## Decisione

Quattro tool: `list_add` (aggiunge voci, crea la lista se non c'è), `list_show` (la lista numerata, o quali liste ci sono), `list_check` (spunta, o con `undo` rimette da fare), `list_remove` (toglie voci, quelle fatte, o la lista intera). Le liste sono in `lists.json` dell'istanza, cambiate sotto lo stesso lock su file della memoria.

- **Di chi è una lista**: come la memoria. Una lista è della persona che l'ha creata e la vede solo nelle conversazioni con lei sola; con `shared: true` è condivisa con tutti quelli che scrivono all'istanza (la spesa di famiglia, le cose da fare di un ufficio), e solo quando la persona lo chiede. In un gruppo si vedono solo le liste condivise e una lista nuova è sempre condivisa: un gruppo non deve leggere le liste private di nessuno.
- **Il nome**: «Spesa», «la lista della spesa», «lista per la spesa» sono la stessa lista, senza accenti né maiuscole; il nome si scrive senza «lista della».
- **Le voci**: una per riga, come la persona le ha dette. La stessa voce non si aggiunge due volte (senza accenti né maiuscole); una voce fatta che torna nella spesa è rimessa da fare.
- **Quale voce**: per numero, come lo dà `list_show` (prima le voci da fare, poi le fatte più recenti), o per parole: la voce uguale, oppure l'unica che le contiene tutte («soia» è «latte di soia»), cercate come in `file_search` (ADR 0035). Se le parole vanno bene per più voci Annie non cambia niente e dice quali: chiede, invece di spuntare quella sbagliata.
- **Le voci fatte** restano, le 50 più recenti, per rimetterle da fare o rivederle; `list_remove` con `done` le toglie.

## Limiti

30 liste per persona e 30 condivise, 200 voci da fare per lista, 200 caratteri per voce, 50 voci per chiamata.

## Sicurezza

- Le voci le scrivono le persone che possono parlare con Annie. Una mail, un file o una pagina web arrivano al modello come dati; nella chat del brief del mattino, che legge le mail, solo `list_show` funziona.
- Ogni cambiamento è uno step durevole: dopo un riavvio a metà la voce non si aggiunge due volte.
- L'audit registra `list.changed` con la lista (id), il tipo di cambiamento e quante voci, mai i nomi o le voci.

## Alternative scartate

- **Liste nella memoria**: la memoria arriva al modello con ogni messaggio ed è fatta di frasi; una spesa di trenta voci la riempirebbe e non si spunta.
- **Un file Markdown nel workspace**: il modello dovrebbe riscriverlo tutto a ogni voce, e il workspace è dell'istanza, senza liste private.
- **Promemoria dentro la lista** (una scadenza per voce): per un'ora c'è già `schedule_create`, che la descrizione del tool ricorda.
