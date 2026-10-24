# Settimana 75: turni, ferie e permessi del personale

Branch `week-75`. Owni tiene il personale di una piccola attività: chi lavora quando, ferie, permessi, malattie e altre assenze, quanto resta di ferie e permessi (una stima), i turni della settimana con le ore scoperte, il riepilogo del mese per la consulente del lavoro. Le assenze di chi è anche una risorsa degli appuntamenti bloccano quella risorsa. Le scelte sono nell'[ADR 0095](adr/0095-turni-ferie-e-permessi.md).

## Cosa cambia per chi usa Owni

- **«Giulia è in ferie dal 3 al 14 agosto»**: salvato, con i giorni di ferie contati (non i giorni di riposo né le feste nazionali) e quanto le resta, come stima.
- **«Marco domani ha un permesso dalle 15»**: fino a fine turno, con le ore; se Marco ha appuntamenti in quell'orario, li elenca e offre di spostarli, e non se ne fissano altri.
- **«Marco è in malattia da oggi»**: aperta finché non dici la fine; solo il numero di protocollo del certificato, mai la diagnosi.
- **«Chi lavora sabato?»**, **«fammi i turni della prossima settimana»**: dalla settimana solita, meno assenze e chiusure, con le ore in cui non c'è nessuno; il file in `personale/`.
- **«Quante ferie le restano a Giulia?»**: l'anno meno le fatte e le programmate; la consulente ha il dato ufficiale.
- **«Mandami il riepilogo ore di ottobre per la consulente del lavoro»**: CSV e PDF in `personale/`, poi la mail solo dopo la tua approvazione.
- **«Sabato Giulia fa 9-13»**, **«Marco ieri ha fatto 2 ore in più»**, **«sposta le ferie di Giulia»**, **«annulla il permesso di Marco»**: solo con la tua parola.
- **Nel brief**: chi manca oggi e domani, le assenze della settimana, le ore scoperte di domani.

## Dopo la revisione

- Le date si leggono nel verso giusto: «Marco è in malattia dal 12 ottobre», detto il 19, è il 12 passato, come le ore in più e il saldo «al 12 ottobre»; per le ferie il giorno più vicino, e se è davvero in dubbio (il 15 aprile, detto a ottobre) chiede l'anno. Capisce «lunedì scorso» e «la settimana scorsa», e quando legge un anno che non è questo lo dice.
- Il riepilogo per la consulente è giorno per giorno: orario previsto, ore, assenza con il codice (FE, PE, MA, 104…), ore in più segnate di domenica o festivo; poi le malattie con il protocollo, le altre assenze per tipo, chi è entrato o uscito nel mese, i totali. Dice che le presenze sono i turni previsti, non timbrature, che il mese in corso arriva fino a oggi, e che il file è solo per la consulente.
- **«Assumo Luca da lunedì, 20 ore, mattina»**: lo segna da lunedì 26 e chiede in una volta sola il cognome e l'orario di «mattina». Chi entra o esce durante l'anno ha ferie e permessi per i mesi in forza (stima). **«Luca non lavora più da noi da venerdì»** lo archivia; cancellare una persona chiede prima il sì, e non si fa finché è una risorsa degli appuntamenti.
- Se qualcuno si ammala durante le ferie, propone di accorciarle e di segnare la malattia; i giorni non goduti tornano nel saldo.
- Il motivo delle altre assenze è da una lista (lutto, congedo parentale, congedo malattia figlio, matrimoniale, L.104 anche a ore, donazione sangue, studio, sindacale, non retribuito): «malattia del figlio» è il congedo. Il ruolo è un mestiere corto. Un ruolo o una nota che sembrano dati sanitari non si salvano, e lo dice; il protocollo è di sole cifre.
- Il file dei turni e il brief dicono solo «assente»; il brief chiede una volta sola, per una malattia aperta da qualche giorno, fino a quando e il protocollo. Non dice mai «0 assenti».
- Le ferie si contano su 5 giorni (lun-ven) se non dici che il contratto conta anche il sabato, e la risposta dice quali festivi e chiusure non contano.
- Il saldo dice «permessi (ROL ed ex festività insieme)».
- Negli appuntamenti: «domani dalle 15 la risorsa non c'è: con questa risorsa non ho fissato niente», propone prima un'altra risorsa alla stessa ora, e non dice mai perché. Anche il giorno di riposo e le ore fuori turno di chi ha la settimana solita bloccano la sua risorsa.

## Dopo la verifica di chiusura

