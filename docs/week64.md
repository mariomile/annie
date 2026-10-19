# Settimana 64: listino prezzi

Branch `week-64`. Annie tiene il listino di chi vende servizi e prodotti, con prezzo, unità e IVA, e lo usa per i preventivi, le fatture in uscita e le ore da fatturare invece di chiedere ogni volta il prezzo. Le scelte sono nell'[ADR 0084](adr/0084-listino-prezzi.md).

## Cosa cambia per chi usa Annie

- **«Aggiungi consulenza 600 euro a giornata, sito base 1.500 a corpo»**: le voci nel listino, con l'IVA chiesta se manca.
- **«Quanto faccio pagare una giornata?»**, **«Qual è il mio prezzo per il sito base?»**: il prezzo senza e con IVA.
- **«Fammi un preventivo per Rossi: 3 giornate di consulenza e il sito base»**, **«Fattura a Bianchi 10 ore di sviluppo»**: prezzi, unità e IVA dal listino; un nome che può essere più voci si chiede, uno che non c'è non ha mai un prezzo inventato.
- **«Alza tutti i prezzi del 5%»**: prima l'anteprima, poi i nuovi prezzi dopo il sì.
- **«Importa il listino da questo Excel»**: anteprima con le righe scartate e il motivo, poi le voci nuove dopo il sì.
- **Ore da fatturare senza tariffa**: la tariffa oraria del listino, detta nella risposta.
- **«Mandami il listino»**: un CSV in `listino/`.

## Cosa funziona (verificato dai test)

`test/price-list.test.ts`: aggiunta, modifica e rimozione, codici e nomi che si scontrano, ricerca con le parole della domanda e le unità al plurale, voci simili che si chiedono, cambi di prezzo con anteprima, controllo, massimi e ripetizioni, import da file ostile con intestazioni IVA inclusa, righe scartate e duplicati, export con celle ostili, righe di preventivi e fatture dal listino (per codice, per nome, con modifiche, ambigue, sconosciute, IVA inclusa, IVA detta per il documento, forfettario, quantità grandi), confronto al centesimo con i preventivi IVA inclusa, tariffa delle ore, canale agenti, file rovinato, audit senza dati, prezzi con più di quattro decimali in fattura. Restano verdi i test di preventivi, fatture in uscita e ore.

## Revisioni

Prima revisione, corretta: un codice uguale al nome di un'altra voce che faceva prendere la voce sbagliata; l'IVA detta per tutto il documento sostituita da quella della voce; cambi di prezzo e import che dopo un'interruzione mostravano un secondo aumento; la tariffa oraria di un cliente usata per un altro; intestazioni «IVA compresa» lette come prezzi netti; un centesimo di differenza sulle voci IVA inclusa; «ore di sviluppo» che non trovava «Ora di sviluppo»; «a giornata» salvato come unità; domande con una sola voce scritte al plurale; codice duplicato fra i due strumenti dei documenti.

Seconda revisione, corretta: una voce IVA inclusa scorporata all'aliquota della riga invece che alla sua; una nota che prometteva un totale esatto; documenti rifiutati per le quantità grandi; voci che cominciano con parole come «una»; «1.250» letto come mille duecentocinquanta nei cambi di prezzo; la natura detta per tutta la fattura ignorata; i prezzi oltre il massimo detti come prezzi a zero; un prezzo uguale scritto IVA inclusa preso per diverso; i prezzi con più di quattro decimali in fattura, che davano un errore non gestito.

Terza revisione, corretta: oltre circa diecimila pezzi il prezzo a unità vicino poteva sbagliare la riga di decine di euro; sopra 50 centesimi Annie chiede il prezzo netto.
