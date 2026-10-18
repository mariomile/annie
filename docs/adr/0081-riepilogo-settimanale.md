# Il riepilogo settimanale della board

La board avvisa quando una scheda va rivista ([ADR 0051](0051-board-trascinare-e-avvisi.md)) o scade ([ADR 0074](0074-avviso-scadenze.md)), una scheda alla volta. Manca il colpo d'occhio: quante cose si sono chiuse, quante sono ferme, cosa è in ritardo. Per saperlo l'owner deve aprire la console e contare.

## Decisione

- **Il lunedì dalle 9 (ora di Roma) l'owner riceve la board in poche righe**, nella chat con l'agente principale su Telegram o WhatsApp, come gli avvisi delle schede da rivedere: quante schede si sono chiuse negli ultimi 7 giorni, quante sono aperte per colonna, quali sono in ritardo e quali aspettano una revisione (al più 5 per elenco, poi «e altre N»), con l'agente di ciascuna.
- **Una volta a settimana**: il giro del pianificatore prende la settimana nel file della board (`digest`), quindi due giri o un riavvio non lo mandano due volte. Se Annie era spenta il lunedì, aspetta il lunedì dopo: un riepilogo arrivato il giovedì non serve più a pianificare la settimana.
- **Niente messaggio se la board non ha avuto nulla**: nessuna scheda aperta e nessuna chiusa nella settimana.
- **Solo numeri e titoli**: niente commenti né descrizioni, che restano nella console.

## Alternative scartate

- **Un riepilogo ogni mattina**: diventa rumore, e le scadenze del giorno hanno già il loro avviso.
- **Farlo scrivere all'agente principale con un'attività programmata**: costa una chiamata al modello ogni settimana per dire cose che sono già numeri, e il testo cambierebbe ogni volta.
