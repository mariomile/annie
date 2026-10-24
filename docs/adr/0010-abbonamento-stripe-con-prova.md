# Fase 4: abbonamento Stripe con prezzo fisso e consumo, dopo una prova

Owni Cloud deve incassare prima di aprirsi a tutti. Abbiamo deciso che ogni tenant parte con un **periodo di prova** (14 giorni di default) e poi serve un **abbonamento** Stripe. L'abbonamento ha un prezzo mensile fisso e, se l'operatore lo vuole, un secondo prezzo sul costo del modello. Finita la prova senza abbonamento, la cella resta spenta: i dati restano, ma nessuna richiesta la raggiunge finché il tenant non si abbona.

Perché: il prezzo non è ancora deciso, e così resta una decisione da prendere su Stripe senza toccare il codice. Il prezzo fisso, il prezzo per unità di consumo, la valuta, l'IVA, i coupon e la durata della prova sono tutti configurazione. Con il consumo a contatore il ricarico sul modello è un numero sul prezzo Stripe: un'unità è un centesimo di dollaro di costo del modello a prezzi di listino. Come ci si abbona e come si gestisce la carta lo decide Stripe (Checkout e portale clienti), quindi nessun dato di pagamento passa dal control plane.

## Alternative scartate

- **Solo consumo, senza fisso**: il volume della cella costa anche da spenta (ADR 0007), e un tenant che non usa Owni non lo coprirebbe.
- **Pagamento prima di provare**: il target (professionisti e piccoli team) vuole vedere Owni al lavoro sui suoi strumenti prima di pagare.
- **Fatture e carte gestite da noi**: più codice e più obblighi PCI e fiscali, per niente che Stripe non faccia già.
- **Sospendere cancellando la cella**: chi torna dopo la prova ritroverebbe un Owni vuota. La cancellazione resta una scelta esplicita, da fare a mano.

## Conseguenze

- Per abbonarsi o gestire l'abbonamento si entra con il link via email, lo stesso dell'accesso: niente password e niente sessioni nuove sul control plane. Gestire l'abbonamento non sveglia la cella.
- Chi si abbona durante la prova tiene i giorni che restano: Stripe addebita alla fine della prova (se mancano almeno 48 ore, come Stripe chiede). Un nuovo link di pagamento fa scadere il precedente, così nessuno paga due volte da due schede.
- Il control plane conserva solo gli id di cliente e abbonamento, lo stato e i centesimi già inviati a Stripe per mese. Gli eventi arrivano firmati (HMAC, al massimo 5 minuti di età). L'evento dice solo quale abbonamento è cambiato: lo stato si chiede ogni volta a Stripe, quindi eventi in ritardo o fuori ordine non lasciano uno stato sbagliato. Un secondo abbonamento dello stesso tenant non scavalca mai quello vivo e finisce nel log per l'operatore.
- Il consumo inviato è quello successivo all'abbonamento: quando il tenant ha per la prima volta un cliente Stripe, i mesi letti fino a quel momento contano come già inviati, in qualunque ordine arrivino gli eventi. Una spesa fatta durante la prova ma letta dopo finisce nel primo periodo pagato. È una stima per eccesso di poco, perché le celle si leggono quando si spengono e almeno una volta l'ora.
- Ogni invio porta un identificativo (tenant, mese, totale): un nuovo tentativo non conta due volte. Il consumo si data al momento dell'invio, così cade sempre nel periodo di fatturazione aperto e mai in uno già fatturato. Un invio fallito si ritenta dopo 5 minuti.
- Stato «pagamento in ritardo»: Owni continua a funzionare mentre Stripe ritenta il pagamento. Su Stripe va impostato che dopo l'ultimo tentativo l'abbonamento si annulli, altrimenti il ritardo dura per sempre. Con «annullato» o «non pagato» la cella si sospende subito, anche dentro la prova, e una cella accesa si ferma al giro successivo del control plane.
- La cella risponde solo alle richieste passate dal control plane: ognuna porta un'intestazione derivata dal segreto della cella. Su una piattaforma con un indirizzo pubblico per cella (Railway) una richiesta diretta riceve 404. Può comunque svegliare il servizio, che allora esegue i task in scadenza finché la piattaforma non lo rimette a dormire.
- Tenant e prova: chi esisteva prima che la fatturazione fosse attiva ha la prova a partire da quel giorno. Se la fatturazione si spegne e poi si riaccende, la prova riparte per tutti da quel giorno.
- A Stripe vanno email, indirizzo di fatturazione e partita IVA del tenant, mai contenuti. Stripe va indicato tra i responsabili del trattamento nell'informativa.
- Senza chiave Stripe Owni Cloud resta gratuito, come prima: self-host e sviluppo non cambiano.
