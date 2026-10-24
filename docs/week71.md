# Settimana 71: margini

Branch `week-71`. Owni dice quanto la persona guadagna davvero su ogni prodotto e su ogni cliente, quali prodotti rendono di più e su quali ci perde, se il listino regge con i costi di adesso, e cosa cambierebbe con un prezzo o un costo diverso. Legge soltanto: le fatture emesse, il magazzino, il listino e i prezzi d'acquisto. Le scelte sono nell'[ADR 0091](adr/0091-margini.md).

## Cosa cambia per chi usa Owni

- **«Quanto guadagno sul toner?»**: venduti, incassato e costato senza IVA, guadagnato e la percentuale, al costo medio del magazzino a ogni vendita; le vendite stimate, i resi e le righe lasciate fuori si dicono.
- **«Quali prodotti mi rendono di più? Su quali ci perdo?»**: la classifica in euro e in percentuale, i migliori, i peggiori o solo quelli in perdita.
- **«Quanto mi rende Rossi?»**: ricavo, costo della merce e guadagno per cliente; le ore fatturate contano con il loro costo solo se la persona dice quanto le costa un'ora.
- **«Il listino è ancora giusto?»**: le voci sotto il 20% (o la soglia detta) o in perdita, con il prezzo che le riporta alla soglia; per aggiornarlo, il listino mostra prima l'anteprima.
- **«E se alzo il toner del 5%?»**: quanto guadagnerebbe sulle stesse quantità. Solo un calcolo, niente cambia.
- **Nel brief**: le voci vendute la settimana scorsa sotto costo o con poco guadagno, ognuna una volta, tre al massimo a settimana.
- **«Mandami i margini in un file»**: un CSV in `margini/`, da aprire con Excel.

## Cosa funziona (verificato dai test)

`test/margins.test.ts`: costo registrato su ogni scarico di vendita e vendite vecchie senza costo stimate dall'ultimo acquisto; più vendite a costi medi diversi; note di credito con e senza storno, mai oltre la merce uscita; sconti di riga, bollo e spese anticipate; confezioni e unità diverse; servizi e ore; classifiche e filtri; margini per cliente; controllo del listino con il prezzo che riporta alla soglia, anche a confezioni con IVA inclusa, e la riga che dice quando quel prezzo non si calcola; simulazioni di prezzo e costo; anno chiuso con il costo tenuto e l'apertura come stima; acquisti per nome solo con le stesse parole e mai scelti fra due prodotti; un costo corretto dopo la vendita; percentuali arrotondate per difetto; agenti senza risposta; audit senza dati; CSV con celle ostili; brief una volta per voce, tre a settimana, e quando le voci sono già state dette. `test/stock.test.ts`: la chiave di una vendita chiusa tiene il suo costo.

## Revisioni

Prima revisione, corretta: una nota di credito restituiva il costo di tutta la quantità chiesta, anche oltre quella uscita, o senza storno (M1); chiudere l'anno faceva perdere il costo delle vendite (M2); un acquisto con un nome solo simile diventava il costo del prodotto, e una stima appariva come perdita (M3); una correzione del costo di un carico non si diceva sulle vendite già fatte, e il 100% poteva essere un arrotondamento; più vari punti delle risposte: classifica numerata da uno, un cliente trovato con un solo nome vicino, la stima del listino detta come tale, le voci senza articolo con il costo dal loro nome.

Verifica finale, corretta: il brief, a tetto della settimana raggiunto, diceva che le voci non erano dette «per non riempire il brief» (ora dice che quelle della settimana le ha già segnalate); una voce del listino per cui il prezzo giusto non si riusciva a calcolare perdeva quella parte della riga senza dirlo (ora lo dice).
