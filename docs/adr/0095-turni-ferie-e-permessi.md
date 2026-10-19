# Turni, ferie e permessi del personale

Una piccola attività con due o tre dipendenti tiene i turni e le assenze su un foglio o a memoria: «Giulia è in ferie dal 3 al 14 agosto», «Marco domani ha un permesso dalle 15», «chi lavora sabato?», «quante ferie le restano a Giulia?», e a fine mese il riepilogo per la consulente del lavoro. Annie aveva gli appuntamenti con le loro risorse, ma nessuno sapeva che la risorsa «Marco» domani pomeriggio non c'è.

## Decisione

- **Strumento `staff`**, distinto da `appointments` (i clienti e la loro agenda), dal board (gli agenti) e dalle persone di Annie (chi usa Annie e i suoi permessi): `person`, `absence`, `change`, `cancel`, `extra`, `shift`, `who`, `shifts`, `balance`, `absences`, `summary`, `export`, `settings`. Il personale (PE-0001) e le assenze (AS-0001), mai detti alla persona, stanno in `staff.json` dell'istanza, con la copia `.bak`. Le persone del personale non sono utenti di Annie e non toccano il sistema dei permessi.
- **Persona**: nome, ruolo, ore settimanali del contratto, la settimana di lavoro solita (letta come gli orari degli appuntamenti, «lun-ven 9-13 e 14-18; sab 9-13»), ferie dell'anno in giorni e permessi (ROL) in ore, il saldo detto dal titolare a una data, e facoltativamente la risorsa degli appuntamenti che è lei (una risorsa a una persona sola). Il nome si dice intero o con il solo nome di battesimo quando è di una persona sola; un nome solo simile chiede «Intendi questa persona?» e non scrive niente.
- **Assenze**: ferie (giorni o mezza giornata, mattina o pomeriggio, divisa alle 13), permesso (ore, «dalle 15»: senza fine va fino alla fine del turno), malattia (giorni; aperta «da oggi» senza fine; solo il numero di protocollo INPS, facoltativo), altro (lutto, congedo, 104, con il motivo nel recinto). Aggiungere, cambiare e annullare solo con la parola della persona; annullata resta nello storico. Una sovrapposizione con un'altra assenza della stessa persona è rifiutata, e si dice quale.
- **Saldi**: l'anno meno le assenze già fatte e quelle in programma. Di default «saldo annuo, senza maturazione mensile»; la maturazione mese per mese (un dodicesimo al mese, arrotondato al centesimo) è un'impostazione. Il saldo detto dal titolare vale da quella data al posto dell'anno intero; niente residui degli anni prima se non detti. Sempre «stima: la consulente del lavoro ha il dato ufficiale».
- **Giorni di ferie**: i giorni di lavoro solito della persona (lun-ven se la settimana non è detta), senza le feste nazionali (`italian-calendar.ts`); la malattia in giorni di calendario, come li conta l'INPS. Giorni in centesimi, ore in minuti: mai numeri con la virgola mobile.
- **Turni**: la settimana viene dalla settimana solita meno le assenze e le chiusure (orari, chiusure e festivi dalle impostazioni degli appuntamenti; senza, le feste nazionali). Un turno del giorno detto a parte («sabato Giulia fa 9-13», «riposo») vale anche sopra una chiusura. «Chi lavora sabato?», la settimana con le ore in cui l'attività è aperta e nessuno c'è (scoperto, da 15 minuti in su, solo quando gli orari sono noti). Export PDF (default), Word o CSV in `personale/`, mai mandato.
- **Appuntamenti**: un'assenza di una persona legata a una risorsa blocca quella risorsa in `book`, `move` e `free_slots` (`FitInput.blocked`), con il motivo «la risorsa in quell'orario è assente». Un'assenza non si scavalca: niente `force`. Una nuova assenza che cade su appuntamenti già fissati li elenca e offre di spostarli; non li sposta da sola.
- **Riepilogo del mese per la consulente**: per persona giorni e ore lavorati (turni meno assenze), ferie e permessi usati, giorni di malattia, altre assenze, ore in più dette dal titolare (`extra`). CSV con le celle protette dalle formule e i decimali con la virgola, più PDF o Word, in `personale/riepilogo-AAAA-MM`. Mai mandato: si offre `google_mail_send` con il file, che chiede la sua approvazione.
- **Brief**: una volta al giorno (reclamata), chi è assente oggi e domani, le assenze che cominciano questa settimana, le ore scoperte di domani.

## Sicurezza

- **Dati di salute**: della malattia solo il tipo, i giorni e, se detto, il protocollo (un codice con almeno tre cifre). Una diagnosi detta come motivo, nelle note o al posto del protocollo non si salva mai, e si dice «La diagnosi non la salvo: basta il numero di protocollo del certificato.».
- **Solo la persona**: ogni scrittura passa da `requirePersonFor`; con `isAgentTurn` un altro agente riceve solo i conteggi («oggi un assente, domani 2 assenti»), né chi né perché.
- Nomi, ruoli, motivi e protocolli stanno nel recinto dei «dati del personale». L'audit registra operazione e conteggio.
- **File illeggibile**: un `staff.json` rovinato non viene mai sovrascritto; ogni operazione lo dice, il brief ha una riga sola, e gli appuntamenti non vedono assenze finché non è sistemato.
- **Un'interruzione**: ogni scrittura è legata alla chiamata, e ripetuta non scrive due volte.

## Scelte aperte

- Nessuna operazione per togliere una persona del personale: si tiene lo storico.
- I buchi liberi dell'agenda degli appuntamenti non tolgono le assenze, e le proposte di orario guardano solo le assenze, non i turni: chi ha la risorsa lavora quando l'attività è aperta, salvo assenze.
- Ferie a ore (non a giorni) e residui degli anni prima automatici: non ancora.
