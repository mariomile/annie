# Fase 4: abbonamento Stripe con prezzo fisso e consumo, dopo una prova

Annie Cloud deve incassare prima di aprirsi a tutti. Abbiamo deciso che ogni tenant parte con un **periodo di prova** (14 giorni di default) e poi serve un **abbonamento** Stripe. L'abbonamento ha un prezzo mensile fisso e, se l'operatore lo vuole, un secondo prezzo sul costo del modello. Finita la prova senza abbonamento, la cella resta spenta: i dati restano, ma nessuna richiesta la raggiunge finché il tenant non si abbona.

Perché: il prezzo non è ancora deciso, e così resta una decisione da prendere su Stripe senza toccare il codice. Il prezzo fisso, il prezzo per unità di consumo, la valuta, l'IVA, i coupon e la durata della prova sono tutti configurazione. Con il consumo a contatore il ricarico sul modello è un numero sul prezzo Stripe: un'unità è un centesimo di dollaro di costo del modello a prezzi di listino. Come ci si abbona e come si gestisce la carta lo decide Stripe (Checkout e portale clienti), quindi nessun dato di pagamento passa dal control plane.

## Alternative scartate

- **Solo consumo, senza fisso**: il volume della cella costa anche da spenta (ADR 0007), e un tenant che non usa Annie non lo coprirebbe.
- **Pagamento prima di provare**: il target (professionisti e piccoli team) vuole vedere Annie al lavoro sui suoi strumenti prima di pagare.
- **Fatture e carte gestite da noi**: più codice e più obblighi PCI e fiscali, per niente che Stripe non faccia già.
- **Sospendere cancellando la cella**: chi torna dopo la prova ritroverebbe un'Annie vuota. La cancellazione resta una scelta esplicita, da fare a mano.

## Conseguenze

- Per abbonarsi o gestire l'abbonamento si entra con il link via email, lo stesso dell'accesso: niente password e niente sessioni nuove sul control plane.
- Il control plane conserva solo gli id di cliente e abbonamento, lo stato e i centesimi già inviati a Stripe per mese. Gli eventi arrivano firmati (HMAC, al massimo 5 minuti di età) e un evento più vecchio di quello già applicato non cambia niente.
- Il consumo inviato è quello successivo all'abbonamento: alla conferma del checkout i mesi letti fino a quel momento contano come già inviati. Una spesa fatta durante la prova ma letta dopo la conferma finisce nel primo mese pagato. È una stima per eccesso di poco, perché le celle si leggono quando si spengono e almeno una volta l'ora.
- Ogni invio porta un identificativo (tenant, mese, totale): un nuovo tentativo non conta due volte. Il costo di un mese chiuso si data a quel mese, entro i 35 giorni che Stripe accetta.
- Stato «pagamento in ritardo»: Annie continua a funzionare mentre Stripe ritenta il pagamento. Con «annullato» o «non pagato» la cella si sospende come a fine prova.
- I tenant che esistevano prima che la fatturazione fosse attiva hanno la prova a partire da quel giorno, non dalla loro registrazione.
- Senza chiave Stripe Annie Cloud resta gratuito, come prima: self-host e sviluppo non cambiano.
