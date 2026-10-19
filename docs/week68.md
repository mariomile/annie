# Settimana 68: conferme solo dalla persona, canoni in cassa

Branch `week-68`. Le azioni che non si annullano si confermano solo da un messaggio della persona, mai da un avviso, da un'attività programmata o da un altro agente; e i canoni delle fatture ricorrenti entrano nella previsione di cassa. Le scelte sono nell'[ADR 0088](adr/0088-conferme-solo-dalla-persona.md).

## Cosa cambia per chi usa Annie

- **«È pronta la bozza del canone di novembre»**: Annie chiede se emetterla, e la emette solo dopo il «sì» della persona. Lo stesso per abbinamenti della banca, unioni di clienti e fornitori, prezzi del listino, numerazione e disdette.
- **Un'attività programmata o un altro agente** possono preparare e mostrare, ma non confermare.
- **«Quanto avrò sul conto a fine dicembre?»**: contano anche i canoni, prima come «da preparare», poi come «bozza da emettere», poi fra le fatture da incassare, una volta sola.

## Cosa funziona (verificato dai test)

`test/turn-origin.test.ts`: origine dalla persona, da un avviso, da un'attività, dal canale agenti, da un agente in una stanza e dalla board; ripresa dopo un processo ucciso a metà strumento; giri con più ingressi e messaggi infilati a metà; avviso, risposta e poi «sì» della persona nella stessa conversazione. Per ogni conferma protetta: rifiutata da avviso, attività e agente, anteprima sempre possibile, accettata dalla persona. Le skill non partono da board, stanze o avvisi. La previsione: canoni, bozze e fatture emesse contati una volta anche dopo una bozza riscritta o un canone tolto e rimesso, pausa, fine e numero di fatture, cliente privato senza ritenuta, canale agenti senza nomi e senza ricerca per cliente.

## Revisioni

Prima revisione, corretta: una bozza di canone spariva dalla previsione fino all'emissione; la previsione mostrava nomi di clienti e fornitori agli altri agenti (c'era già prima); la data di pagamento del periodo in corso; la frase di rifiuto che sembrava un errore e chiedeva a un agente di chiedere alla persona; skill avviate da testi che non erano della persona; codice di approvazione mai usato; l'origine letta solo dall'ultimo ingresso; fatture ricorrenti, numerazione e disdette senza conferma della persona; ritenuta tolta anche ai privati.

Verifica finale, corretta: un altro agente poteva chiedere un'ipotesi su un cliente per nome e sapere quanto doveva.
