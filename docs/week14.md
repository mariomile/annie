# Settimana 14: Annie capisce i vocali

Branch `week-14`. Fase 4 del [piano](piano-cloud.md) (voce, primo passo).

## Cosa funziona (verificato dai test, con un finto servizio di trascrizione)

- **Vocali di Telegram e WhatsApp** (`test/voice.test.ts`): il vocale di una persona che può scrivere viene scaricato, mandato al servizio di trascrizione e arriva ad Annie come testo, «[Messaggio vocale, trascritto] …». Su Telegram valgono anche i file audio.
- **Servizio scelto dall'operatore**: qualunque servizio con l'API di trascrizione di OpenAI. Il consigliato è Mistral (Voxtral, server in UE), che è anche il modello predefinito quando l'indirizzo è il suo. Senza configurazione Annie riceve una nota e chiede di scrivere.
- **Privacy**: il vocale di un estraneo non viene scaricato né trascritto; l'audio va solo al servizio configurato; la chiave non compare nei log.
- **Limiti**: oltre `ANNIE_TRANSCRIBE_MAX_SECONDS` (300 di default) o 25 MB il vocale non parte. Un servizio che fallisce o non riconosce parole produce una nota chiara, mai testo inventato.
- **`pnpm annie check`** controlla chiave e modello del servizio.
- **Annie Cloud**: le variabili del control plane passano a tutte le celle.

## Limiti

| Cosa | Limite |
|---|---|
| Prova dal vivo | solo contro un finto servizio: serve una chiave Mistral (docs/chiavi.md, punto 10) |
| Costo | la trascrizione non entra nel tetto di spesa del modello |
| Durata su WhatsApp | WhatsApp non dice quanto dura un vocale: vale solo il limite di 20 MB del download |
| Errori temporanei | se il servizio non risponde il vocale non viene ritentato: Annie chiede alla persona di riprovare |
| Chiamate vocali | non ancora: Annie risponde per iscritto |
