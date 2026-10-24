# Settimana 72: ordini ai fornitori

Branch `week-72`. Owni dice cosa riordinare, prepara le bozze d'ordine per fornitore, ne fa il documento, e segue l'arrivo della merce, con la bolla o con la fattura, senza caricarla due volte. Non manda mai un ordine. Le scelte sono nell'[ADR 0092](adr/0092-ordini-ai-fornitori.md).

## Cosa cambia per chi usa Owni

- **«Cosa devo riordinare?», «cosa sta per finire?»**: gli articoli sotto il minimo o che ci arrivano prima della consegna, con il ritmo delle vendite, quanti ordinarne (a confezioni intere) e da chi, contando quello che è già ordinato.
- **«Fammi l'ordine per Beta», «prepara gli ordini»**: le bozze, una per fornitore, mostrate prima; ogni riga dice perché, e un fornitore che costa almeno il 5% in meno. «Ordina a Beta Forniture 50 cartucce» fa subito la bozza.
- **«Fammi il PDF dell'ordine»**: il documento in `ordini/`, anche in Word o senza prezzi. Lo manda la persona.
- **«Ho mandato l'ordine venerdì»**: segnato inviato; se Owni non sa in quanti giorni consegna il fornitore lo dice, e «Beta consegna in 10 giorni» lo salva.
- **«È arrivata la merce di Beta»**: la carica con la bolla al prezzo dell'ordine; quella già in magazzino la segna soltanto. La fattura che arriva dopo la paga invece di caricarla di nuovo.
- **«È arrivato l'ordine di Beta?»**: gli ordini che aspetta, cosa è arrivato e cosa manca.
- **Nel brief**: gli ordini in ritardo e quanti articoli riordinare.
- **«Fammi il file degli ordini»**: un CSV in `ordini/`.

## Cosa funziona (verificato dai test)

`test/orders.test.ts`: cosa riordinare con il ritmo, le confezioni, il fornitore solito e il più conveniente, la stima con poche vendite, la finestra dei giorni da quando si segue l'articolo, il tempo di consegna oltre i giorni da coprire, l'arrotondamento detto; gli ordini aperti contati, anche dopo l'invio; proposta con controllo e bozza subito quando la persona detta tutto (e proposta con un nome solo simile); lo stesso articolo in un altro ordine detto; il documento in PDF e Word, senza prezzi, mai fuori da `ordini/`; inviato con il giorno; il fornitore senza niente da riordinare; la bolla a pezzi, a confezioni e a kg; la fattura dopo la bolla (pagata, solo il resto caricato, il costo diverso detto) e la fattura dopo ancora; la merce già in magazzino segnata senza carico; l'ordine nominato nella fattura; lo stato con due ordini in attesa; un'interruzione dopo il carico; un errore degli ordini dopo il carico; un `orders.json` rovinato per ogni operazione e al carico; annullato fra proposta e conferma; turni non della persona e agenti; audit e CSV.

## Revisioni

Prima revisione, corretta: cosa riordinare non contava gli ordini già inviati e riproponeva gli stessi articoli; non c'era modo di dire che la merce era arrivata con la bolla; lo stato poteva prendere l'ordine sbagliato; un errore degli ordini dopo il carico faceva saltare il resto della risposta; un'interruzione dopo il carico lasciava l'ordine senza ricevute; vari punti di sicurezza (abbinamento sotto il blocco, eccedenze mai messe su una riga piena, conferme della persona su cambio e documento, file riscritto solo in `ordini/`) e tutte le risposte più brevi e senza numeri di riga.

Verifica finale, corretta: `received` caricava di nuovo merce già in magazzino (ora la segna soltanto); una fattura con più merce della bolla ricaricava tutta la riga (ora solo il resto); con gli ordini illeggibili la fattura si caricava lo stesso (ora è rifiutata); la bolla registrata fra proposta e conferma ora si vede; il costo diverso fra bolla e fattura si dice; il tempo di consegna vuole la persona; un fornitore detto con un nome solo simile passa dalla proposta.

Seconda verifica, corretta: un carico fatto a mano e poi segnato arrivato con «è arrivato» veniva caricato di nuovo dalla fattura del fornitore (ora la fattura lo paga e non lo carica); la metà tenuta ferma di una riga divisa fra bolla e fattura non conta più come riga lasciata fuori.
