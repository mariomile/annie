# Settimana 49: solleciti di pagamento

Branch `week-49`. Owni prepara e manda i solleciti ai clienti che non hanno pagato, sempre con l'approvazione di chi la usa. Le scelte sono nell'[ADR 0054](adr/0054-solleciti-di-pagamento.md).

## Cosa cambia per chi usa Owni

- **«Chi non mi ha ancora pagato?»**: le fatture scadute da incassare, con i solleciti già mandati.
- **«Prepara un sollecito per Gamma»**: oggetto e testo pronti, al netto delle note di credito, con i giorni di ritardo e l'IBAN dell'azienda; il livello sale da solo (promemoria, secondo sollecito, sollecito formale).
- **«Mandalo»** dalla console: una card di approvazione per cliente; dopo l'invio il sollecito è annotato nello scadenzario.
- **Dal telefono**: un messaggio per cliente da copiare, o un link che apre la posta già compilata.
- **«L'ho mandato io»**: Owni lo annota.
- **«Aggiungi le 40 € e gli interessi all'8%»**: conti esatti e scritti nel sollecito.
- **«La mia azienda ha IBAN … e firmo Anna Bianchi»**: da lì i solleciti usano quell'IBAN e quella firma.

## Cosa funziona (verificato dai test)

`test/solleciti.test.ts` e `test/solleciti-send.test.ts`: tre livelli e livello che sale, frasi sul sollecito precedente solo se annotato, fatture non ancora scadute, note di credito, sabato e festivi, IBAN salvato, IBAN delle fatture discordi o sbagliati, rubrica e PEC, link `mailto:`, doppioni nello stesso giorno e card in attesa, coda piena, Lei per i privati e Spett.le per le imprese, PA e split payment, 40 € e interessi in più valute, canale agenti rifiutato, elenco rovinato, audit senza dati, e il percorso intero dall'app: chat, card, approvazione, annotazione.

## Revisioni

Prima revisione, corretta: IBAN e indirizzo presi dal file più recente senza controlli, indirizzi email del cliente quasi mai presenti nelle fatture (ora una rubrica), invio impossibile dal telefono, doppioni e livelli che tornavano indietro, azienda salvata col nome sbagliato che diceva «nessuno in ritardo», sollecito formale su fatture non scadute, frasi su solleciti mai mandati, Lei e voi, interessi in valute diverse, coda piena che creava card doppie. Lo scadenzario è diviso in moduli più piccoli (`invoice-store.ts`, `invoice-sums.ts`, `invoice-due.ts`, `invoice-parties.ts`, `invoice-fence.ts`).

Seconda revisione, corretta: numeri o nomi lunghissimi che rovinavano lo stato, rubrica illeggibile che ripiegava sull'indirizzo del file, rate non ancora scadute messe in mora, note di credito scalate due volte in solleciti per singola fattura, «l'ho mandato» dopo un invio che alzava il livello, IBAN di un file negli invii (ora solo quello salvato), livello unico per cliente (ora per fattura, con lettere separate), storico perso segnando pagata, nomi dei file in oggetto e firma, link `mailto:` più compatibili.
