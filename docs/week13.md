# Settimana 13: Annie su WhatsApp

Branch `week-13`. Fase 4 del [piano](piano-cloud.md).

## Cosa funziona (verificato dai test, con un finto Graph API di Meta)

- **Un numero WhatsApp Business per istanza** (`test/whatsapp.test.ts`): l'owner lo collega in Impostazioni → WhatsApp con token di accesso, ID del numero e app secret. Meta controlla token e numero prima che cambi qualcosa. Token e app secret restano nel registro dei segreti e non tornano mai alla console.
- **Webhook** `/hooks/whatsapp/<istanza>`: risponde alla verifica di Meta solo con il nostro token, e accetta solo consegne firmate con l'app secret (HMAC-SHA256 sul corpo grezzo). La console mostra indirizzo e token di verifica da incollare nell'app Meta.
- **Messaggi**: testo e documenti con didascalia (scaricati solo per chi può scrivere, al massimo 20 MB, con il token mandato solo agli host di Meta). Note vocali, foto e sticker per ora vengono ignorati. Ogni chat è una persona sola, quindi la sua memoria vale.
- **Chi può scrivere**: numeri con prefisso internazionale; gli altri non ricevono risposta. Una consegna ripetuta da Meta non produce una seconda risposta.
- **Risposte**: testi lunghi in più messaggi da 4096 caratteri, file come documenti, possibile doppione segnalato come su Telegram.
- **Schede di approvazione** anche su WhatsApp, con i pulsanti Approva e Rifiuta (lo stesso codice di Telegram, per entrambi i canali).
- **Finestra di 24 ore**: fuori finestra Meta rifiuta i messaggi liberi, e l'errore lo dice («fuori dalla finestra di 24 ore»), senza nuovi tentativi.
- **Task programmati** in una chat WhatsApp agiscono per conto di quella persona.

## Limiti

| Cosa | Limite |
|---|---|
| Prova dal vivo | solo contro un finto Graph API: serve un'app Meta con numero di test (docs/chiavi.md, punto 9) |
| Messaggi oltre le 24 ore | brief e promemoria arrivano solo se la persona ha scritto nelle ultime 24 ore; per gli altri servono i template approvati da Meta |
| Voce, immagini | ignorate: arriveranno con la voce |
| Gruppi | la Cloud API lavora con chat individuali |
| Costi | Meta fa pagare le conversazioni secondo il suo listino, a parte dall'abbonamento ad Annie |
