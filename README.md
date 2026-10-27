# Harvey's Logbook

A logbook for time, tasks and deadlines across projects: log work, plan the day around Google Calendar, and forecast when each project will finish. It runs entirely in the browser, on a laptop or a phone, and keeps working offline.

- **Your data is not in this repository.** It lives in each browser's own storage and syncs between devices through a hidden app folder in the owner's Google Drive that only this app can open.
- **Google sign-in** uses the client ID in `config.js`. A client ID is public by design: Google only accepts it from this site's address. The app asks for three things: Calendar events, the list of calendars (read only), and its own Drive app folder.
- **Analyze** can ask an AI model running on the owner's own computer (Ollama at `http://localhost:11434`), only when its button is pressed, and only about the one task on screen. Nothing goes to any other AI service. The page's Content Security Policy only lets it reach Google, this computer and Tailscale (`*.ts.net`) addresses.
- **Install it**: open the site in Chrome or Edge, then use the browser menu's "Install" (laptop) or "Add to Home screen" (Android).

These files are built by `standalone/build.js` from the Logbook source. Change the source and rebuild rather than editing them here; `config.js` is the one file meant for hand edits.
