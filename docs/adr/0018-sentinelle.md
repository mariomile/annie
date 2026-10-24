# Le sentinelle: pagine controllate da Owni, che scrive solo quando c'è qualcosa

Una persona chiede «avvisami quando questo scende sotto 50 €» o «dimmi quando escono i risultati». Un task programmato farebbe lavorare il modello a ogni giro, anche quando non è cambiato niente, e scriverebbe ogni volta. Una sentinella legge la pagina con il codice e sveglia il modello solo quando c'è qualcosa da dire.

## Come funziona

- **Cosa guarda**: tutta la pagina, le poche parole dopo una frase («Disponibilità», il nome del prodotto), o il prezzo subito dopo una frase con una soglia sotto e/o sopra. Per il prezzo la frase è obbligatoria: il primo prezzo di una pagina intera è quasi sempre un banner o la spedizione.
- **Quando scrive**: tutta la pagina, solo se appare cambiata nello stesso modo per due controlli di fila (un banner che ruota o un contatore non lo sono mai), dopo aver tolto orari, date e contatori; la frase, quando cambia quello che la segue o quando sparisce; il prezzo, quando passa la soglia (una volta, con un margine dell'1% prima di riarmarsi), quando non si vede più (esaurito) e quando torna.
- **Dove scrive**: nella conversazione dove è nata, per la persona di quella conversazione, con lo stesso controllo dei task: se quella persona non può più scrivere a Owni, o il canale non è più consentito, la sentinella si ferma senza scrivere. Non nei gruppi (non c'è una persona per cui lavorare) e non al telefono (Owni non chiama per prima).
- **Cosa legge**: lo stesso fetch controllato di `web_read`, dai siti consentiti dell'istanza riletti a ogni controllo, mai indirizzi interni; 10 secondi e 3 redirect al più. I testi d'errore sono frasi fisse: quello che un sito manda (un host di redirect) non arriva al modello fuori dalla recinzione dei dati dal web.
- **Una volta sola**: il messaggio è salvato sulla sentinella prima di partire, con un ID fatto di sentinella e numero d'ordine. Dopo un crash, o se l'istanza non lo prende, riparte lo stesso messaggio (tra 5 minuti, senza rileggere la pagina), e il nucleo lo ammette una volta.
- **Freni**: al più 20 sentinelle per istanza, una ogni 30 minuti al più spesso; 20 pagine per passaggio, 4 alla volta, un minuto per passaggio; dopo 6 controlli falliti di fila si ferma e lo dice una volta; dopo 8 messaggi in 24 ore si ferma («la pagina cambia troppo spesso») e suggerisce una frase. Dalla console si riattiva.
- **Chi la vede**: in chat ogni persona vede e cancella solo le sue; nella console l'owner le vede tutte. Nell'audit `watch.created`, `watch.deleted` e `watch.fired` con ID e sito, mai il testo della pagina.

## Alternative scartate

- **Un task programmato che rilegge la pagina**: il modello girerebbe a ogni controllo, e deciderebbe lui se c'è una novità. Costoso, e una pagina potrebbe convincerlo che c'è sempre.
- **Un diff della pagina intera mostrato al modello**: troppi falsi allarmi su pagine vive; il confronto per frase o per prezzo è più vicino a quello che la persona chiede.
- **Il browser con clic per ogni controllo**: più pesante e più lento; per le pagine costruite in JavaScript resta `web_browse` in chat. Da rivedere se le persone lo chiedono.
- **Limitare i tool nel turno che nasce da una sentinella** (come nel brief): il turno legge testo di una pagina, come `web_read` in qualsiasi conversazione, e gli strumenti che inviano chiedono già un'approvazione. Da rivedere se si vede un abuso.

## Conseguenze

- Le pagine costruite solo in JavaScript non si leggono: la prima lettura lo dice subito, perché la frase non si trova.
- Su WhatsApp un avviso fuori dalla finestra di 24 ore può restare in attesa finché la persona non scrive: Owni lo dice quando crea la sentinella.
- Il prezzo si legge con regole semplici (cifre, separatori, valuta): un prezzo scritto in modo strano dopo la frase può non essere letto, e la prima lettura lo mostra perché la persona controlli.
