# Settimana 48: scadenzario delle fatture

Branch `week-48`. Owni tiene lo scadenzario delle fatture elettroniche che trova nel workspace: cosa pagare e cosa incassare, cosa è scaduto, quanto si deve a un fornitore, e segna le fatture pagate. Le scelte sono nell'[ADR 0053](adr/0053-scadenzario.md).

## Cosa cambia per chi usa Owni

- **«Quali fatture devo pagare questa settimana?»**: «Fino a domenica 25/10: da pagare 626,75 €, più 626,75 € già scaduti; da incassare 99,90 €», poi le rate in ordine, con le scadute in testa.
- **«Quanto devo ad Alfa?»**: l'aperto al netto delle note di credito di Alfa, le rate e l'IBAN.
- **«Segna pagata la 153 di Alfa»**, anche una sola rata; una nota di credito diventa «usata».
- **«La mia azienda è Beta Ristorazione, P.IVA …»**: da lì ogni fattura è da pagare o da incassare.
- **«Ricordami le scadenze ogni lunedì alle 8»**: un'automazione che chiama lo scadenzario e riassume in poche righe.
- **Una scadenza di sabato**: non è in ritardo fino a lunedì, e Owni lo dice.

## Cosa funziona (verificato dai test)

`test/invoices.test.ts`: fatture ricevute ed emesse, con e senza azienda, rate, note di credito mai sotto zero, scadute, sabato e festivi, tutte le finestre, mesi senza anno, totali esatti con decimali misti, pagate per rata e per fattura con eccezioni, limiti che rifiutano invece di cancellare, stato rovinato, brief solo in lettura, cache che si aggiorna quando un file cambia, `.p7m` e doppioni, 500 file non fattura, letture fallite riprovate, recinto con nomi ostili, audit senza dati, e una prova dall'app vera.

## Revisioni

Prima revisione, corretta: partite IVA dell'azienda accettate anche sbagliate, totali che sommavano da pagare e da incassare senza azienda, fatture sparite senza dirlo quando un worker era occupato, cache che rileggeva tutto oltre 2000 file, importi negativi girati in positivo, un «non pagata» che poteva cancellare i segni di altre fatture, stato rovinato che bloccava lo strumento, rate alternative sommate, scadenze del sabato date in ritardo la domenica, mesi senza anno letti nell'anno dopo. Risposte più corte per il telefono, divise in da pagare e da incassare, note di credito «da scalare», numeri di fattura riconosciuti anche senza zeri, descrizione più corta.

Seconda revisione, corretta: nomi di 16 lettere presi per codici fiscali, note di credito di un fornitore scalate dal debito verso un altro, importi delle liste presi dal totale invece che dalle rate contate, mesi senza anno (ora il più vicino a oggi, anche a cavallo d'anno), troppi gruppi senza azienda (al più 5, gli altri contati), pause per letture interrotte dal limite della ricerca, memoria senza tetto. Copia `.bak` dopo ogni scrittura riuscita, giorni del weekend senza ripetizioni, «1 rata su 2», nomi in ordine naturale. Lo strumento è diviso in tre moduli (`invoice-tools.ts`, `invoice-render.ts`, `invoice-windows.ts`).
