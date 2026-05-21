import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyThemeMode, getThemeMode } from "./store/theme";
import "./styles/theme.css";
import "./App.css";

// Apply the persisted theme before the first paint so there is no flash of
// the wrong color scheme. App.tsx keeps it in sync afterwards.
applyThemeMode(getThemeMode());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
