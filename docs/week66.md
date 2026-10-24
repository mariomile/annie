# Settimana 66: budget e obiettivi

Branch `week-66`. La persona fissa limiti di spesa e obiettivi di incasso, e Owni li segue dai registri che ci sono già, con una stima a fine periodo e un avviso nel brief quando un limite si avvicina o un obiettivo resta indietro. Le scelte sono nell'[ADR 0086](adr/0086-budget-e-obiettivi.md).

## Cosa cambia per chi usa Owni

- **«Metti un budget di 300 € al mese per il software»**: salvato, anche su un fornitore o su tutte le spese.
- **«Quanto ho speso per il software questo mese rispetto al budget?»**: speso, percentuale, cosa resta e la stima a fine mese.
- **«Come vado con l'obiettivo di 60.000 € di fatturato quest'anno?»**, **«Sono in linea per arrivarci?»**: fatturato finora, stima a fine anno e quanto serve al mese.
- **«Quali budget sto sforando?»**: superati, raggiunti e oltre l'80%.
- **«Togli il budget viaggi»**: tolto, o la domanda se ce ne sono due.
- **Nel brief**: una riga quando un budget passa l'80% o il 100%, o un obiettivo è indietro, una volta per periodo.

## Cosa funziona (verificato dai test)

`test/budgets.test.ts`: budget su categoria, fornitore e tutte le spese, obiettivi su fatturato e incassato, categoria che non esiste, fornitore ambiguo, stesso budget rimesso uguale o cambiato con l'inizio tenuto, budget per nome che passa alla partita IVA, cifre uguali all'andamento dell'attività e alle schede dei fornitori anche con l'estratto conto, doppioni e note di credito, stima all'inizio, a metà e alla fine, periodi mensili, trimestrali e annuali con il fuso di Roma, percentuali vicino al 100%, avvisi detti una volta per soglia e per periodo, canale agenti senza nomi, export con celle ostili, file rovinato, ripetizioni, audit senza dati. Restano verdi i test di andamento dell'attività, spese, fornitori e clienti.

## Revisioni

Prima revisione, corretta: nomi e partite IVA dei fornitori che arrivavano a un altro agente; il budget di un fornitore che non contava i pagamenti confermati dall'estratto conto; avvisi ridetti dopo aver rimesso lo stesso budget; l'inizio perso cambiando l'importo; due budget sullo stesso fornitore; stime e brief con catene di due punti; codice preso da un altro strumento invece che da un modulo comune.

Seconda revisione, corretta: un altro agente che poteva indovinare quali fornitori hanno un budget; percentuali arrotondate a 100% sia sopra sia sotto il limite; la nota sulle stime che parlava di spese anche per gli incassi; frasi ripetute nella stessa risposta; il nome di una fattura scelto in base all'ora del file.

Verifica finale: niente da correggere.
