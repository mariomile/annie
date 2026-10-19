# Settimana 73: DDT e fattura differita

Branch `week-73`. Annie fa i DDT della merce che la persona spedisce, scarica il magazzino quando li emette, e a fine mese prepara la fattura differita che li raccoglie, senza scaricare due volte. Non manda mai un DDT. Le scelte sono nell'[ADR 0093](adr/0093-ddt-e-fattura-differita.md).

## Cosa cambia per chi usa Annie

- **«Fammi il DDT per Rossi: 10 risme e 2 toner»**: la bozza, con le voci del listino o testo libero; causale vendita se non è detta (conto visione, reso, riparazione, omaggio…), il trasporto chiesto prima di emetterlo.
- **«Emettilo»**: prende il numero del 2026 («12/2026») dopo il sì, e scarica gli articoli del magazzino; prima dice cosa scarica.
- **«Stampa il DDT»**: il PDF (o il Word) in `ddt/`. Lo manda la persona.
- **«Annulla il DDT 12»**: annullato, il numero resta.
- **«Quali DDT non ho ancora fatturato?»**: per cliente e mese, con quelli già in una bozza di fattura.
- **«Fai la fattura differita di ottobre per Rossi»**: la bozza con tutti i DDT di vendita di ottobre del cliente, i prezzi dal listino e quelli che mancano chiesti; nell'XML i DatiDDT; va emessa entro il 15 del mese dopo.
- **Nel brief**: i DDT del mese scorso ancora da fatturare, con la scadenza del 15, e le bozze di DDT ferme.
- **«Numera i DDT come 12»**, **«l'ultimo DDT che ho fatto era il 40»**: la numerazione.

## Cosa funziona (verificato dai test)

`test/ddt.test.ts`: bozza subito con cliente e voci esatti, proposta con controllo con nomi solo vicini (e controllo sbagliato rifiutato); modifica della bozza; turni non della persona e agenti; anteprima con il numero e gli effetti sul magazzino, scarico una volta sola anche ripetendo; magazzino illeggibile che non blocca e si completa dopo; reso che rimette la merce del suo DDT, conto visione che scarica, riparazione che non muove niente, reso di un altro cliente rifiutato; primo DDT dell'anno che chiede l'ultimo numero; numerazione e annullato che tiene il numero; PDF solo di un DDT emesso, CSV protetto; fattura differita con il prezzo chiesto per la riga senza voce, DatiDDT nell'ordine dello schema, niente secondo scarico, DDT fatturati solo all'emissione e tenuti dalla bozza, seconda bozza e annullamento rifiutati, margini con il costo dello scarico del DDT; bozza tolta che libera i DDT, più mesi chiesti, trimestre rifiutato; `ddt.json` rovinato mai sovrascritto e fattura differita non emessa; nota di credito senza DDT; il 15 in ritardo; il brief una volta al giorno con la scadenza dopo il 10 e le bozze ferme; istruzioni e brief in sola lettura.
