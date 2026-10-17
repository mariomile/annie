# App desktop

Annie come app per Mac, Windows e Linux: una finestra sul tuo server Annie, l'icona nella barra e una scorciatoia per chiamarla da qualsiasi app. Perché e come è fatta: [ADR 0034](adr/0034-app-desktop.md).

## Usarla

1. Al primo avvio scrivi l'indirizzo del tuo Annie (per esempio `annie.tuaazienda.it`), oppure incolla il tuo link personale per entrare subito.
2. **Ctrl+Shift+Spazio** (⌘⇧Spazio sul Mac) la apre e la nasconde da qualsiasi app.
3. Chiudere la finestra la nasconde: Annie resta nella barra. Dall'icona: Apri Annie, Nuova chat, Cambia server, Esci.
4. I link che portano fuori da Annie si aprono nel browser.

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
- `lib.rs`: finestra, icona, scorciatoia, comandi.

Le icone vengono da `src/web/ui/icon-512.png`: `pnpm icons` le rigenera.

## Installer

Il workflow **Desktop app** (a mano da GitHub Actions, o con un tag `desktop-v0.1.0`) costruisce gli installer per Mac (universale), Windows e Linux e li mette in una bozza di release.

### Firma

Per ora gli installer non sono firmati. Per firmarli si mettono nei segreti del repository e si passano come env al passo `tauri-action` del workflow: per il Mac `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` (account Apple Developer, 99 dollari l'anno); per Windows un certificato di firma del codice. Con la firma si accendono gli aggiornamenti automatici.
