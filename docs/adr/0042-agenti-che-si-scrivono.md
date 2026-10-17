# Agenti che si scrivono

Mario (17 ottobre 2026): «i bot devono poter comunicare tra di loro se serve». Con più agenti (ADR 0041) ognuno ha connettori, file e memoria suoi: l'assistente di una persona non vede il CRM che ha l'agente delle vendite, il ricercatore non ha il Google di nessuno. Serve che uno possa chiedere all'altro.

## Decisione

- **Un canale, `agente`.** Ogni agente ha un canale in più, come il web o Telegram, dove gli scrivono gli altri agenti. Chi può scrivergli è la sua allowlist su quel canale (`allowedUsers.agente`, con gli ID degli agenti) e il canale deve essere nella sua egress policy: le stesse regole delle persone, controllate dal core in `submit`, con lo stesso audit (`user.denied`, `message.received`). L'owner sceglie in Impostazioni, card «Agenti che possono scrivergli»; senza nessuno spuntato il canale esce dalla policy. Le altre persone non lo vedono.
- **Due tool.** `agent_list` dice a chi l'agente può scrivere (nome, ID, compito). `agent_message {agent, message}` manda una richiesta completa: l'altro agente non vede la conversazione.
- **La risposta arriva dopo, non nel tool.** Il tool torna subito: «messaggio mandato». L'altro agente lavora in una conversazione sua, una per ogni conversazione di chi chiede, così ricorda il contesto delle domande precedenti dalla stessa chat. La sua risposta torna alla conversazione di partenza come notizia (`submitNotice`, come gli esiti delle approvazioni), e lì l'agente la riferisce con parole sue. Così un collega lento non blocca nessuno, e un riavvio a metà non perde niente: domanda e risposta passano dal motore durevole e dall'outbox come i messaggi delle persone. Un file mandato con `file_send` finisce nel workspace di chi ha chiesto, sotto `da-agenti/<agente>/`.
- **La strada di ritorno è nel thread.** La conversazione dell'agente che risponde ha come ID `<chi chiede>~<canale>~<thread>`: dice da dove viene la domanda senza tabelle da tenere. Una catena (A chiede a B, B chiede a C) si legge dall'ID stesso.
- **Niente giri, niente catene lunghe.** Un agente non scrive a se stesso né a uno che sta già aspettando una sua risposta nella stessa catena; al più tre agenti in fila. Una conversazione manda al più 10 messaggi ad altri agenti in un'ora (in memoria: un riavvio azzera il conto).
- **Chi risponde sa chi è.** Il messaggio arriva con il nome dell'agente che scrive e la nota che non è una persona; la conversazione non è privata, quindi valgono solo le memorie condivise. Le azioni che richiedono un'approvazione (moduli, azioni dei connettori) restano da approvare da una persona.
- **Dati, non istruzioni.** La risposta arriva a chi ha chiesto dentro un recinto con un'etichetta casuale: l'altro agente può aver letto pagine web o mail.

## Scartato

- **Una risposta dentro il tool, aspettando.** Un agente con una ricerca lunga terrebbe fermo l'altro per minuti, e un riavvio a metà lascerebbe una chiamata senza risposta.
- **Una chat di gruppo tra agenti.** Più difficile da controllare (chi parla, quando si ferma) e non serve per chiedere una cosa a un collega.
- **Permessi per coppia nella policy di chi chiede.** Chi riceve decide chi gli scrive, come per le persone: un agente con dati delicati resta chiuso finché l'owner non lo apre.

## Limiti

- 4000 caratteri per messaggio; al più tre agenti in fila; 10 messaggi per conversazione all'ora.
- Il conto orario è in memoria. Il limite vero contro un ciclo sono la catena e il fatto che la risposta arriva come notizia con la regola di non ripetere la domanda.
