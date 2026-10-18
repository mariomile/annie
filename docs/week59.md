# Settimana 59: liquidazione IVA

Branch `week-59`. Per chi è in regime ordinario Annie calcola l'IVA da versare ogni mese o trimestre dalle fatture emesse e ricevute, dice quando scade l'F24 e con che codice, stima l'acconto di dicembre e mette gli F24 dell'IVA nella previsione di cassa. Sempre come stima da verificare con il commercialista. Le scelte sono nell'[ADR 0076](adr/0076-liquidazione-iva.md).

## Cosa cambia per chi usa Annie

- **«Liquido l'IVA ogni trimestre»**: la periodicità, detta una volta.
- **«Quanta IVA devo versare questo mese?»**: IVA delle fatture emesse meno quella delle ricevute, il credito che passa, gli interessi del trimestrale, la scadenza e il codice tributo.
- **«Quando scade il prossimo F24 dell'IVA?»**: le prossime scadenze con l'importo stimato, spostate al giorno lavorativo.
- **«Quanto acconto IVA a dicembre?»**: metodo storico, analitico e previsionale, e quello che costa meno.
- **«Se compro a novembre invece che a ottobre?»**: in che liquidazione va la detrazione.
- **«L'auto la scarico al 40%»**, **«a inizio anno avevo 1.200 € di credito»**, **«l'F24 di settembre l'ho pagato»**: detraibilità, credito e pagamenti.
- **«Mandami il riepilogo IVA per il commercialista»**: un CSV in `iva/`.
- **Nella previsione di cassa e nel brief**: gli F24 dell'IVA in arrivo o scaduti da poco.

## Cosa funziona (verificato dai test)

`test/vat-settlement.test.ts`: mensile e trimestrale con interessi, anche sul 4º trimestre, saldi fino a 25,82 € portati avanti, credito detto e confermato, scadenze del 16, del 20 agosto e del 16 marzo spostate ai giorni lavorativi, acconto storico, analitico e previsionale con il minimo di 103,29 €, acconti non segnati pagati, fatture emesse con Annie e in XML contate una volta, note di credito emesse e ricevute, scissione dei pagamenti, inversione contabile, IVA per cassa, data di ricezione, detraibilità parziale, forfettario rifiutato, ipotesi anche su periodi futuri, F24 scaduti e pagati in ritardo, previsione di cassa con voci e spese e nomi da prezzo, brief che non scrive, canale agenti, CSV con celle ostili, file rovinato, audit senza dati. Restano verdi i test di tasse, previsione di cassa, spese e rinnovi, che ora usano i moduli condivisi `money-input.ts` e gli arrotondamenti di `quote-sums.ts`.

## Revisioni

Prima revisione, corretta: acconto non pagato dato per versato e sparito dalla previsione di cassa; F24 scaduti non pagati tolti dalla previsione; «Saldo lavori + IVA» o «Ordine 6010» presi per un F24 dell'IVA; F24 di IRPEF e INPS tolti dalla spesa media dell'ordinario; niente interessi sul 4º trimestre; credito di fine anno non portato a gennaio; righe IVA senza limite; ipotesi vuote sui periodi futuri; titolo dell'acconto in contraddizione con le righe; `taxes` e la previsione di cassa che dicevano ancora che l'IVA non la stimava nessuno; F24 scaduti assenti dal brief; nome dello strumento confuso con il controllo della partita IVA; «a credito» con due significati nella stessa risposta; avvisi di stima ripetuti in ogni messaggio; calendario troppo lungo.

Seconda revisione, corretta: un F24 pagato in ritardo contato due volte; il credito calcolato da fatture vecchie o incomplete portato avanti di anno in anno, che azzerava l'IVA da versare; l'acconto di un anno senza dati che ricompariva ogni mattina nel brief; nomi come «IVA 10/2026» o «Saldo IVA 2025 + interessi» non riconosciuti come F24; il prossimo F24 nascosto dal calendario; la riga delle impostazioni che diceva il contrario degli interessi.

Terza revisione, corretta: l'F24 del mese pagato in anticipo che chiudeva quello scaduto del mese prima; pagamenti ai fornitori come «Acconto cucina 10% IVA» presi per l'F24 dell'IVA; l'acconto di dicembre non pagato nascosto a chi comincia a gennaio.
