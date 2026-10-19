# App desktop

Annie come app per Mac, Windows e Linux: una finestra sul tuo server Annie, l'icona nella barra e una scorciatoia per chiamarla da qualsiasi app. Perché e come è fatta: [ADR 0034](adr/0034-app-desktop.md).

## Annie sul Mac

L'app per Mac porta Annie con sé ([ADR 0096](adr/0096-annie-dentro-l-app-per-mac.md)): al primo avvio la accende su questo computer ed entra da sola. In «Primi passi» scegli il modello AI e incolli la chiave. I dati restano in `~/Library/Application Support/app.annie.desktop/data`; se qualcosa non parte, il registro è in `~/Library/Logs/app.annie.desktop/server.log`.

L'app non è ancora firmata. La prima volta: trascina Annie in Applicazioni, poi tasto destro sull'icona, **Apri**, e ancora **Apri**. Se macOS non mostra il pulsante, vai in Impostazioni di Sistema, Privacy e sicurezza, e premi **Apri comunque** accanto ad Annie.

## Usarla

1. Su Windows e Linux, al primo avvio scrivi l'indirizzo del tuo Annie (per esempio `annie.tuaazienda.it`), oppure incolla il tuo link personale per entrare subito. Sul Mac lo fai da «Cambia server…», se vuoi usare un server invece di Annie sul computer.
2. **Ctrl+Shift+Spazio** (⌘⇧Spazio sul Mac) la apre e la nasconde da qualsiasi app. Su Linux con Wayland le scorciatoie globali non arrivano alle app: lì si usa l'icona nella barra.
3. Chiudere la finestra la nasconde: Annie resta nella barra. Dall'icona: Apri Annie, Nuova chat, Cambia server, Esci. Sul Mac la riapre anche l'icona nel Dock.
4. I link che portano fuori da Annie si aprono nel browser. Una pagina di Annie aperta "in una nuova scheda" (un file, un documento) si apre in una seconda finestra dell'app.
5. I file scaricati vanno nella cartella Download, con un numero in fondo al nome se ce n'è già uno uguale.

## Svilupparla

Servono Rust (stable) e, su Linux, le librerie di WebKitGTK:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
```

```bash
pnpm start                        # un Annie locale, per esempio con ANNIE_MODEL_PROVIDER=faux
cd desktop && pnpm install
pnpm dev                          # l'app; al primo avvio: localhost:8080 o il link di data/owner-login-link.txt
pnpm build                        # l'installer di questo sistema in src-tauri/target/release/bundle
cd src-tauri && cargo test        # i test di indirizzi, navigazione e impostazioni
```

La pagina di collegamento è in `desktop/connect/` (HTML, CSS e JS senza build, come la console). Il codice Rust è in `desktop/src-tauri/src/`:

- `server.rs`: legge l'indirizzo, decide cosa resta nella finestra, controlla `/healthz`;
- `settings.rs`: il file con l'indirizzo del server;
- `local.rs`: Annie su questo computer (avvio, attesa, accesso dell'owner, arresto);
- `lib.rs`: finestra, icona, scorciatoia, comandi.

Le icone vengono da `src/web/ui/icon-512.png`: `pnpm icons` le rigenera.

## Installer

Il workflow **Desktop app** (a mano da GitHub Actions, o con un tag `desktop-v0.2.0`) costruisce gli installer per Mac (universale), Windows e Linux e li mette in una bozza di release. Per il Mac prima `desktop/scripts/bundle-server.sh` prepara Node e il server compilato, e controlla che partano; `--config src-tauri/tauri.local.conf.json` li mette nell'app.

### Firma

Per ora gli installer non sono firmati. Per firmarli si mettono nei segreti del repository e si passano come env al passo `tauri-action` del workflow: per il Mac `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` (account Apple Developer, 99 dollari l'anno); per Windows un certificato di firma del codice. Con la firma si accendono gli aggiornamenti automatici.
