# Settimana 69: magazzino

Branch `week-69`. Carichi e scarichi a parole, quanto resta, cosa sta finendo, quanto vale il magazzino, l'inventario, e le fatture emesse che scaricano da sole gli articoli venduti. Le scelte sono nell'[ADR 0089](adr/0089-magazzino.md).

## Cosa cambia per chi usa Annie

- **«Ho ricevuto 50 cartucce XL dal fornitore Beta a 12 € l'una»**: caricate, e l'articolo creato se non c'era.
- **«3 scatole da 12 a 30 € la scatola»**: 36 pezzi a 2,50 €.
- **«Quante cartucce mi restano?»**, **«Cosa sta finendo?»**, **«Quanto vale il magazzino?»**: quantità, sottoscorta e valore a quanto è stata pagata la merce.
- **«Ho contato 37 cartucce, sistema»**: la differenza, «ne mancano 13».
- **«Avvisami sotto le 10»**: una riga nel brief quando scende sotto.
- **«Ho usato 2 rotoli in laboratorio»**, **«Butta 3 confezioni scadute»**: scarichi per uso interno e scarto.
- **Una fattura emessa** con voci del listino scarica gli articoli, e l'anteprima lo dice prima del sì.

## Cosa funziona (verificato dai test)

`test/stock.test.ts`: costo medio con più carichi, scarichi che non lo cambiano, quantità con decimali, negativo chiesto e confermato solo dalla persona, inventario come rettifica, fattura che scarica una volta anche ripetuta, bozza che non scarica, nota di credito che ricarica fino a quanto scaricato, unità diverse e confezioni, nomi al plurale e con «di», primo carico che crea l'articolo, correzione del costo, chiusura dell'anno con quantità, medie e note di credito uguali prima e dopo, magazzino pieno o rovinato durante un'emissione, sottoscorta detto una volta per discesa, canale agenti senza costi, export con celle ostili, audit senza dati.

## Revisioni

Prima revisione, corretta: «cartuccia» e «rotoli di carta» non trovavano l'articolo; il primo carico di un articolo nuovo chiedeva di ripetere tutto; le confezioni non si potevano dire; con il magazzino pieno le fatture restavano a metà con un errore crudo; la voce del listino su una riga di fattura poteva scaricare un articolo senza che l'anteprima lo dicesse; un avviso poteva mandare in negativo o caricare a un costo sbagliato senza la persona; il costo di un carico non si poteva correggere; risposte con id e parole come «costo medio ponderato».

Verifica finale, corretta: il confronto dei nomi scambiava parole diverse («colla» caricava «Collo») e scriveva subito; ora unisce solo singolare e plurale, e per un carico o uno scarico con un nome non esatto chiede. In più: messaggi giusti quando il magazzino è pieno o non si legge, chiavi delle vendite vecchie tolte alla chiusura dell'anno, chiusura rifiutata con un articolo troppo in negativo.
