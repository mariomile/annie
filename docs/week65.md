# Settimana 65: schede dei fornitori

Branch `week-65`. Quello che la settimana 57 ha fatto per i clienti, ora per i fornitori: quanto si spende con ognuno, cosa resta da pagare, in quanti giorni si paga, gli abbonamenti, i referenti e le note. E un controllo sugli IBAN contro le truffe sui pagamenti. Le scelte sono nell'[ADR 0085](adr/0085-schede-dei-fornitori.md).

## Cosa cambia per chi usa Annie

- **«Quanto ho speso con Aruba quest'anno?»**: fatture pagate e spese insieme, contate una volta.
- **«Chi sono i miei fornitori principali?»**: la classifica per spesa nel periodo.
- **«Cosa devo ancora pagare a Fornitore Uno?»**, **«Che IBAN ha?»**: le fatture aperte, la prossima scadenza e l'IBAN, con un avviso se è diverso da quelli già pagati.
- **«A quanti giorni pago di solito Rossi Srl?»**, **«Pago in ritardo qualcuno?»**: i giorni medi e i pagamenti dopo la scadenza.
- **«Quali abbonamenti ho con Adobe?»**: i rinnovi del fornitore.
- **«Segnati che il referente di Fornitore Uno è Laura»**, **«Aggiungi una nota: sconto 5% sopra i 1.000 €»**: nella scheda, solo come lo dici tu.
- **Nel brief**: un avviso quando un fornitore da pagare entro 7 giorni ha un IBAN diverso da quello che conosci, o lo stesso nome di un altro fornitore con un'altra partita IVA.

## Cosa funziona (verificato dai test)

`test/suppliers.test.ts`: spesa da fatture, spese e rinnovi contata una volta con i possibili doppioni detti, partita IVA e codice fiscale prima del nome, nomi simili che si chiedono, unione con anteprima e rifiuti, partite IVA dettate già di altri, IBAN di fatture retrodatate, senza data e di seconde rate, IBAN mai pagati, più IBAN pagati, IBAN dettato sbagliato o cambiato di banca, fornitore con lo stesso nome e un'altra partita IVA anche con tre fatture, schede nate da note e unioni che non confermano un fornitore, giorni di pagamento e ritardi con i festivi, note e referenti, export con celle ostili, canale agenti senza nomi, brief, file rovinato, ripetizioni, audit senza dati. Restano verdi i test dei clienti, con il nuovo rifiuto del codice fiscale già usato.

## Revisioni

Prima revisione, corretta: una partita IVA dettata che spostava le spese di un fornitore sotto un altro; il controllo dell'IBAN che guardava solo le due fatture più recenti e la prima rata; un fornitore con lo stesso nome e un altro IBAN che non dava nessun avviso; un nome simile che mostrava l'IBAN senza chiedere; doppioni detti «una volta sola»; strumenti di fatture, spese e fornitori che si sovrapponevano; avvisi poco chiari; codice copiato dai clienti.

Seconda revisione, corretta: un falso fornitore con tre fatture che passava senza avviso; due fatture false che diventavano il riferimento; l'export che mostrava come pagato un IBAN mai pagato; più IBAN già pagati non detti; il brief con frasi ripetute e nomi mancanti.

Terza revisione e verifiche finali, corrette: una spesa con solo il nome o una scheda nata da una nota che confermavano il falso fornitore; note e referenti finiti sulla scheda del fornitore vero o su una scheda di nessuno; un'unione che confermava il falso fornitore; l'avviso «forse è sbagliato quello che mi hai dato» dopo un cambio di banca vero; il riferimento «più usato», tolto. L'ultima verifica non ha trovato altro da correggere.
