# Settimana 57: clienti

Branch `week-57`. Una scheda per ogni cliente con quello che dice la persona (referenti, telefono, canale preferito, note) e tutto quello che Annie sa già dai registri (fatturato, incassato, solleciti, preventivi, ore), più i ricontatti con il loro promemoria. Le scelte sono nell'[ADR 0071](adr/0071-clienti.md).

## Cosa cambia per chi usa Annie

- **«Cosa so di Rossi?»**: referenti, ultime note, ricontatti, fatturato e incassato dell'anno, fatture aperte, solleciti, preventivi e ore da fatturare.
- **«Rossi: il referente è Marco, 333…, preferisce WhatsApp»**, **«aggiungi una nota a Rossi»**: la scheda si riempie parlando.
- **«Chi sono i miei clienti migliori?»**, **«chi mi paga di più?»**: la classifica con la quota di ognuno, e l'avviso se uno solo pesa più del 40%.
- **«Chi non sento da tre mesi?»**: i clienti fermi, con quanto hanno fatturato negli ultimi due anni.
- **«Ricordami di ricontattare Beta tra due settimane»**: il ricontatto e un promemoria alle 9 di quel giorno; **«spostalo a lunedì»**, **«non serve più»**, **«ho sentito Beta»**.
- **«Chi devo richiamare questa settimana?»**: l'agenda dei ricontatti.
- **«Rossi e Rossi Mario sono lo stesso cliente»**: Annie mostra cosa unisce e lo fa dopo il sì.
- **«Fammi il file dei clienti»**: un CSV in `clienti/`.
- **Nel brief**: i ricontatti in ritardo e un cliente che è appena diventato troppo importante.

## Cosa funziona (verificato dai test)

`test/clients.test.ts`: schede con partita IVA, codice fiscale, referenti, canali e note, nomi uguali a meno della forma societaria e nomi solo simili, clienti visti solo nei registri, fatturato come imponibile e incassato con IVA e note di credito, classifica per periodo e concentrazione, dormienti, ricontatti con promemoria, spostati, tolti e fatti, chiamate ripetute e riavvii a metà senza promemoria orfani, giorni lavorativi e feste, unione con conferma, canale agenti ridotto a numeri, brief che non scrive, CSV con celle ostili, file rovinato, audit senza dati.

## Revisioni

Prima revisione, corretta: agenti che vedevano referenti, note e ricontatti; promemoria dei ricontatti che consumavano il limite delle attività della persona e restavano su disco dopo essere partiti; promemoria creati senza una persona a cui mandarli, nei gruppi; promemoria rimasti orfani o tolti a un altro ricontatto; file esportati con i dati di una scheda tolta non ricordati; scaduto più alto del da incassare, senza le note di credito aperte; fatturato con l'IVA invece dell'imponibile; «Rossi» dei preventivi e «Rossi S.r.l.» delle fatture contati come due clienti; errori invece di «intendi …?»; unione di due codici fiscali diversi e anteprima povera; «oggi c'è da ricontattare» per un ricontatto futuro; nessun modo di spostare o togliere un ricontatto.

Seconda revisione, corretta: fatture chiuse con una nota di credito contate come incassate e «tutto incassato» nel titolo; ricontatti e date visibili agli agenti dalla lista; un promemoria di un altro ricontatto dopo un riavvio; promemoria orfani dopo un errore nello spostare, togliere o segnare fatto; «Rossi» preso per «Mario Rossi» senza chiedere; una scheda legata alla prima di due aziende con lo stesso nome; «Acme» e «Acme Srl» trattati diversamente da un'operazione all'altra; una data di festa spostata senza dirlo; il brief di un'altra persona preso per il proprio; parole e unità ripetute nelle risposte.

Terza revisione, corretta: un promemoria rimasto per il ricontatto di un altro cliente dopo un riavvio a metà; «togli Rossi» che toglieva «Rossi Srl» senza chiedere; due persone con lo stesso nome e codici fiscali diversi contate come un cliente solo; «dopo le feste» detto il 7 gennaio preso per l'anno dopo.
