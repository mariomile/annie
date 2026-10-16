# Settimane 11 e 12: la spesa per tenant e l'abbonamento

Branch `week-11` (PR #11, su `main`) e `week-12`. Decisione: [ADR 0010](adr/0010-abbonamento-stripe-con-prova.md). Fase 4 del [piano](piano-cloud.md).

## Settimana 11: `pnpm cloud status`

- Per ogni tenant: email, data di registrazione, stato della cella, prossimo risveglio e spesa stimata sul modello di oggi, del mese e del mese scorso, in ora di Roma (`test/cloud.test.ts`).
- Le celle accese vengono interrogate. Per quelle che dormono si mostra l'ultima lettura, senza svegliarle.
- Il control plane conserva la spesa di ogni mese, anche di quelli chiusi: un mese finito si può ancora fatturare. Le letture si uniscono (vince il giorno più recente, un mese può solo crescere).
- Con Railway il comando, lanciato da un altro processo, non fa più risultare spente le celle sveglie.

## Settimana 12: l'abbonamento (verificato dai test, con un finto Stripe)

- **Prova, poi abbonamento**: alla registrazione parte la prova (`ANNIE_CLOUD_TRIAL_DAYS`, 14 giorni di default). Finita senza abbonamento, la cella resta spenta. Una pagina rimanda a quella di registrazione («Annie è in pausa»), un'API risponde 402, i webhook di Telegram non la svegliano e nemmeno i task programmati. I dati restano.
- **Abbonarsi e gestire**: con lo stesso link via email dell'accesso. Chi ha finito la prova riceve il link a Checkout di Stripe. «Gestisci l'abbonamento» porta a Checkout o al portale clienti (fatture, carta, disdetta). La carta la vede solo Stripe.
- **Webhook firmati** (`/stripe/webhook`): firma HMAC-SHA256 di Stripe, al massimo 5 minuti di età. Una firma sbagliata o mancante risponde 400 e non cambia niente. Un evento più vecchio di quello già applicato viene ignorato. «Pagamento in ritardo» lascia Annie accesa, «annullato» la sospende.
- **Consumo a contatore** (facoltativo): il costo del modello di ogni tenant abbonato va a un Billing Meter di Stripe in centesimi di dollaro, mese per mese, solo quello successivo all'abbonamento. Ogni invio ha un identificativo, quindi un nuovo tentativo non conta due volte. Le celle accese si leggono almeno una volta l'ora.
- **Prezzo come configurazione**: quota fissa, prezzo per unità di consumo, valuta, IVA e coupon si impostano su Stripe, senza toccare il codice.
- **`pnpm cloud status`** mostra anche lo stato: in prova fino a quando, abbonato, pagamento in ritardo, sospeso.
- Senza `ANNIE_CLOUD_STRIPE_SECRET_KEY` non cambia niente: Annie Cloud resta gratuito.

## Limiti

| Cosa | Limite |
|---|---|
| Prova dal vivo | fatta solo contro un finto Stripe: serve un giro in modalità test con le chiavi `sk_test_…` (docs/chiavi.md, punto 8) |
| Cifre | prezzo e durata della prova sono una decisione di Mario |
| Consumo durante la prova | la spesa fatta in prova ma letta dopo la conferma del checkout finisce nel primo mese pagato |
| Fatturazione elettronica italiana | Stripe emette le fatture, ma da verificare se le trasmette da solo allo SdI; altrimenti serve un servizio collegato |
| Cancellazione dei dati | un tenant sospeso tiene la sua cella spenta; cancellarla resta un'operazione manuale |
