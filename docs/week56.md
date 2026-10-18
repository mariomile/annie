# Settimana 56: tasse del forfettario

Branch `week-56`. Per chi è nel regime forfettario Annie stima imposta sostitutiva e contributi dagli incassi, dice quanto mettere da parte, quando scadono gli F24 e di quanto, e li mette nella previsione di cassa. Sempre come stima da verificare con il commercialista. Le scelte sono nell'[ADR 0070](adr/0070-tasse-del-forfettario.md).

## Cosa cambia per chi usa Annie

- **«Sono un consulente, ho aperto la partita IVA nel 2024, gestione separata»**: il profilo. Se l'attività è generica, Annie chiede il codice ATECO invece di indovinare il coefficiente.
- **«Quanto devo mettere da parte per le tasse?»**: ricavi incassati, reddito, contributi, imposta e la percentuale da accantonare di ogni incasso, con quanto hai già messo da parte.
- **«Quando scade il prossimo F24 e quanto?»**: saldo e acconti di giugno (con la proroga dei forfettari) e novembre, le rate fisse per artigiani e commercianti, spostati al giorno lavorativo.
- **«Se incasso altri 10.000 €?»**: quanto in più di tasse e quanto ti resta ogni 100 € incassati, e se passi una soglia del limite.
- **«Quest'anno guadagno meno, posso pagare meno acconti?»**: il confronto fra metodo storico e previsionale, acconto per acconto, con l'avviso sulle sanzioni.
- **«Mandami la stima per il commercialista»**: un CSV in `tasse/` con profilo, stima, calendario e incassi.
- **Nella previsione di cassa** gli F24 stimati ci sono già; se registri l'F24 pagato o una voce tua, conta quella.
- **Nel brief**: un F24 entro 10 giorni o una soglia del limite appena passata.

## Cosa funziona (verificato dai test)

`test/taxes.test.ts`: coefficienti per gruppo e codice ATECO e parole incerte, 5% e 15% negli anni, gestione separata con massimale, artigiani e commercianti con fasce e riduzioni, contributi dedotti per cassa, centesimi esatti, soglie e divisione degli acconti, giorni lavorativi e proroghe per anno con ferragosto, metodo previsionale e credito, limiti di 85.000 e 100.000 €, cassa con contributo integrativo, simulazioni, F24 nella previsione di cassa con voci e spese che li sostituiscono e parole che non devono farlo, F24 di giugno non pagato, brief che non scrive, canale agenti, recinto anche sugli errori, CSV con celle ostili, file rovinato, audit senza dati.

## Revisioni

Prima revisione, corretta: data in alternativa fissata al 31 luglio invece che a 30 giorni dopo, senza la proroga annuale dei forfettari e senza ferragosto; soglia dell'acconto unico pensata per la divisione 40/60; «consulente informatico» al 78% invece che al 67%; riduzione del 35% solo sulla parte oltre il minimale; anno dell'aliquota della gestione separata vecchio e massimale ignorato; contributi dedotti per competenza invece che per cassa; contributo integrativo delle casse contato nei ricavi; F24 pagato e registrato fra le spese contato due volte; voci dell'F24 sostituite solo entro il 30% della stima; F24 di giugno sparito il primo luglio; previsionale che ignorava il saldo e non diceva cosa cambiava; testo della persona fuori dal recinto negli errori; domande sbagliate a chi ha appena aperto; CSV povero per il commercialista; righe troppo lunghe; avviso del limite ripetuto ogni mattina.

Seconda revisione, corretta: un bollo da 16 €, una tassa automobilistica, un «acconto fornitore» o un contributo all'associazione che cancellavano un F24 da 3.000 € dalla previsione; F24 di giugno ancora atteso dopo aver detto gli acconti versati; riduzione del 50% per gli iscritti nel 2025 senza fine; valori INPS dell'anno congelati nel profilo; previsionale che non diceva «a novembre non verseresti niente» e non segnalava il credito; «a agosto»; colonna della fonte sbagliata nel CSV; avviso oltre 100.000 € che spariva dopo una settimana.

Terza revisione, corretta: un F24 che paga anche il bollo non riconosciuto e contato due volte, un solo F24 che pagava giugno e la rata fissa di agosto insieme che ne toglieva uno solo, riduzione del 50% rifiutata a chi ha la partita IVA da prima del 2025, «tasse universitarie» scambiate per un F24.