- Un ruolo, o la nota di un turno o delle ore in più, che sembra un dato sanitario non si salva, e lo dice; il controllo è sulle parole dette, non sul file, e i mestieri come farmacista o fisioterapista vanno bene. Le note delle assenze non ci sono più: basta il tipo, e per le altre assenze il motivo dalla lista. Le note restano corte.
- Il brief chiede «è assente da giovedì 15 ottobre, fine non detta: sai fino a quando?», senza dire malattia; il protocollo lo chiede Owni quando rispondi, nella tua chat.
- Dire solo un nome non aggiunge nessuno: Owni cerca la persona, e la aggiunge quando dici che è nuova o dici qualcosa di lei. Se il nome va bene per più persone, chiede quale.
- «Assumo Luca da lunedì» è il lunedì che viene; «dal 3 novembre» il più vicino, e dice l'anno quando non è questo.
- Ferie o un permesso detti senza l'anno e già passati da più di una settimana: «Il 2-5 giugno è già passato: le segno come ferie già fatte, o intendi giugno 2027?». Per la malattia, un inizio di più di 60 giorni fa chiede l'anno.
- «Luca non lavora più da venerdì»: l'ultimo giorno è giovedì.
- Cancellare una persona dice che i file in personale/ la tengono ancora, e il controllo cambia se un'assenza è stata cambiata o annullata nel frattempo.
- Una malattia su ferie e permesso dice quale assenza blocca. Il mese conta solo i giorni in forza. Negli appuntamenti, il file del personale illeggibile si dice una volta al giorno.

## Cosa funziona (verificato dai test)

`test/staff-shifts.test.ts`: la giornata dalla settimana solita, tagliata da mezza giornata e permesso; chiuso nei festivi e nelle chiusure; ore scoperte; risorse bloccate; ferie in giorni di lavoro senza riposi e festivi; permesso «dalle 15» fino a fine turno; sovrapposizioni per giorni e per ore; saldi dell'anno, mese per mese e dal saldo detto; il mese con giorni, ore, ferie, permessi, malattia in giorni di calendario e ore in più.

`test/staff.test.ts`: ferie salvate con il conto dei giorni e la stima, nomi solo nel recinto, audit con operazione e conteggio; sovrapposizione rifiutata, solo la parola della persona, altri agenti solo conteggi; permesso, mezza giornata, «altro» con il motivo; malattia aperta, diagnosi mai salvata (nemmeno al posto del protocollo), protocollo salvato; cambio e annullamento nello storico; chi lavora sabato e la settimana con i buchi; turno a parte e ore in più; saldo come stima e saldo detto; riepilogo del mese in `personale/`, CSV protetto, mai mandato; risorsa bloccata negli appuntamenti senza «fissalo lo stesso» e appuntamenti elencati; brief una volta al giorno; file illeggibile; persona nuova, risorsa di una persona sola, nomi di battesimo; istradamento.

`test/staff-review.test.ts` (revisione): «12 ottobre» nei tre versi, «lunedì scorso», «la settimana scorsa», l'anno detto, la domanda quando è in dubbio, la fine di un'assenza nell'anno dopo; il mese giorno per giorno con i codici, la domenica, le malattie con il protocollo, la L.104 a ore, i totali, il mese in corso fino a oggi, chi entra a metà mese; l'assunzione con il nome di battesimo e la domanda unica, cognome e orario dopo, i mesi in forza; un nome simile e new; archiviare e la risorsa bloccata; cancellare con il controllo, il controllo vecchio rifiutato, la risorsa da togliere prima, l'audit con il solo conteggio; malattia nelle ferie accorciate o annullate, il controllo, il saldo; i motivi dalla lista, i motivi sanitari e liberi rifiutati; ruolo e note sanitarie non salvate; il protocollo di sole cifre; la nota sanitaria solo quando serve; turni e brief senza il perché, il riepilogo con MA; la domanda del brief una volta sola; la settimana delle ferie a 5 o 6 giorni, chiusure e festivi detti; la risorsa che non c'è senza il perché, un'altra risorsa alla stessa ora, il riposo e la pausa del turno; ROL ed ex festività; mai «0 assenti»; il cambio sotto il blocco, la domanda con più assenze, la mezza giornata che va via con il tipo, le ore in più a Ferragosto; il file illeggibile detto quando si fissa. Verifica di chiusura: le radici sanitarie dentro le parole, i mestieri nel ruolo, le note corte, nessuna nota sulle assenze, il file vecchio ancora leggibile, «maternità» e «104» nei motivi; il protocollo chiesto nella chat quando si dice la fine; un nome da solo non aggiunge nessuno, più persone per un nome; il primo giorno di chi è assunto; ferie e permessi già passati chiesti, e con il sì segnati; l'inizio di una malattia di più di 60 giorni fa chiesto; l'uscita «da venerdì»; il controllo della cancellazione legato alle assenze; la malattia su ferie e permesso; i totali del mese nei giorni in forza; il personale illeggibile una volta al giorno.
