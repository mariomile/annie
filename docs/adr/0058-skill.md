# Skill: procedure salvate e comandi slash

Le persone che usano un agente gli spiegano spesso lo stesso modo di lavorare («per chiudere il mese guarda prima le fatture scadute, poi le spese, poi scrivimi il riepilogo così»), e finora dovevano rispiegarlo ogni volta o metterlo nelle istruzioni, che sono dell'owner. Tutte le alternative open source a Grok Bot che abbiamo guardato (MausBot, Rakazo, Codync, OpenBot, [confronto](../../README.md)) hanno le skill: procedure con un nome che l'agente apre quando servono e che la persona lancia con un comando.

## Decisione

- **Una skill è di un agente**: nome, una riga che dice quando usarla, i passi in Markdown. Sta in `skills.json` accanto alla memoria dell'istanza, non nel workspace: un file scaricato dal web o arrivato in una mail non diventa una skill solo perché finisce in una cartella. Al più 40 per agente, 300 caratteri di descrizione, 20.000 di passi.
- **Il nome è il comando**: «Chiusura del mese» diventa `chiusura-del-mese`, e `/chiusura-del-mese ottobre` la lancia da console, Telegram e WhatsApp (anche `/chiusura_del_mese@NomeBot` in un gruppo Telegram). È il core a riconoscerlo, per ogni canale: i passi si aggiungono dopo le parole della persona, che restano quelle che si vedono in chat, e l'audit scrive `skill.used` con il solo nome. Un comando che non è una skill passa com'è. I nomi dei comandi di Annie (`modello`, `tool`, `start`, `skill` e pochi altri) non si possono usare.
- **L'agente sa quali ha**: in fondo alle istruzioni c'è un blocco «Skill» con come salvarne una e, per ognuna, nome e riga. I passi no: li apre con `skill_read` quando un compito corrisponde. Il blocco si rilegge a ogni messaggio, così una skill salvata vale dal messaggio dopo, anche nelle conversazioni già aperte, senza riaprire l'agente. Per questo `instructions` del motore può essere una funzione (`EngineOpenOptions`).
- **Si salvano dalla chat**, con `skill_save`, solo quando la persona lo chiede e solo in una conversazione con lei sola: in un gruppo, da un altro agente o da un task programmato nessuno cambia come l'agente lavora per tutti. Chi la salva ne è l'autore: solo lui la aggiorna o la cancella dalla chat (`skill_delete`); dalla console l'owner le gestisce tutte (`GET`, `PUT`, `DELETE /api/instances/:id/skills`), ogni persona le sue.
- **Formato Agent Skills**: una skill entra da un `SKILL.md` (intestazione con `name` e `description`, anche su più righe con `>`) caricato in chat o incollato in console, ed esce come `skills/<nome>/SKILL.md` nel workspace con `skill_export`, per mandarla o usarla in un'altra app.

## Alternative scartate

- **Skill come file nel workspace** (`skills/<nome>/SKILL.md`, come Claude Code e Codync): comodo da modificare, ma il workspace lo scrivono anche `web_download`, gli allegati e il terminale, e una skill sono istruzioni. Il file si può sempre importare con `skill_save`.
- **I passi di tutte le skill nelle istruzioni**: 40 skill lunghe in ogni richiesta costano e confondono; bastano nome e riga, come fanno le Agent Skills.
- **Una libreria di skill condivisa fra gli agenti** (la «organization library» di MausBot): per ora ogni agente ha le sue, come la memoria. Si può aggiungere dopo, con l'export e l'import che ci sono già.

## Da fare

- Pagina «Skill» nella console (elenco, nuova, modifica, importa un SKILL.md) sulle API di questo ADR.
- I comandi delle skill nel menu di Telegram accanto a `/modello`.
