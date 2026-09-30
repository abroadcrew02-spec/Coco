import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyThemeMode, getThemeMode } from "./store/theme";
import { setScriptTrustPersistence } from "./store/scriptTrust";
import { createTauriTrustPersistence } from "./store/scriptTrustPersistence";
import "./styles/theme.css";
import "./App.css";

// Apply the persisted theme before the first paint so there is no flash of
// the wrong color scheme. App.tsx keeps it in sync afterwards.
applyThemeMode(getThemeMode());

// #355: "always trust" records go to the app database through the dedicated
// script_trust_* commands. Installed before the first render so no editor
// evaluates a workbook against the in-memory default. Tests render <App />
// without this file and keep the in-memory backend.
setScriptTrustPersistence(createTauriTrustPersistence());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
