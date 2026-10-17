# Il modello della chat da Telegram e WhatsApp

Con [ADR 0036](0036-modello-per-chat.md) ogni chat della console ha il suo modello, scelto dalla pillola nel box di scrittura. Il motore lo sa fare per ogni canale, ma su Telegram e WhatsApp non c'era modo di chiederlo: lì le chat restavano sul modello dell'istanza.

## Decisione

- **Un comando, `/modello`.** Su Telegram e WhatsApp chi parla con l'istanza scrive:
  - `/modello`: quale modello usa la chat e i provider fra cui scegliere;
  - `/modello <nome>`: cerca fra i modelli che la chat può usare. Un provider da solo (`/modello google`) dà il suo modello suggerito; `<provider> <id>` o l'id esatto scelgono quel modello; altrimenti ogni parola deve stare nel nome o nell'id. Se i modelli trovati sono più di uno, la risposta li elenca con il comando esatto per ognuno;
  - `/modello istanza`: la chat torna al modello dell'istanza.

  Vale anche `/model`, e `/modello@NomeBot` nei gruppi di Telegram. La scelta è della chat: in un gruppo vale per tutti.
- **Le stesse regole della console.** Il catalogo di cosa una persona può scegliere esce dal server web e va nel core (`src/core/chat-models.ts`, `ChatModels`): la console e il comando lo usano tutti e due. Da un canale si sceglie come un membro: solo fra i provider che l'owner ha permesso e che hanno una chiave. Telegram e WhatsApp non dicono chi è l'owner, quindi da lì non si allarga mai quello che l'istanza raggiunge.
- **Il comando non arriva al modello.** Il gateway lo riconosce prima di consegnare il messaggio e risponde da sé, attraverso l'outbox come ogni altro messaggio (`sendMessage`, con una chiave legata al canale e al messaggio: un messaggio ricevuto due volte ha una sola risposta). La scelta invece si ripete: dà lo stesso risultato, con una riga in più nell'audit. Solo per chi l'istanza ascolta su quel canale: il comando di uno sconosciuto prosegue verso il core, che lo rifiuta e lo scrive nell'audit (`user.denied`), come ogni suo messaggio.
- **Audit.** Ogni scelta è `chat.model.updated`, con `by` uguale a canale e utente (`telegram:123`).
- **`connectChannel` prende un oggetto per gli extra** (`onAction`, `voice`, `models`), invece di argomenti in fila: il comando si accende solo dove serve, su Telegram e WhatsApp. La console ha la pillola; il telefono no.

## Alternative scartate

- **Un tool per il modello.** Annie avrebbe cambiato modello da sola, su richiesta in linguaggio naturale. Ma la scelta costa soldi e passa da un permesso dell'owner: deve farla la persona, in modo prevedibile, senza che un modello la interpreti.
- **I bottoni di Telegram.** Un bottone per modello non ci sta (una riga sola, 64 byte di dati) e WhatsApp ne ammette al massimo tre. Il testo funziona ovunque: la risposta dà il comando esatto da copiare.

## Conseguenze

- Su Telegram il comando è nel menu accanto al box di scrittura: il bot lo registra all'avvio (`setMyCommands`). Se Telegram rifiuta, il bot parte lo stesso e il comando funziona, solo senza menu. WhatsApp non ha un menu dei comandi.
- Un messaggio che comincia con `/modello` non arriva più al modello su Telegram e WhatsApp.
