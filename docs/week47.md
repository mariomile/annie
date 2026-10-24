# Settimana 47: fatture elettroniche

Branch `week-47`. Owni legge le fatture elettroniche dello SdI, XML o firmate `.p7m`, ovunque legge i documenti: le mandi in chat, le trova nel workspace o sul web, e ne fa un riepilogo in italiano che dice chi, quanto, quando e come pagare. Le scelte sono nell'[ADR 0052](adr/0052-fatture-elettroniche.md).

## Cosa cambia per chi usa Owni

- **«Leggimi questa fattura»** con un `.xml.p7m` su Telegram: «Fattura n. 2026/0153 del 15/10/2026 da Alfa Forniture S.r.l. a Beta Ristorazione Srl, totale 1.253,50 €, scadenza 30/11/2026», poi righe, IVA, IBAN.
- **Una nota di credito**: Owni dice che gli importi sono a favore del cliente, non da pagare.
- **La parcella di un avvocato a un Comune**: ritenuta d'acconto, cassa forense, split payment spiegati, e «Da pagare: 840,00 €».
- **Una scadenza che non torna con i giorni**: vale quella scritta in fattura, e Owni dice la differenza.
- **«Trova la fattura con questo IBAN»**: `file_search` cerca anche nei riepiloghi delle fatture.
- **Un PDF, un Word o un Excel firmati (.p7m)**: letti come il documento che contengono.

## Cosa funziona (verificato dai test)

`test/fattura-pa.test.ts`: fattura ordinaria, forfettario con bollo, professionista con ritenuta, cassa e split payment, nota di credito, lotto, semplificata, namespace con e senza prefisso, codifiche, buste DER, BER a pezzi, base64, PEM, doppia firma, file firmati non fattura, buste rovinate o costruite apposta (in tempi brevi sul thread principale), DOCTYPE ed entità rifiutati, file enormi, e il percorso vero: allegato su Telegram, `file_read`, `file_search`, `web_read` e `web_download`.

## Revisioni

Prima revisione, corretta: una busta `.p7m` costruita apposta bloccava il thread principale per secondi (ora si legge solo l'inizio e ogni byte una volta), caratteri di controllo e di direzione dai riferimenti numerici, segni del recinto nei documenti, importi passati per numeri a virgola mobile, date non valide. Il riepilogo ora apre con una riga che dice tutto, spiega nota di credito, split payment, reverse charge, ritenute e contributi, dice quale scadenza conta, mostra il dovuto, ordini, DDT, CIG e CUP, rate e codici di pagamento; legge la fattura semplificata e i documenti firmati che non sono fatture.

Seconda revisione, corretta: riconoscere un Word o un Excel firmati legge solo l'inizio della busta, file firmati grandi a pezzi piccoli si leggono, nomi dei file scaricati (`x.xml.p7m`), caratteri di direzione tolti anche se scritti nel testo, segni del recinto neutralizzati anche in tabelle e ricerche, testi firmati `.txt.p7m` e `.csv.p7m`, fatture oltre 20 MB lette come XML, scadenze «fine mese più giorni».
