# Settimana 75: turni, ferie e permessi del personale

Branch `week-75`. Annie tiene il personale di una piccola attività: chi lavora quando, ferie, permessi, malattie e altre assenze, quanto resta di ferie e permessi (una stima), i turni della settimana con le ore scoperte, il riepilogo del mese per la consulente del lavoro. Le assenze di chi è anche una risorsa degli appuntamenti bloccano quella risorsa. Le scelte sono nell'[ADR 0095](adr/0095-turni-ferie-e-permessi.md).

## Cosa cambia per chi usa Annie

- **«Giulia è in ferie dal 3 al 14 agosto»**: salvato, con i giorni di ferie contati (non i giorni di riposo né le feste nazionali) e quanto le resta, come stima.
- **«Marco domani ha un permesso dalle 15»**: fino a fine turno, con le ore; se Marco ha appuntamenti in quell'orario, li elenca e offre di spostarli, e non se ne fissano altri.
- **«Marco è in malattia da oggi»**: aperta finché non dici la fine; solo il numero di protocollo del certificato, mai la diagnosi.
- **«Chi lavora sabato?»**, **«fammi i turni della prossima settimana»**: dalla settimana solita, meno assenze e chiusure, con le ore in cui non c'è nessuno; il file in `personale/`.
- **«Quante ferie le restano a Giulia?»**: l'anno meno le fatte e le programmate; la consulente ha il dato ufficiale.
- **«Mandami il riepilogo ore di ottobre per la consulente del lavoro»**: CSV e PDF in `personale/`, poi la mail solo dopo la tua approvazione.
- **«Sabato Giulia fa 9-13»**, **«Marco ieri ha fatto 2 ore in più»**, **«sposta le ferie di Giulia»**, **«annulla il permesso di Marco»**: solo con la tua parola.
- **Nel brief**: chi manca oggi e domani, le assenze della settimana, le ore scoperte di domani.

## Cosa funziona (verificato dai test)

`test/staff-shifts.test.ts`: la giornata dalla settimana solita, tagliata da mezza giornata e permesso; chiuso nei festivi e nelle chiusure; ore scoperte; risorse bloccate; ferie in giorni di lavoro senza riposi e festivi; permesso «dalle 15» fino a fine turno; sovrapposizioni per giorni e per ore; saldi dell'anno, mese per mese e dal saldo detto; il mese con giorni, ore, ferie, permessi, malattia in giorni di calendario e ore in più.

`test/staff.test.ts`: ferie salvate con il conto dei giorni e la stima, nomi solo nel recinto, audit con operazione e conteggio; sovrapposizione rifiutata, solo la parola della persona, altri agenti solo conteggi; permesso, mezza giornata, «altro» con il motivo; malattia aperta, diagnosi mai salvata (nemmeno al posto del protocollo), protocollo salvato; cambio e annullamento nello storico; chi lavora sabato e la settimana con i buchi; turno a parte e ore in più; saldo come stima e saldo detto; riepilogo del mese in `personale/`, CSV protetto, mai mandato; risorsa bloccata negli appuntamenti senza «fissalo lo stesso» e appuntamenti elencati; brief una volta al giorno; file illeggibile; persona nuova, risorsa di una persona sola, nomi di battesimo; istradamento.
