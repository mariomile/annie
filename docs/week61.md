# Settimana 61: andamento dell'attività

Branch `week-61`. Annie mette insieme i numeri che ha già (fatture, incassi, spese, ore, preventivi, tasse) e dice come sta andando l'attività: quanto è entrato, quanto è uscito, il margine, quanto resta dopo le tasse stimate, e come cambia rispetto al mese o all'anno prima. Legge soltanto. Le scelte sono nell'[ADR 0080](adr/0080-andamento-dell-attivita.md).

## Cosa cambia per chi usa Annie

- **«Come sta andando l'attività?»**: il mese fin qui e l'anno fin qui, con fatturato, incassato, spese, margine, tasse da accantonare e quanto resta, ore e preventivi, e cosa c'è ancora da incassare.
- **«Ottobre rispetto a settembre?»**, **«rispetto all'anno scorso?»**: le tre differenze più grandi, poi le altre.
- **«Com'è andato l'anno mese per mese?»**: una riga al mese.
- **«Dove spendo di più?»**: le categorie, e quanto pesano i clienti principali.
- **«Mandami il report del mese per il commercialista»**: un CSV in `report/` del mese chiuso.
- **Nel brief del primo giorno feriale del mese**: come si è chiuso il mese prima.

## Cosa funziona (verificato dai test)

`test/business-report.test.ts`: periodi detti a parole e date, fuso di Roma, mesi in corso confrontati con gli stessi giorni, anno bisestile, registri vuoti e rovinati, fatture contate una volta con note di credito, incassi nel giorno della banca, spese e fatture dei fornitori senza doppioni con rate e più fornitori, rinnovi solo attraverso le spese, stima del forfettario portata a fine anno con contributi fissi, ordinario dopo l'IVA, percentuali da zero e da negativo, trend con mesi vuoti e limiti, concentrazione dei clienti, euro all'ora solo da 10 ore, brief solo il primo giorno feriale e senza scrivere, canale agenti, CSV con celle ostili, audit senza dati. Restano verdi i test della previsione di cassa e dell'estratto conto, che usano gli stessi abbinamenti fra spese e fatture pagate.

## Revisioni

Prima revisione, corretta: le tasse del forfettario calcolate sugli incassi dell'anno finora, che a gennaio con i contributi fissi superavano gli incassi; una spesa sola che faceva sparire più fatture di fornitori dello stesso importo; «ti resta in tasca» per l'ordinario senza IRPEF e contributi; «chi mi paga di più» affidato a due strumenti; percentuali come +1209% partendo da un margine negativo; tre differenze che dicevano la stessa cosa; trend pieno di zeri senza etichette; avviso di dipendenza con due clienti alla pari; report per il commercialista del mese ancora in corso; euro all'ora con un'ora sola; un controllo che rifaceva una funzione già condivisa.

Seconda revisione, corretta: una spesa per l'intera fattura di un fornitore pagata in due rate che copriva solo la prima, e la seconda contata due volte anche nella previsione di cassa; uno scontrino «TIM» e la fattura di Telecom Italia dello stesso importo contati due volte senza dirlo (ora contati tutti e due e segnalati come «forse è lo stesso pagamento»); qualche frase da sistemare nei confronti.

Terza revisione, corretta: una spesa che copriva una rata a settembre e di nuovo l'altra a ottobre, così i mesi non tornavano con il totale e la previsione di cassa contava 500 € in più; un acconto da 300 € registrato fra le spese che copriva una rata da 500 € (ora contati tutti e due e chiesto come «forse un acconto»).
