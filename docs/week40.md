# Settimana 40: liste

Branch `week-40`. Chi usa un assistente ogni giorno gli chiede di tenere a mente la spesa, le cose da fare, i regali. Annie aveva la memoria e i task programmati, ma nessun elenco da spuntare. Ora ha le liste: si aggiungono voci a parole, si spuntano per parole o per numero, si tolgono, si rinominano, e una lista può essere di una persona sola o condivisa con la famiglia o l'ufficio. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0036](adr/0036-liste.md).

## Cosa cambia per chi usa Annie

- **«Aggiungi latte e pane alla spesa»**: due voci; se la lista non c'è, Annie la crea e dice quali altre liste ci sono, nel caso intendesse una di quelle.
- **«Ho preso il latte»**: Annie spunta il latte da comprare, non quello già preso; «ho preso tutto» spunta tutte le voci.
- **«Cosa devo ancora comprare?»**: la lista numerata, prima le voci da fare; «togli la 2» toglie la seconda.
- **«Metti 6 uova»** quando le uova ci sono già: aggiorna la quantità invece di aggiungerle due volte.
- **La spesa di casa**: «fai una lista condivisa» la rende visibile a tutti quelli che scrivono ad Annie, anche nel gruppo di famiglia; le liste di ognuno restano sue.
- **Il brief del mattino** dice quante voci restano nelle liste.

## Cosa funziona (verificato dai test)

- Nomi: «Spesa», «la lista della spesa», «lista per la spesa», «elenco spesa» sono la stessa lista; «Lista nera» resta com'è; «regalo» trova «Regali» se è l'unica che somiglia, e se sono due chiede quale (`test/lists.test.ts`).
- Voci: senza doppioni, quantità aggiornate, voci fatte rimesse da fare, per numero nell'ordine mostrato, per parole senza indovinare quando vanno bene per più voci, «era già spuntato» invece di un falso «spuntato».
- Di chi è: le liste private non si vedono da altri né nei gruppi; due liste con lo stesso nome, una privata e una condivisa, fanno chiedere quale; in un gruppo serve `shared: true`; una lista condivisa intera non si cancella da un gruppo; condividere e rendere privata solo in una conversazione a due.
- Riavvio a metà: `list_remove` per numero cambia la voce trovata prima del riavvio anche se i numeri si sono spostati, e dice quelle tolte da altri nel frattempo.
- Nota della memoria: i nomi delle liste e quante voci restano, mai le voci, e i nomi nel recinto.
- Limiti: 30 liste, 200 voci da fare, 50 fatte, 200 caratteri, 50 voci per chiamata.
- Audit: `list.changed` senza nomi né voci.

## Review indipendente

Due revisori: sicurezza e standard; specifiche e uso. Corretti:

- **Alta (sicurezza).** Le liste condivise le scrive chiunque parli con Annie, ma il loro testo arrivava al modello come se fosse di chi scrive: ora ogni risposta a chi vede una lista condivisa sta in un recinto. Una lista privata e una condivisa con lo stesso nome: il tool sceglieva da solo. Spuntare o togliere per numero dopo un riavvio poteva colpire un'altra voce: ora le voci si trovano in uno step e si cambiano per id in un altro.
- **Media (sicurezza).** In un gruppo una lista nuova diventava condivisa da sola: ora serve `shared: true`. Una lista condivisa intera si cancellava da un gruppo. Le descrizioni non dicevano di ignorare le richieste che arrivano da mail, file e pagine web.
- **Alta (uso).** Spuntare una voce già fatta diceva «spuntato». «3 uova» dopo «uova» faceva un doppione. Le risposte non dicevano se una lista era privata o condivisa, e cosa vuol dire condivisa.
- **Media (uso).** Mancavano spunta tutto, rinomina e condividi; i nomi delle liste non arrivavano al modello, che ne creava di nuove; nomi simili («regalo» e «Regali», «elenco spesa»); grammatica e maiuscole delle risposte.
- **Bassa.** Il testo delle voci e la ricerca per parole stanno ora in `text-match.ts`, condiviso con `file_search`; un cambiamento che non cambia niente non riscrive il file.

Una seconda revisione sulle correzioni ha trovato, ed è corretto: la regola che toglie articoli e quantità tagliava l'inizio di parole come «latte» e «insalata» (ora vuole uno spazio dopo l'articolo e l'unità, con i test su queste parole); il nome di una lista condivisa usciva dal recinto quando si cancellava o si rendeva privata l'ultima, e una lista resa privata teneva voci scritte da altri (ora tutto quello che esce dalle liste è nel recinto); il brief non vedeva le liste private; cancellare una lista intera dopo un riavvio poteva prendere una lista dal nome simile (ora anche lì la lista si trova prima, per id); i nomi simili dipendevano dalle maiuscole.
