# Interfaccia web servita dal processo di Annie, senza build

L'interfaccia web è un canale e una console servita dallo stesso processo con `node:http`: HTML, CSS e moduli JavaScript statici, nessun framework e nessun passo di build. Annie si installa on-prem presso PMI: un solo processo, nessuna toolchain frontend da mantenere, niente CDN esterne (l'egress default deny vale anche per il browser dell'utente). L'autenticazione usa token per persona creati dall'owner da riga di comando e scambiati con un cookie di sessione `HttpOnly`.
