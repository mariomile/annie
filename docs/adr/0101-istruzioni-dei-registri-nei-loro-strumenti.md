# Le istruzioni dei registri stanno nei loro strumenti

Dopo l'ADR 0100 i 25 registri dell'attività arrivano al modello solo quando li carica con `tool_search`, ma le istruzioni predefinite avevano ancora una frase lunga per ciascuno: quasi 12 mila caratteri, circa 3 mila token, pagati a ogni turno. Le istruzioni erano a 19.775 caratteri su un limite di 20.000, e quasi tutto quello che dicevano lo dicevano già le descrizioni degli strumenti.

## Decisione

- Le 25 frasi dei registri escono da `DEFAULT_INSTRUCTIONS`. Al loro posto c'è una frase sola che nomina i registri, con il nome dello strumento accanto a ciascuno, e dice di caricarli con `tool_search` e di seguire la loro descrizione.
- Le regole che solo le istruzioni avevano passano nella descrizione dello strumento: le conferme di incassi e pagamenti dall'estratto conto (invoices), cosa è listino, prezzi d'acquisto e magazzino (price_list), la rettifica dell'inventario (stock), sottoscorta e riordino (orders), la fattura differita entro il 15 (sales_invoices), il numero di un DDT annullato (ddt), il calendario Google solo su richiesta (appointments), l'IBAN cambiato da verificare per telefono (suppliers).
- Le frasi degli strumenti sempre offerti (file, web, memoria, liste, compiti, connettori) restano nelle istruzioni.
- Le istruzioni passano da 19.775 a 8.041 caratteri.

## Conseguenze

- Una regola di un registro si scrive in un posto solo, la sua descrizione, e arriva al modello solo quando il registro serve.
- Gli agenti già creati hanno le istruzioni salvate e tengono le frasi vecchie, che non contraddicono le descrizioni. Non c'è migrazione: chi vuole le istruzioni nuove le ripristina dalla console.
- Le istruzioni hanno di nuovo spazio sotto il limite di 20.000 caratteri.
- I test che controllavano le frasi nelle istruzioni ora controllano la frase nella descrizione e il nome del registro nelle istruzioni.
