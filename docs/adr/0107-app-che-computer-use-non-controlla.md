# 0107: App che Computer Use non controlla

Il componente nativo di Computer Use ([desktop.md](../desktop.md)) manda clic, testo, tasti, scorrimenti e trascinamenti a qualsiasi app in primo piano, e manda al modello l'intero schermo. Con un terminale davanti, il modello poteva scrivere comandi che aggirano il computer isolato di Annie (`computer_run`, [ADR 0002](0002-tool-proposti-sandbox-e-approvazione.md)) e le sue approvazioni. Con un gestore di password o una richiesta di password di macOS davanti, vedeva e poteva digitare segreti.

## Decisione

- Prima di ogni foto dello schermo e di ogni azione, il componente guarda l'app in primo piano. Se è in un elenco fisso di identificatori di bundle, non fa niente e risponde con un errore che dice il nome dell'app e cos'è: «Computer Use non controlla «Terminal», che è un terminale: non ho fatto nulla. Se serve, deve usarla la persona». Il messaggio arriva al modello così com'è, senza passare dal log dell'operatore.
- Aprire un'app dell'elenco con `desktop_open` è rifiutato allo stesso modo. Aprire un'altra app resta possibile anche con un'app bloccata davanti, così l'agente può allontanarsene. Durante una scrittura lunga il controllo si ripete a ogni gruppo di caratteri.
- L'elenco è nel codice (`desktop/native/computer-use.swift`), non una impostazione: terminali (Terminal, iTerm2, Warp, Ghostty, kitty, Alacritty, WezTerm), gestori di password (1Password 7 e 8, Bitwarden, Dashlane, Password di Apple, Accesso Portachiavi) e le richieste di password di macOS (`SecurityAgent`, `LocalAuthentication.UIAgent`). Gli identificatori sono stati controllati sull'`Info.plist` delle app o sul loro codice sorgente; quelli non verificabili (LastPass) non ci sono.

## Limiti voluti

- Non è un confine di sicurezza completo: l'agente può ancora usare altre app che eseguono comandi (editor con terminale integrato, Script Editor, Comandi rapidi). L'elenco chiude le strade più dirette; aggiungerne altre è una riga.
- Il controllo guarda l'app in primo piano nel momento dell'azione. Un'app bloccata che compare a metà di un trascinamento non lo interrompe.
- Un'app senza identificatore di bundle non è bloccata.
