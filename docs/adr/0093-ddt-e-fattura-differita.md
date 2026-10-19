# DDT e fattura differita

Chi spedisce merce ai clienti fa un documento di trasporto (DDT) a ogni consegna e, a fine mese, una fattura differita che raccoglie i DDT del cliente. Annie faceva le fatture e scaricava il magazzino quando erano emesse, ma «fammi il DDT per Rossi», «quali DDT non ho ancora fatturato?», «fai la fattura differita di ottobre» non avevano risposta, e la merce uscita con un DDT non si scaricava finché non arrivava la fattura.

## Decisione

- **Strumento `ddt`**: `create`, `change`, `issue`, `cancel`, `list`, `status`, `document`, `export`, `settings`. I DDT (DT-0001, mai dati due volte) stanno in `ddt.json` dell'istanza, con la copia `.bak`. Un DDT ha cliente (dalla scheda, da una fattura emessa, da un DDT precedente, o come detto), destinazione se diversa, causale, trasporto (mittente, destinatario o vettore con il nome), aspetto, colli e peso, e le righe: una voce del listino o testo libero, quanti e in che unità, senza prezzi.
- **Bozza e numero**: la bozza non ha numero. Quando la persona detta cliente e voci con il loro nome esatto, la bozza si fa subito; quando Annie prende un cliente o una voce solo vicini a come sono stati detti, o un cliente che non conosce, mostra prima la proposta con un controllo. Il numero («12/2026», o «12» se la persona lo sceglie) si prende solo all'emissione, dopo il sì, sotto il blocco del file; il primo DDT dell'anno chiede l'ultimo numero fatto prima di Annie, come le fatture. Un DDT emesso non si cancella: si annulla, e il numero resta.
- **Causale predefinita vendita**, detta nella risposta. Il trasporto si chiede prima dell'emissione, non alla bozza.
- **Magazzino all'emissione**: vendita, omaggio e conto visione scaricano le righe con una voce che è un articolo, una volta per DDT e riga (la stessa `sale` del magazzino delle fatture, con il DDT come documento: «vendita, DDT n. 12/2026» nei movimenti). Il reso rimette in magazzino la merce del DDT da cui torna (detto dalla persona), mai più di quanto quel DDT aveva scaricato, come lo storno di una nota di credito. Riparazione, comodato e lavorazione non muovono niente. L'anteprima dice cosa si scarica e un articolo che andrebbe sotto zero; un magazzino illeggibile o pieno non blocca mai l'emissione: il DDT è emesso e si completa emettendolo di nuovo.
- **Fattura differita**: è `sales_invoices` con `ddt` e il mese, sulla stessa strada delle altre bozze. Prende tutti i DDT di vendita del cliente emessi in quel mese, non fatturati e non già in un'altra bozza; una riga per riga di DDT, legata al suo DDT e alla sua riga. Il prezzo viene dal listino (la voce, nella sua unità); le altre righe si chiedono, numerate, e la persona le dice: mai un prezzo inventato. Senza mese, il mese è quello dei DDT da fatturare; con più mesi si chiede. Un mese solo per fattura.
- **DatiDDT nell'XML**: per ogni DDT il numero, la data e i numeri delle righe della fattura che lo fatturano. La copia di cortesia lo dice.
- **Niente doppio scarico**: le righe che vengono da un DDT non muovono il magazzino all'emissione della fattura (la merce è uscita con il DDT). I margini trovano il costo sullo scarico del DDT, anche dopo la chiusura dell'anno del magazzino.
- **Fatturato solo all'emissione**: una bozza tiene i suoi DDT (un'altra bozza non li prende, controllato sotto il blocco delle fatture), ma non li segna; toglierla li libera. All'emissione, un passo del completamento segna i DDT fatturati con il numero della fattura, una volta; prima del numero si controlla che nessun DDT sia stato annullato, cambiato o fatturato altrove.
- **Il 15 del mese dopo**: la bozza dice entro quando va emessa; l'anteprima dell'emissione lo ridice, e dice chiaramente quando è in ritardo. Nel brief, una volta al giorno: i DDT del mese scorso ancora da fatturare (quanti e i clienti), con la scadenza del 15 detta dopo il 10, e le bozze di DDT ferme da più di 7 giorni.
- **Documento**: PDF o Word in `ddt/`, con la nostra intestazione, destinatario, causale, trasporto, colli, peso, righe e le firme; mai mandato da Annie. Solo un DDT emesso si stampa. Il CSV ha le celle protette dalle formule e le quantità esatte.

## Sicurezza

- **Solo la persona**: creare, cambiare, emettere, annullare, il documento, la numerazione e l'ultimo numero passano da `requirePersonFor`. Un altro agente riceve solo i conteggi (bozze, DDT da fatturare); il resto è rifiutato con una frase.
- Clienti, indirizzi, righe e note stanno solo nel recinto dei «dati dei DDT»; fuori, numeri di DDT e conteggi. L'audit registra operazione e conteggio.
- **File illeggibile**: un `ddt.json` rovinato non viene mai sovrascritto; ogni operazione lo dice, e una fattura differita non si emette (prima di prendere il numero) finché non è sistemato.
- **Un'interruzione**: l'emissione del DDT e lo scarico sono passi propri; ripetuti, non danno un altro numero né scaricano due volte.

## Alternative scartate

- **Scaricare alla fattura**: la merce è uscita con il DDT, spesso settimane prima; il magazzino avrebbe mostrato merce che non c'è più.
- **Segnare fatturati i DDT già alla bozza**: una bozza tolta li avrebbe lasciati fatturati senza fattura.
- **Una causale ignota scritta come detta**: la causale decide cosa si muove in magazzino; resta una delle sette.
- **Annullare un DDT rimettendo in automatico la merce in magazzino**: se la merce è partita lo stesso, il magazzino sarebbe sbagliato; Annie lo dice e la correzione resta un conteggio della persona.
- **Il prezzo dalla vendita precedente**: è un'ipotesi che la persona non ha detto; solo il listino o la persona.
