# Settimana 54: rinnovi e abbonamenti

Branch `week-54`. Annie tiene il conto di assicurazioni, domini, software, affitti, utenze e contratti che si rinnovano, avvisa prima della scadenza e della data entro cui disdire, e dice quanto costano all'anno e al mese. Le scelte sono nell'[ADR 0059](adr/0059-rinnovi-e-abbonamenti.md).

## Cosa cambia per chi usa Annie

- **«Ricordami che l'assicurazione dell'auto scade il 12 marzo, 480 euro l'anno»**: Annie la registra e avvisa un mese prima.
- **«Canva 12 euro al mese con la carta»**: si paga da solo, quindi Annie non lo segnala mai come scaduto.
- **«Il contratto della fibra si rinnova da solo, disdetta 30 giorni prima»**, **«disdetta 3 mesi prima»**: la data entro cui disdire, al momento giusto.
- **«Cosa scade nei prossimi 60 giorni?»**: da disdire, da pagare, che si rinnova da solo, con il totale di tutti gli addebiti.
- **«Quanto spendo di abbonamenti al mese?»**: per categoria, all'anno e al mese.
- **«Ho pagato l'assicurazione, mettila nelle spese»**: la scadenza va all'anno dopo e la spesa finisce nel registro, una volta sola.
- **«Ho disdetto Netflix»**: resta nella storia come disdetto.
- **Nel brief**: solo ciò che scade o va disdetto a breve.

## Cosa funziona (verificato dai test)

`test/renewals.test.ts`: frequenze, date senza anno anche per mensili e semestrali, fine mese e giorno del mese, giorno di partenza mantenuto per anni anche con il 29 febbraio, scadenze calcolate alla lettura per addebiti automatici e rinnovi taciti, «da pagare» e «scaduto» solo quando servono, disdette in giorni, mesi e a fine durata, niente allarmi mensili per i preavvisi, doppio pagamento rifiutato, spesa registrata una volta sola anche ripetendo, prova gratuita, aumenti di prezzo, IVA, valute estere, nomi detti con articoli, riepilogo per categoria, addebiti multipli nel periodo, CSV, canale agenti e brief, audit senza dati anche sulle richieste ripetute.

## Revisioni

Prima revisione, corretta: abbonamenti pagati con la carta segnalati come scaduti ogni mese, rinnovi taciti mostrati come scaduti, mensili e semestrali con la data senza anno spostati di un anno, «fine mese», «il 15» e «primo gennaio» rifiutati, nomi come «l'assicurazione dell'auto» non trovati, due «ho pagato» che spostavano la scadenza due volte, spesa che poteva fallire dopo lo spostamento, audit perso sulle richieste ripetute, preavvisi dei mensili come allarme ogni mese, riepilogo che ignorava la categoria e senza costo mensile, addebiti di un mensile contati una volta in 60 giorni, «+ IVA», preavviso in mesi, durata del contratto diversa dal pagamento, prove gratuite, aumenti, valute estere, righe troppo lunghe per la chat, controlli copiati dalle spese.

Seconda revisione, corretta: un aumento di prezzo applicato al pagamento prima di quello giusto e riepiloghi diversi prima e dopo una modifica, il suggerimento per registrare la spesa che spostava la scadenza una seconda volta, «l'assicurazione della casa» che trovava l'affitto, un rinnovo riattivato che contava addebiti del periodo disdetto, nuovo prezzo «+ IVA» rifiutato, fine durata che perdeva il giorno, aliquota IVA persa cambiando importo, addebito automatico attivato che contava periodi non pagati, colonna della scadenza nel CSV per le voci da pagare.
